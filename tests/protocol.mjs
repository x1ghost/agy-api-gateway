import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { MitmBroker } from '../packages/agy-cli/mitm/broker.mjs'
import { WireStore, projectCc } from '../packages/agy-cli/mitm/protocol.mjs'
import { AGY_NATIVE_SECURITY, KNOWN_REFUSED_SYSTEM_HASHES, systemFingerprint, assertForwardableSystem } from '../packages/agy-cli/mitm/system-policy.mjs'
import { createCcServer } from '../packages/agy-cli/cc-http.mjs'

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
    const parts=forwards===1 ? [{thoughtSignature:'signed',functionCall:{id:'call-1',name:'Read',args:{path:'proof.txt'}}}] : [{text:'done'}]
    if(forwards===2)assert.equal(payload.request.contents.at(-1).parts[0].functionResponse.response.output,'proof')
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
  const request={model:'fixture',max_tokens:256,system:'Claude instructions',messages:[{role:'user',content:'Read proof.txt'}],tools:[{name:'Read',input_schema:{type:'object'}}]}
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
  const ctl = async (route, data) => {
    const response = await fetch(`http://127.0.0.1:${broker.server.address().port}${route}`, {method:'POST',headers:{authorization:'Bearer control'},body:JSON.stringify(data)})
    assert.equal(response.status, 200)
    return response.json()
  }
  broker = new MitmBroker({token:'control',storeDir:path.join(root,'wire'),drive:async job=>{
    forwards++
    await ctl('/claim',{ticket:job.ticket,envelope:{model:'fixture',request:{contents:[{role:'user',parts:[{text:job.marker}]}]}}})
    const error = {error:{message:'Synthetic quota exhausted',status:'RESOURCE_EXHAUSTED',details:[{reason:'QUOTA'}]}}
    await ctl('/event',{ticket:job.ticket,kind:'headers',status:429,error_body:Buffer.from(JSON.stringify(error)).toString('base64'),retry_after:'42'})
  }})
  await broker.listen()
  server = createCcServer({fetchMessages:broker.fetch,stateDir:path.join(root,'journal'),token:'test',statelessRequests:true})
  server.server.listen(0,'127.0.0.1'); await once(server.server,'listening')
  t.after(async()=>{await server.close();await broker.close();fs.rmSync(root,{recursive:true,force:true})})
  const response = await fetch(`http://127.0.0.1:${server.server.address().port}/v1/messages`,{method:'POST',headers:{'x-api-key':'test'},body:JSON.stringify({model:'fixture',stream:true,messages:[{role:'user',content:'hello'}]})})
  assert.equal(response.status,429)
  assert.equal(response.headers.get('retry-after'),'42')
  assert.equal(response.headers.get('x-should-retry'),'false')
  const payload = await response.json()
  assert.match(payload.error.message,/Synthetic quota exhausted/)
  assert.equal(payload.error.upstream_error.details[0].reason,'QUOTA')
  assert.equal(forwards,1)
})
