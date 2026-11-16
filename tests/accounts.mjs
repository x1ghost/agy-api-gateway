import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createCcServer } from '../packages/agy-cli/cc-http.mjs'

const port=async()=>{const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p}
const delay=ms=>new Promise(r=>setTimeout(r,ms))

test('one gateway manually switches official CLI HOME and restores selection on restart',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-accounts-')), state=path.join(root,'state')
  fs.mkdirSync(state,{mode:0o700});for(const n of ['first','second'])fs.mkdirSync(path.join(root,n),{mode:0o700})
  const config=path.join(root,'accounts.json');fs.writeFileSync(config,JSON.stringify({accounts:['first','second'].map(id=>({id,home:path.join(root,id)}))}),{mode:0o600})
  const cli=path.join(root,'fake-agy');fs.writeFileSync(cli,'#!/usr/bin/env node\nsetTimeout(()=>{const n=require("node:path").basename(process.env.HOME);if(n==="broken")process.exit(1);console.log("gemini-"+n+"  Synthetic model")},200)\n',{mode:0o700})
  const p=await port(),base=`http://127.0.0.1:${p}`,headers={'x-api-key':'t'.repeat(40),'content-type':'application/json'}
  const env={...process.env,AGY_MITM_STATE_DIR:state,AGY_CC_TOKEN:'t'.repeat(40),AGY_PATH:cli,HTTPS_PROXY:'http://127.0.0.1:1',AGY_CC_PORT:String(p),AGY_ACCOUNTS_CONFIG:config}
  let child
  const start=async()=>{
    child=spawn(process.execPath,['packages/agy-cli/mitm/server.mjs'],{env,stdio:'ignore'})
    for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('Gateway exited');try{if((await fetch(base+'/health')).ok)return}catch{}await delay(30)}
    throw Error('Gateway startup timed out')
  }
  const stop=async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit')}}
  t.after(async()=>{await stop();fs.rmSync(root,{recursive:true,force:true})})
  const select=id=>fetch(base+'/gateway/accounts/select',{method:'POST',headers,body:JSON.stringify({id})})
  const models=()=>fetch(base+'/v1/models',{headers}).then(r=>r.json())
  await start()
  assert.equal((await fetch(base+'/gateway/accounts',{headers}).then(r=>r.json())).active,'first')
  const first=await models();assert.equal(first.data[0].id,'gemini-first')
  assert.equal((await select('second')).status,200)
  const pending=models();await delay(50)
  assert.equal((await select('first')).status,409)
  assert.equal((await pending).data[0].id,'gemini-second')
  await stop();await start()
  assert.equal((await fetch(base+'/gateway/accounts',{headers}).then(r=>r.json())).active,'second')
  assert.equal((await models()).data[0].id,'gemini-second')
  const add=(id,refresh_token)=>fetch(base+'/gateway/accounts',{method:'POST',headers,body:JSON.stringify({id,refresh_token})})
  const added=await add('third','synthetic-refresh-only')
  assert.equal(added.status,201);const summary=await added.json();assert.equal(summary.active,'second');assert.ok(summary.accounts.includes('third'));assert.ok(!JSON.stringify(summary).includes('synthetic-refresh-only'))
  const credential=path.join(state,'account-homes','third','.gemini','antigravity-cli','antigravity-oauth-token')
  assert.equal(JSON.parse(fs.readFileSync(credential)).token.refresh_token,'synthetic-refresh-only');assert.equal(fs.statSync(credential).mode&0o777,0o600)
  assert.equal((await add('third','another-token')).status,409)
  assert.equal((await add('broken','synthetic-token')).status,422);assert.ok(!fs.existsSync(path.join(state,'account-homes','broken')))
  assert.equal((await select('third')).status,200);assert.equal((await models()).data[0].id,'gemini-third')
  assert.equal((await select('missing')).status,400)
})

test('account changes isolate idempotent journal entries',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-journal-'));let selected='a',calls=0
  const server=createCcServer({token:'test',stateDir:dir,statelessRequests:true,accountControl:{current:()=>selected,list:()=>({active:selected}),select:id=>(selected=id,{active:id})},fetchMessages:async()=>new Response(JSON.stringify({account:selected,n:++calls}))})
  server.server.listen(0,'127.0.0.1');await once(server.server,'listening')
  t.after(async()=>{await server.close();fs.rmSync(dir,{recursive:true,force:true})})
  const url=`http://127.0.0.1:${server.server.address().port}`,headers={'x-api-key':'test','idempotency-key':'same','content-type':'application/json'}
  const request=()=>fetch(url+'/v1/messages',{method:'POST',headers,body:JSON.stringify({model:'m',messages:[{role:'user',content:'hi'}]})}).then(r=>r.json())
  assert.equal((await request()).account,'a');selected='b';assert.equal((await request()).account,'b');assert.equal(calls,2)
})
