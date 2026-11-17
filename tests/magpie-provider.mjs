import {test} from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {once} from 'node:events'
import {AgyGatewayPlugin, gatewayBase} from '../packages/magpie-provider/index.mjs'

test('Magpie provider signs in, discovers models and forwards streaming requests', async t=>{
  const received=[]
  const server=http.createServer(async(req,res)=>{
    const data=[]; for await(const b of req)data.push(b)
    received.push({url:req.url,key:req.headers['x-api-key'],agent:req.headers['user-agent'],session:req.headers['x-cc-session-id'],body:Buffer.concat(data).toString()})
    if(req.url.startsWith('/v1/models')) {
      res.setHeader('content-type','application/json')
      const after=new URL(req.url,'http://localhost').searchParams.get('after_id')
      return res.end(JSON.stringify(after ? {data:[{id:'claude-sonnet',display_name:'Sonnet'}],has_more:false} : {data:[{id:'gemini-flash',display_name:'Flash'},{id:'claude-agy/gemini-flash',display_name:'Flash'}],has_more:true,last_id:'claude-agy/gemini-flash'}))
    }
    res.writeHead(200,{'content-type':'text/event-stream'});res.end('event: message_stop\ndata: {}\n\n')
  })
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close())
  const base=`http://127.0.0.1:${server.address().port}`
  const plugin=await AgyGatewayPlugin(),cfg={};await plugin.config(cfg)
  assert.equal(cfg.provider['agy-gateway'].npm,'@ai-sdk/anthropic')
  const login=await plugin.auth.methods[0].authorize({baseURL:base+'/v1',token:'test-key'})
  assert.equal(login.type,'success');const auth={type:'api',key:login.key,metadata:login.metadata}
  const models=await plugin.provider.models({}, {auth})
  assert.deepEqual(Object.keys(models),['gemini-flash','claude-sonnet'])
  assert.equal(models['gemini-flash'].api.url,base+'/v1')
  const loader=await plugin.auth.loader(async()=>auth)
  const payload=JSON.stringify({model:'gemini-flash',messages:[{role:'user',content:'hello'}],stream:true})
  const response=await loader.fetch('plugin://agy-gateway/v1/messages',{method:'POST',headers:{'x-api-key':'other-key','user-agent':'deepseek-harness/1.0.0','x-cc-session-id':'synthetic-session','content-type':'application/json'},body:payload})
  assert.equal(response.status,200);assert.match(await response.text(),/message_stop/)
  assert.deepEqual(received.map(r=>r.key),['test-key','test-key','test-key'])
  assert.equal(received[2].agent,'deepseek-harness/1.0.0');assert.equal(received[2].session,'synthetic-session');assert.equal(received[2].body,payload)
  await assert.rejects(loader.fetch('https://example.invalid/admin',{method:'POST',body:'{}'}),/Unsupported Gateway endpoint/)
})

test('plugin rejects unsafe endpoint URLs and reports invalid credentials', async()=>{
  for(const u of ['https://name:password@example.test','https://example.test/?token=x','file:///tmp/socket']) assert.throws(()=>gatewayBase(u))
  const plugin=await AgyGatewayPlugin()
  assert.equal((await plugin.auth.methods[0].authorize({baseURL:'http://localhost:3437',token:''})).type,'failed')
  await assert.rejects(plugin.provider.models({}, {auth:{type:'api',key:''}}),/API key/)
})
