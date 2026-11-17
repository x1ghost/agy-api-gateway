import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import plugin, {AgyMagpiePlugin} from '../index.mjs'
import {onProvider} from '../magpie.middleware.mjs'
import {accountConcurrency} from '../plugin-runtime.mjs'

test('per-home concurrency overrides the default independently',()=>{
 const env={AGY_ACP_CONCURRENCY:'2',AGY_ACP_CONCURRENCY_BY_HOME:JSON.stringify({'/test/ultra':4})}
 assert.equal(accountConcurrency('/test/ultra',env),4)
 assert.equal(accountConcurrency('/test/other',env),2)
 assert.throws(()=>accountConcurrency('/test/ultra',{...env,AGY_ACP_CONCURRENCY_BY_HOME:'{"/test/ultra":0}'}))
})

test('Magpie supplies account, session and subagent identities to the provider',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'magpie-agy-'))
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 const credential=path.join(home,'.gemini','antigravity-cli');fs.mkdirSync(credential,{recursive:true});fs.writeFileSync(path.join(credential,'antigravity-oauth-token'),'synthetic')
 const jobs=[];const runtime={broker:{fetch:async(_url,options)=>{jobs.push({body:JSON.parse(options.body),agent:options.userAgent});return Response.json({ok:true})}},models:async()=>[{id:'test-model',display_name:'Test'}],usage:async()=>({windows:[]})}
 const hooks=await AgyMagpiePlugin({}, {runtimeFor:async selected=>{assert.equal(selected,fs.realpathSync(home));return runtime}})
 assert.equal(plugin.id,'claude-agy');const auth=await hooks.auth.methods[0].authorize({home});assert.equal(auth.type,'success')
 const loaded=await hooks.auth.loader(async()=>({type:'api',key:home}));const model=await hooks.provider.models({}, {auth:{type:'api',key:home}});assert.equal(model['test-model'].id,'test-model')
 const body=JSON.stringify({model:'test-model',messages:[{role:'user',content:'synthetic'}]})
 const send=headers=>loaded.fetch('agy://local/v1/messages',{method:'POST',headers,body})
 assert.equal((await send({})).status,400);assert.equal(jobs.length,0)
 const out={headers:{}};await hooks['chat.headers']({model:{providerID:'claude-agy'},sessionID:'magpie-derived'},out)
 assert.equal((await send(out.headers)).status,200)
 assert.equal((await send({'x-magpie-session':'real-session'})).status,200)
 assert.equal((await send({'x-magpie-session':'real-session','x-magpie-subagent':'child'})).status,200)
 assert.notEqual(jobs[0].body.metadata.user_id,jobs[1].body.metadata.user_id)
 assert.notEqual(jobs[1].body.metadata.user_id,jobs[2].body.metadata.user_id)
 const tagged=onProvider(JSON.parse(body),{provider:{id:'claude-agy'},agent:'dsh'})
 const marked=await loaded.fetch('agy://local/v1/messages',{method:'POST',headers:{'x-magpie-session':'custom'},body:JSON.stringify(tagged)})
 assert.equal(marked.status,200);assert.equal(jobs[3].agent,'deepseek-harness/1');assert.equal(jobs[3].body.metadata.__agy_magpie_agent,undefined)
 assert.equal(onProvider(JSON.parse(body),{provider:{id:'other'},agent:'dsh'}),undefined)
 const other={headers:{}};await hooks['chat.headers']({model:{providerID:'other'},sessionID:'no'},other);assert.deepEqual(other.headers,{})
})
