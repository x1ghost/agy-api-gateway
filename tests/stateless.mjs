import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createCcServer } from '../packages/agy-cli/cc-http.mjs'

test('stateless Messages requests and explicit idempotency keys', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-test-'))
  let calls = 0
  const server = createCcServer({ token: 'test', stateDir: dir, statelessRequests: true,
    fetchMessages: async () => new Response(JSON.stringify({ calls: ++calls }), { headers: { 'content-type': 'application/json' } }) })
  server.server.listen(0, '127.0.0.1')
  await once(server.server, 'listening')
  t.after(async () => { await server.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const url = `http://127.0.0.1:${server.server.address().port}/v1/messages`
  const send = (key, content = 'hello') => fetch(url, { method: 'POST', headers: { 'x-api-key': 'test', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content }] }) })
  assert.deepEqual(await (await send()).json(), { calls: 1 })
  assert.deepEqual(await (await send()).json(), { calls: 2 })
  assert.deepEqual(await (await send('retry')).json(), { calls: 3 })
  assert.deepEqual(await (await send('retry')).json(), { calls: 3 })
  assert.equal((await send('retry', 'changed')).status, 409)
})

test('a 429 does not block a subsequent request, including after restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-429-'))
  let calls = 0
  async function start() {
    const server = createCcServer({ token:'test', stateDir:dir, statelessRequests:true,
      fetchMessages:async()=> ++calls === 1 ? new Response('rate limited',{status:429}) : new Response('ok') })
    server.server.listen(0,'127.0.0.1'); await once(server.server,'listening'); return server
  }
  let server = await start()
  t.after(async()=>{ await server.close(); fs.rmSync(dir,{recursive:true,force:true}) })
  const send = () => fetch(`http://127.0.0.1:${server.server.address().port}/v1/messages`, {method:'POST',headers:{'x-api-key':'test'},body:JSON.stringify({model:'fixture',messages:[{role:'user',content:'hello'}]})})
  assert.equal((await send()).status,429)
  assert.equal((await send()).status,200)
  await server.close(); server = await start()
  assert.equal((await send()).status,200)
})
