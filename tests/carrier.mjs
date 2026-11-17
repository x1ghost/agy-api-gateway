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
let next=0, active=0;const models=new Map(), timers=new Map()
const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}))
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params||{}
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}})
 if(m.method==='session/new')send({id:m.id,result:{sessionId:'s'+(++next)}})
 if(m.method==='session/set_model'){models.set(p.sessionId,p.modelId);send({id:m.id,result:{}})}
 if(m.method==='session/prompt'){
  active++;fs.appendFileSync(log,'prompt '+p.sessionId+' '+models.get(p.sessionId)+' '+active+'\\n')
  timers.set(p.sessionId,setTimeout(()=>{
   active--;timers.delete(p.sessionId)
   send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'AGY_CC_CARRIER_ACK'}}}})
   send({id:m.id,result:{stopReason:'end_turn'}})
  },150))
 }
 if(m.method==='session/cancel'&&timers.has(p.sessionId)){clearTimeout(timers.get(p.sessionId));timers.delete(p.sessionId);active--}
})
`,{mode:0o700})
  const carrier=new CliCarrier({agy:cli,workspace:dir,env:{...process.env,TEST_CARRIER_LOG:log}})
  const job=model=>({body:{model},marker:'synthetic',done:false})
  const waitFor=async predicate=>{for(let n=0;n<100;n++){if(predicate())return;await new Promise(r=>setTimeout(r,10))}throw Error('fake AGY did not reach the expected state')}
  try {
    await Promise.all([carrier.run(job('a')),carrier.run(job('b'))])
    assert.equal(carrier.stats.starts,1);assert.equal(carrier.stats.acks,2)
    const first=fs.readFileSync(log,'utf8')
    assert.match(first,/prompt s\d+ a 1/);assert.match(first,/prompt s\d+ b 2/)
    const cancelled=job('a'),other=job('b')
    const a=carrier.run(cancelled),b=carrier.run(other)
    await waitFor(()=>fs.readFileSync(log,'utf8').split('\n').filter(x=>x.startsWith('prompt ')).length===4)
    cancelled.done=true;cancelled.cancel()
    const results=await Promise.allSettled([a,b])
    assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled')
    assert.equal(carrier.stats.starts,1);assert.equal(carrier.stats.acks,3)
    await carrier.stop()
    await carrier.run(job('a'))
    assert.equal(carrier.stats.starts,2)
    assert.doesNotMatch(fs.readFileSync(log,'utf8'),/overlap/)
  } finally {
    await carrier.stop();fs.rmSync(dir,{recursive:true,force:true})
  }
})
