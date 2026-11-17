import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliCarrier } from '../packages/agy-cli/mitm/carrier.mjs'

test('concurrent turns reuse one carrier and replacement waits for its exit', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-carrier-'))
  const cli=path.join(dir,'fake-agy'), log=path.join(dir,'events')
  fs.writeFileSync(cli, `#!${process.execPath}
const fs=require('fs'), readline=require('readline')
const log=process.env.TEST_CARRIER_LOG
const previous=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean):[]
const started=previous.filter(x=>x.startsWith('start ')).map(x=>Number(x.slice(6)))
for(const pid of started){try{process.kill(pid,0);fs.appendFileSync(log,'overlap\\n')}catch{}}
fs.appendFileSync(log,'start '+process.pid+'\\n')
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),150))
console.log(JSON.stringify({event:'init'}))
readline.createInterface({input:process.stdin}).on('line',()=>setTimeout(()=>console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'AGY_CC_CARRIER_ACK'}})),20))
`,{mode:0o700})
  const carrier=new CliCarrier({agy:cli,workspace:dir,env:{...process.env,TEST_CARRIER_LOG:log}})
  const job=model=>({body:{model},marker:'test',done:false})
  try {
    const cancelled=job('b')
    const turns=[carrier.run(job('a')),carrier.run(cancelled),carrier.run(job('a')),carrier.run(job('a'))]
    cancelled.done=true
    await Promise.all(turns)
    assert.equal(carrier.stats.starts,1)
    assert.equal(carrier.stats.acks,3)
    await carrier.run(job('b'))
    assert.equal(carrier.stats.starts,2)
    assert.doesNotMatch(fs.readFileSync(log,'utf8'),/overlap/)
  } finally {
    await carrier.stop()
    fs.rmSync(dir,{recursive:true,force:true})
  }
})
