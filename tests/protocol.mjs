import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { MitmBroker } from '../packages/agy-cli/mitm/broker.mjs'
import { WireStore, WireTurn, projectCc } from '../packages/agy-cli/mitm/protocol.mjs'
import { AGY_IDENTITY, AGY_NATIVE_SECURITY, KNOWN_REFUSED_SYSTEM_HASHES, systemFingerprint, assertForwardableSystem, assertSupportedClient } from '../packages/agy-cli/mitm/system-policy.mjs'
import { createCcServer } from '../packages/agy-cli/cc-http.mjs'

test('client identity is required in system instructions before forwarding', async () => {
  const cc="You are Claude Code, Anthropic's official CLI for Claude."
  const dsh='You are an AI agent powered by DeepSeek Harness.'
  assert.doesNotThrow(()=>assertSupportedClient({system:[{type:'text',text:cc}]}))
  assert.doesNotThrow(()=>assertSupportedClient({system:"You are a Claude agent, built on Anthropic's Claude Agent SDK."}))
  assert.doesNotThrow(()=>assertSupportedClient({messages:[{role:'system',content:dsh}]}))
  assert.doesNotThrow(()=>assertSupportedClient({system:'Custom DSH agent'},'deepseek-harness/1.0.0 (+https://example.test)'))
  assert.throws(()=>assertSupportedClient({system:'Custom agent'},'unrelated/1.0'),/Unsupported client identity/)
  assert.throws(()=>assertSupportedClient({system:'You are another assistant.',messages:[{role:'user',content:cc}]}),/Unsupported client identity/)
  let forwarded=0
  const broker=new MitmBroker({token:'control',drive:async()=>{forwarded++}})
  const response=await broker.fetch('/v1/messages',{body:JSON.stringify({model:'fixture',system:'You are another assistant.',messages:[{role:'user',content:'hello'}]})})
  assert.equal(response.status,400);assert.equal(forwarded,0)
})

test('DSH system identity is replaced without changing surrounding instructions or user text', () => {
  const identity = 'You are an AI agent powered by DeepSeek Harness.'
  const request = {model:'fixture', system:`${identity}\nKeep the configured tools.`, messages:[{role:'user',content:identity}]}
  const projected = projectCc(request, new WireStore())
  assert.equal(projected.systemInstruction.parts[0].text, `${AGY_IDENTITY}\nKeep the configured tools.`)
  assert.equal(projected.contents[0].parts[0].text, identity)
  const other = projectCc({...request, system:`Explain: ${identity}`}, new WireStore())
  assert.equal(other.systemInstruction.parts[0].text, `Explain: ${identity}`)
})

test('recognized DSH source and web guidance is removed from system text only', () => {
  const notes = [
    'The DeepSeek Harness implementation checkout is at /example. Use this checkout only to inspect or extend DSH itself.',
    'You are interacting with the user through the DeepSeek Harness Web GUI at http://localhost. Only dsh web injects window.__DSH_BOOT__.',
    'The runtime context names the DeepSeek Harness implementation checkout. Use pwd.',
    'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. GUI instructions.'
  ]
  const user=notes.join('\n\n')
  const projected=projectCc({model:'fixture',system:`Keep before.\n\n${user}\n\nKeep after.`,messages:[{role:'user',content:user}]},new WireStore())
  const system=projected.systemInstruction.parts[0].text
  assert.match(system,/Keep before\./);assert.match(system,/Keep after\./)
  for(const note of notes) assert.ok(!system.includes(note))
  assert.equal(projected.contents[0].parts[0].text,user)
})

test('complete tool calls accept empty partialArgs but reject actual partial arguments', () => {
  const body={model:'fixture',messages:[{role:'user',content:'hello'}],tools:[{name:'get_goal',input_schema:{type:'object',properties:{}}}]}
  const turn=partialArgs=>{
    const t=new WireTurn(body,new WireStore(),()=>{})
    t.push(Buffer.from('data: '+JSON.stringify({response:{candidates:[{content:{parts:[{functionCall:{name:'get_goal',args:{},partialArgs}}]},finishReason:'STOP'}]}})+'\n\n'))
    return t
  }
  assert.deepEqual(turn([]).finish().content[0].input,{})
  assert.throws(()=>turn([{jsonPath:'$.value',stringValue:'partial'}]).finish(),/streamed tool arguments/)
})

test('default safety substitution reaches the model while user and tool text remain intact', () => {
  const paragraph = 'Synthetic security instruction.', hash = systemFingerprint(paragraph)
  const previous = process.env.AGY_CC_NATIVE_SECURITY_SWAP
  KNOWN_REFUSED_SYSTEM_HASHES.add(hash)
  try {
    delete process.env.AGY_CC_NATIVE_SECURITY_SWAP
    const request = { model:'fixture', system:`Before\n\n${paragraph}\n\nAfter`, messages:[{role:'user',content:paragraph}], tools:[{name:'Read',description:paragraph,input_schema:{type:'object'}}] }
    const projected = projectCc(request, new WireStore())
    assert.equal(projected.systemInstruction.parts[0].text, `Before\n\n${AGY_NATIVE_SECURITY}\n\nAfter`)
    const appended = projectCc({ ...request, system:`${paragraph}\nKeep this adjacent instruction.` }, new WireStore())
    assert.equal(appended.systemInstruction.parts[0].text, `${AGY_NATIVE_SECURITY}\nKeep this adjacent instruction.`)
    assert.equal(projected.contents[0].parts[0].text, paragraph)
    assert.equal(projected.tools[0].functionDeclarations[0].description, paragraph)
    assert.doesNotThrow(() => assertForwardableSystem(projected))
    process.env.AGY_CC_NATIVE_SECURITY_SWAP = '0'
    assert.throws(() => assertForwardableSystem(projectCc(request, new WireStore())), error => error.status === 422)
    assert.throws(() => assertForwardableSystem(projectCc({ ...request, system:`${paragraph}\nKeep this adjacent instruction.` }, new WireStore())), error => error.status === 422)
  } finally {
    KNOWN_REFUSED_SYSTEM_HASHES.delete(hash)
    if (previous === undefined) delete process.env.AGY_CC_NATIVE_SECURITY_SWAP
    else process.env.AGY_CC_NATIVE_SECURITY_SWAP = previous
  }
})

test('HTTP tool roundtrip retains signed upstream call and does not repeat it on retry', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-protocol-'))
  let broker, server, forwards=0
  const ctl=async(route,data)=>{
    const response=await fetch(`http://127.0.0.1:${broker.server.address().port}${route}`,{method:'POST',headers:{authorization:'Bearer control'},body:JSON.stringify(data)})
    assert.equal(response.status,200)
    return response.json()
  }
  broker=new MitmBroker({token:'control',storeDir:path.join(root,'wire'),drive:async job=>{
    forwards++
    const {payload}=await ctl('/claim',{ticket:job.ticket,envelope:{model:'fixture',request:{contents:[{role:'user',parts:[{text:job.marker}]}]}}})
    const parts=forwards===1 ? [{text:''},{thoughtSignature:'signed',functionCall:{id:'call-1',name:'Read',args:{path:'proof.txt'}}},{text:''}] : [{text:'done'}]
    if(forwards===2) {
      assert.equal(payload.request.contents.at(-1).parts[0].functionResponse.response.output,'proof')
      assert.deepEqual(payload.request.contents.at(-2).parts,[{thoughtSignature:'signed',functionCall:{id:'call-1',name:'Read',args:{path:'proof.txt'}}}])
    }
    await ctl('/event',{ticket:job.ticket,kind:'headers',status:200})
    const frame={response:{candidates:[{content:{role:'model',parts},finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,cachedContentTokenCount:25,candidatesTokenCount:4}}}
    await ctl('/event',{ticket:job.ticket,kind:'chunk',data:Buffer.from('data: '+JSON.stringify(frame)+'\n\n').toString('base64')})
    await ctl('/event',{ticket:job.ticket,kind:'end'})
  }})
  await broker.listen()
  server=createCcServer({fetchMessages:broker.fetch,stateDir:path.join(root,'journal'),token:'test',statelessRequests:true})
  server.server.listen(0,'127.0.0.1');await once(server.server,'listening')
  t.after(async()=>{await server.close();await broker.close();fs.rmSync(root,{recursive:true,force:true})})
  const url=`http://127.0.0.1:${server.server.address().port}/v1/messages`
  const post=(body,key)=>fetch(url,{method:'POST',headers:{'x-api-key':'test','idempotency-key':key},body:JSON.stringify(body)})
  const request={model:'fixture',max_tokens:256,system:"You are Claude Code, Anthropic's official CLI for Claude.",messages:[{role:'user',content:'Read proof.txt'}],tools:[{name:'Read',input_schema:{type:'object'}}]}
  const first=await(await post(request,'first')).json()
  assert.equal(first.stop_reason,'tool_use');assert.equal(first.usage.cache_read_input_tokens,25)
  assert.deepEqual(await(await post(request,'first')).json(),first);assert.equal(forwards,1)
  const follow={...request,messages:[...request.messages,{role:'assistant',content:first.content},{role:'user',content:[{type:'tool_result',tool_use_id:first.content[0].id,content:'proof'}]}]}
  assert.equal((await(await post(follow,'second')).json()).content[0].text,'done')
  assert.equal(forwards,2)
})

test('upstream 429 details and retry-after reach the client without a retry', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-error-'))
  let broker, server, forwards = 0
  const diagnostics = []
  const ctl = async (route, data) => {
    const response = await fetch(`http://127.0.0.1:${broker.server.address().port}${route}`, {method:'POST',headers:{authorization:'Bearer control'},body:JSON.stringify(data)})
    assert.equal(response.status, 200)
    return response.json()
  }
  broker = new MitmBroker({token:'control',storeDir:path.join(root,'wire'),logger: row => diagnostics.push(row),drive:async job=>{
    forwards++
    const claim=await ctl('/claim',{ticket:job.ticket,envelope:{model:'fixture',request:{contents:[{role:'user',parts:[{text:job.marker}]}]}}})
    assert.equal(claim.payload.request.systemInstruction.parts[0].text,AGY_IDENTITY+'\nKeep this instruction.')
    const error = {error:{message:'Synthetic quota exhausted',status:'RESOURCE_EXHAUSTED',details:[{reason:'QUOTA'}]}}
    await ctl('/event',{ticket:job.ticket,kind:'headers',status:429,error_body:Buffer.from(JSON.stringify(error)).toString('base64'),retry_after:'42'})
  }})
  await broker.listen()
  server = createCcServer({fetchMessages:broker.fetch,stateDir:path.join(root,'journal'),token:'test',statelessRequests:true})
  server.server.listen(0,'127.0.0.1'); await once(server.server,'listening')
  t.after(async()=>{await server.close();await broker.close();fs.rmSync(root,{recursive:true,force:true})})
  const response = await fetch(`http://127.0.0.1:${server.server.address().port}/v1/messages`,{method:'POST',headers:{'x-api-key':'test','user-agent':'deepseek-harness/1.0.0 (+https://example.test)'},body:JSON.stringify({model:'fixture',system:'You are a coding agent powered by the gemini-4-argon-high model.\nKeep this instruction.',stream:true,messages:[{role:'user',content:'hello'}]})})
  assert.equal(response.status,429)
  assert.equal(response.headers.get('retry-after'),'42')
  assert.equal(response.headers.get('x-should-retry'),'false')
  const payload = await response.json()
  assert.match(payload.error.message,/Synthetic quota exhausted/)
  assert.equal(payload.error.upstream_error.details[0].reason,'QUOTA')
  assert.equal(forwards,1)
  assert.equal(diagnostics.length,1); assert.equal(diagnostics[0].status,429); assert.equal(diagnostics[0].model,'fixture')
  assert.match(diagnostics[0].system_sha256,/^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(diagnostics),/Synthetic quota exhausted|hello/)
})


test('Claude streamed thought fragments replay as one signed thinking block', () => {
  const store=new WireStore(), model='claude-opus-fixture'
  const user={role:'user',content:'synthetic'}, call={type:'tool_use',id:'toolu_test',name:'Read',input:{path:'x'}}
  const content=[{type:'thinking',thinking:'',signature:'agyref_fixture'},call]
  const parts=[{text:''},{thought:true,text:'think '},{thought:true,text:'once'}, {thought:true,text:'',thoughtSignature:'provider-signature'},{functionCall:{name:'Read',args:{path:'x'}}},{text:''}]
  store.save(model,[user],content,parts)
  const projected=projectCc({model,messages:[user,{role:'assistant',content},{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_test',content:'done'}]}],tools:[{name:'Read',input_schema:{type:'object'}}]},store)
  assert.deepEqual(projected.contents[1].parts,[{thought:true,text:'think once',thoughtSignature:'provider-signature'},{functionCall:{name:'Read',args:{path:'x'}}}])
})

test('switching models keeps visible tool history and removes old reasoning and signatures', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-cross-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const source='claude-opus-fixture', target='gemini-fixture'
  const user={role:'user',content:'synthetic'}, content=[{type:'thinking',thinking:'',signature:'agyref_fixture'}, {type:'text',text:'visible'}, {type:'tool_use',id:'toolu_cross',name:'Read',input:{path:'x'}}]
  const original=[{thought:true,text:'secret thought',thoughtSignature:'thought-signature'}, {text:'visible',thoughtSignature:'text-signature'}, {functionCall:{name:'Read',args:{path:'x'},id:'original-id'},thoughtSignature:'tool-signature'}]
  new WireStore(dir).save(source,[user],content,original)
  const messages=[user,{role:'assistant',content},{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_cross',content:'done'}]}]
  const store=new WireStore(dir)
  const projected=projectCc({model:target,messages,tools:[{name:'Read',input_schema:{type:'object'}}]},store)
  assert.deepEqual(projected.contents[1].parts,[{text:'visible'},{functionCall:{name:'Read',args:{path:'x'},id:'original-id'}}])
  assert.equal(projected.contents[2].parts[0].functionResponse.response.output,'done')
  const split=[user,...content.map(block=>({role:'assistant',content:[block]})),messages[2]]
  const splitProjection=projectCc({model:target,messages:split,tools:[{name:'Read',input_schema:{type:'object'}}]},new WireStore(dir))
  assert.deepEqual(splitProjection.contents.filter(x=>x.role==='model').flatMap(x=>x.parts),[{text:'visible'},{functionCall:{name:'Read',args:{path:'x'},id:'original-id'}}])
  assert.deepEqual(projectCc({model:source,messages,tools:[{name:'Read',input_schema:{type:'object'}}]},store).contents[1].parts,original)
})
