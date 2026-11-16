import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createAccountRouter } from '../packages/agy-cli/router/server.mjs'

const token=(value)=>value.repeat(40)
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port}

test('account keys select isolated gateways for models and streaming, without retry or failover',async t=>{
  const seen=[]
  const backends=['a','b'].map(id=>http.createServer((req,res)=>{
    seen.push({id,path:req.url,key:req.headers['x-api-key'],auth:req.headers.authorization,idem:req.headers['idempotency-key']})
    if(req.headers['x-api-key']!==token(id)){res.writeHead(401).end();return}
    if(req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id}));return}
    if(req.url==='/v1/messages'&&id==='b'){res.writeHead(429,{'retry-after':'21'}).end('limited');return}
    if(req.url==='/forbidden'&&id==='b'){res.writeHead(403).end('forbidden');return}
    res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: one\n\n');setTimeout(()=>res.end('data: two\n\n'),10)
  }))
  const ports=await Promise.all(backends.map(listen))
  const router=createAccountRouter(backends.map((_,i)=>({id:String(i),client_token:token(String(i)),backend_token:token(i?'b':'a'),backend:`http://127.0.0.1:${ports[i]}`})))
  const port=await listen(router)
  t.after(async()=>{await Promise.all([router,...backends].map(server=>new Promise(resolve=>server.close(resolve))))})
  const base=`http://127.0.0.1:${port}`
  assert.equal((await fetch(`${base}/v1/models`,{headers:{'x-api-key':token('0')}}).then(r=>r.json())).id,'a')
  assert.equal((await fetch(`${base}/v1/models`,{headers:{authorization:`Bearer ${token('1')}`}}).then(r=>r.json())).id,'b')
  const stream=await fetch(`${base}/v1/messages`,{method:'POST',headers:{'x-api-key':token('0'),'idempotency-key':'same-key'},body:'{}'})
  assert.equal(await stream.text(),'data: one\n\ndata: two\n\n')
  const limited=await fetch(`${base}/v1/messages`,{method:'POST',headers:{'x-api-key':token('1')},body:'{}'})
  assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'21');assert.equal(await limited.text(),'limited')
  assert.equal((await fetch(`${base}/forbidden`,{headers:{'x-api-key':token('1')}})).status,403)
  assert.equal((await fetch(`${base}/v1/models`,{headers:{'x-api-key':'bad'}})).status,401)
  assert.equal(seen.length,5);assert.equal(seen[2].idem,'same-key');assert.ok(seen.every(x=>!x.auth))
  assert.deepEqual(seen.map(x=>x.id),['a','b','a','b','b'])
})

test('router rejects duplicate credentials and non-loopback backends',()=>{
  const a={id:'one',client_token:token('c'),backend_token:token('b'),backend:'http://127.0.0.1:4000'}
  assert.throws(()=>createAccountRouter([a,{...a,id:'two'}]),/duplicate account token/)
  assert.throws(()=>createAccountRouter([{...a,backend:'http://example.com:4000'}]),/loopback/)
})
