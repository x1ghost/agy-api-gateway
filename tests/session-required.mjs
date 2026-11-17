import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createCcServer } from '../packages/agy-cli/cc-http.mjs'

test('Messages requires a client session identity even with an idempotency key', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-session-'));let forwarded=0
  const server=createCcServer({token:'test',stateDir:dir,fetchMessages:async()=>{forwarded++;return new Response('ok')}})
  server.server.listen(0,'127.0.0.1');await once(server.server,'listening')
  t.after(async()=>{await server.close();fs.rmSync(dir,{recursive:true,force:true})})
  const url=`http://127.0.0.1:${server.server.address().port}/v1/messages`
  const send=(headers={},metadata)=>fetch(url,{method:'POST',headers:{'x-api-key':'test',...headers},body:JSON.stringify({model:'fixture',messages:[{role:'user',content:'hello'}],...(metadata?{metadata}:{})})})
  assert.equal((await send()).status,400)
  assert.equal((await send({'idempotency-key':'retry'})).status,400)
  assert.equal(forwarded,0)
  assert.equal((await send({'x-cc-session-id':'session-a'})).status,200)
  assert.equal((await send({}, {user_id:'session-b'})).status,200)
  assert.equal(forwarded,2)
})
