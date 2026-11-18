import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliCarrier } from '../packages/agy-cli/mitm/carrier.mjs'

test('one AGY process runs independent ACP sessions concurrently and isolates cancellation', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-carrier-'))
  const cli=path.join(dir,'fake-agy'), log=path.join(dir,'events')
  fs.writeFileSync(cli, `#!${process.execPath}
const fs=require('fs'), readline=require('readline')
const log=process.env.TEST_CARRIER_LOG
const previous=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean):[]
for(const line of previous.filter(x=>x.startsWith('start '))){try{process.kill(Number(line.slice(6)),0);fs.appendFileSync(log,'overlap\\n')}catch{}}
fs.appendFileSync(log,'start '+process.pid+'\\n')
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100))
let next=0, active=0;const models=new Map(), prompts=new Map()
const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}))
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params||{}
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}})
 if(m.method==='session/new')send({id:m.id,result:{sessionId:'s'+(++next)}})
 if(m.method==='session/set_model'){models.set(p.sessionId,p.modelId);send({id:m.id,result:{}})}
 if(m.method==='session/prompt'){
  active++;fs.appendFileSync(log,'prompt '+p.sessionId+' '+models.get(p.sessionId)+' '+active+'\\n')
  const timer=setTimeout(()=>{
   active--;prompts.delete(p.sessionId)
   send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'AGY_CC_CARRIER_ACK'}}}})
   send({id:m.id,result:{stopReason:'end_turn'}})
  },150)
  prompts.set(p.sessionId,{id:m.id,timer})
 }
 if(m.method==='session/cancel'&&prompts.has(p.sessionId)){
  fs.appendFileSync(log,'cancel '+p.sessionId+'\\n')
  const prompt=prompts.get(p.sessionId)
  clearTimeout(prompt.timer);prompts.delete(p.sessionId)
  setTimeout(()=>{
   active--
   send({id:prompt.id,result:{stopReason:'cancelled'}})
  },30)
 }
})
`,{mode:0o700})
  const carrier=new CliCarrier({agy:cli,workspace:dir,env:{...process.env,TEST_CARRIER_LOG:log}})
  const job=(model,scope)=>{
    const controller=new AbortController()
    return {body:{model},scope,marker:'synthetic',signal:controller.signal,controller}
  }
  const waitFor=async predicate=>{for(let n=0;n<100;n++){if(predicate())return;await new Promise(r=>setTimeout(r,10))}throw Error('fake AGY did not reach the expected state')}
  try {
    await Promise.all([carrier.run(job('a')),carrier.run(job('b'))])
    assert.equal(carrier.stats.starts,1);assert.equal(carrier.stats.acks,2)
    const first=fs.readFileSync(log,'utf8')
    assert.match(first,/prompt s\d+ a 1/);assert.match(first,/prompt s\d+ b 2/)
    const cancelled=job('a','cancel-scope'),other=job('b')
    const outcomes=[]
    cancelled.recordCancellation=(outcome,ms)=>outcomes.push([outcome,ms])
    const a=carrier.run(cancelled),b=carrier.run(other)
    await waitFor(()=>fs.readFileSync(log,'utf8').split('\n').filter(x=>x.startsWith('prompt ')).length===4)
    cancelled.controller.abort()
    assert.equal(carrier.queue.active,2)
    assert.equal(carrier.scopeQueues.get('cancel-scope').active,1)
    const results=await Promise.allSettled([a,b])
    assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled')
    assert.equal(carrier.stats.starts,1);assert.equal(carrier.stats.acks,3)
    assert.equal(fs.readFileSync(log,'utf8').split('\n').filter(x=>x.startsWith('cancel ')).length,1)
    assert.equal(outcomes.length,1)
    assert.equal(outcomes[0][0],'confirmed')
    await Promise.all([carrier.run(job('a','same-client-session')),carrier.run(job('b','same-client-session'))])
    const reused=fs.readFileSync(log,'utf8').split('\n').filter(x=>x.startsWith('prompt ')).slice(-2)
    assert.equal(reused.length,2)
    const [firstSession,secondSession]=reused.map(line=>line.split(' ')[1])
    assert.equal(firstSession,secondSession)
    assert.match(reused[0],/ a 1$/);assert.match(reused[1],/ b 1$/)
    for(let n=0;n<33;n++)await carrier.run(job('b','same-client-session'))
    assert.equal(carrier.stats.starts,1)
    assert.equal(carrier.reusedSessions.get('same-client-session').id,firstSession)
    await carrier.stop()
    await carrier.run(job('a'))
    assert.equal(carrier.stats.starts,2)
    assert.doesNotMatch(fs.readFileSync(log,'utf8'),/overlap/)
  } finally {
    await carrier.stop();fs.rmSync(dir,{recursive:true,force:true})
  }
})

test('ACP cancellation distinguishes a normal terminal reply from a missing confirmation', {timeout:1500}, async()=>{
  const carrier=new CliCarrier({agy:'unused',workspace:'/unused',env:{},cancelTimeoutMs:20})
  const writes=[]
  carrier.child={stdin:{writable:true,write:line=>writes.push(JSON.parse(line))}}
  const run=()=>{
    const controller=new AbortController(),outcomes=[]
    const promise=carrier.request('session/prompt',{sessionId:'fixture'},1000,controller.signal,outcome=>outcomes.push(outcome))
    const id=writes.at(-1).id
    controller.abort()
    assert.deepEqual(writes.at(-1),{jsonrpc:'2.0',method:'session/cancel',params:{sessionId:'fixture'}})
    assert.equal(carrier.pending.has(id),true)
    return {promise,id,outcomes}
  }
  const finished=run()
  carrier.dispatch({id:finished.id,result:{stopReason:'end_turn'}})
  await finished.promise
  assert.deepEqual(finished.outcomes,['ended'])
  const missed=run()
  await assert.rejects(missed.promise,/cancellation confirmation timed out/)
  assert.equal(carrier.pending.size,0)
  carrier.dispatch({id:missed.id,result:{stopReason:'cancelled'}})
  assert.deepEqual(missed.outcomes,['timeout'])
})

test('cancelled queue entries leave immediately without advancing the same session', {timeout:1500}, async () => {
  const carrier=new CliCarrier({agy:'unused',workspace:'/unused',env:{AGY_ACP_CONCURRENCY:'1'}})
  const pending=[]
  carrier.turn=job=>new Promise(resolve=>pending.push({job,resolve}))
  const run=scope=>{
    const controller=new AbortController()
    const result=carrier.run({scope,signal:controller.signal}).then(()=>null,error=>error)
    return {controller,result}
  }
  const tick=()=>new Promise(resolve=>setImmediate(resolve))
  const active=run('same')
  const same=run('same')
  const next=run('same')
  const other=run('other')
  await tick()
  assert.equal(pending.length,1)
  same.controller.abort()
  other.controller.abort()
  assert.equal((await same.result).name,'AbortError')
  assert.equal((await other.result).name,'AbortError')
  assert.equal(carrier.queue.waiters.size,0)
  assert.equal(carrier.scopeQueues.get('same').waiters.size,1)
  assert.equal(carrier.scopeQueues.has('other'),false)
  assert.equal(pending.length,1)
  pending.shift().resolve()
  assert.equal(await active.result,null)
  await tick()
  assert.equal(pending.length,1)
  assert.equal(pending[0].job.scope,'same')
  pending.shift().resolve()
  assert.equal(await next.result,null)
  assert.equal(carrier.scopeQueues.size,0)
  assert.equal(carrier.queue.active,0)
})
