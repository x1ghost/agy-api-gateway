import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { parseModels, modelPage } from '../packages/agy-cli/mitm/models.mjs'
import { createCcServer } from '../packages/agy-cli/cc-http.mjs'

test('AGY catalog discovery, pagination, authentication and model routing', async t => {
  const models = parseModels('Fetching available models...\ngemini-flash-low\tGemini Flash (Low)\nclaude-sonnet-4-6    Claude Sonnet 4.6 (Thinking)\n')
  assert.deepEqual(models.map(m => m.id), ['gemini-flash-low', 'claude-agy/gemini-flash-low', 'claude-sonnet-4-6'])
  assert.equal(modelPage(models, new URLSearchParams('limit=2')).has_more, true)
  assert.deepEqual(modelPage(models, new URLSearchParams('after_id=claude-agy%2Fgemini-flash-low')).data.map(m => m.id), ['claude-sonnet-4-6'])
  assert.throws(() => parseModels('error, please sign in'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-models-'))
  let routed
  const server = createCcServer({ token:'test', stateDir:dir, statelessRequests:true, listModels:async()=>models,
    fetchMessages: async (_url, request) => { routed = JSON.parse(request.body).model; return new Response('{}', { headers: { 'content-type':'application/json' } }) } })
  server.server.listen(0, '127.0.0.1'); await once(server.server, 'listening')
  t.after(async()=>{ await server.close(); fs.rmSync(dir,{recursive:true,force:true}) })
  const base = `http://127.0.0.1:${server.server.address().port}`
  assert.equal((await fetch(base+'/v1/models')).status, 401)
  assert.equal((await fetch(base+'/v1/models?limit=0',{headers:{'x-api-key':'test'}})).status, 400)
  const response = await fetch(base+'/v1/models?limit=1000',{headers:{'x-api-key':'test'}})
  assert.deepEqual((await response.json()).data.map(m=>m.id), models.map(m=>m.id))
  const sent = await fetch(base+'/v1/messages',{method:'POST',headers:{'x-api-key':'test'},body:JSON.stringify({model:'claude-agy/gemini-flash-low',messages:[{role:'user',content:'hello'}]})})
  assert.equal(sent.status,200); assert.equal(routed,'gemini-flash-low')
})
