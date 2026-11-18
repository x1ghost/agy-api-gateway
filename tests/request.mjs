import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MitmBroker } from '../packages/agy-cli/mitm/broker.mjs'

const body={
  model:'fixture', stream:true, system:'private system fixture',
  metadata:{user_id:'private conversation fixture'},
  messages:[{role:'user',content:'private prompt fixture'}],
  tools:[{name:'Read',input_schema:{type:'object'}}],
}
const send=(broker,signal)=>broker.fetch('/v1/messages',{
  body:JSON.stringify(body),userAgent:'deepseek-harness/1',signal,
})
const frame=parts=>Buffer.from('data: '+JSON.stringify({
  response:{candidates:[{content:{parts},finishReason:'STOP'}]},
})+'\n\n')

test('closing the response reader cancels the carrier and clears the broker exactly once',async()=>{
  const rows=[]
  let job
  const request=new AbortController()
  const broker=new MitmBroker({token:'fixture',logger:row=>rows.push(row),drive:current=>{
    job=current
    job.headers(200)
  }})
  const response=await send(broker,request.signal)
  const reader=response.body.getReader()
  await reader.read()
  await reader.cancel()
  request.abort()
  assert.equal(job.signal.aborted,true)
  assert.equal(job.done,true)
  assert.equal(broker.jobs.size,0)
  assert.equal(broker.terminal.get(job.ticket).state,'cancelled')
  assert.equal(rows.length,1)
  assert.equal(rows[0].status,499)
  assert.equal(rows[0].request_id,response.headers.get('request-id'))
})

test('request abort terminates the response both before and after headers',async()=>{
  for(const streamStarted of [false,true]){
    const request=new AbortController()
    const broker=new MitmBroker({token:'fixture',logger:()=>{},drive:job=>{
      if(streamStarted)job.headers(200)
      request.abort()
      assert.equal(job.signal.aborted,true)
    }})
    const response=await send(broker,request.signal)
    assert.equal(response.status,streamStarted?200:499)
    assert.match(await response.text(),/Client disconnected/)
    assert.equal(broker.jobs.size,0)
  }
})

test('request timing separates response headers, the first SSE, text and tool delivery',async()=>{
  const rows=[]
  const broker=new MitmBroker({token:'fixture',logger:row=>rows.push(row),drive:job=>{
    job.headers(200)
    const text=frame([{text:'private output fixture'}])
    job.chunk(text.subarray(0,3))
    job.chunk(text.subarray(3))
    job.chunk(frame([{functionCall:{name:'Read',args:{path:'private tool fixture'}}}]))
    job.end()
  }})
  const response=await send(broker)
  assert.match(await response.text(),/input_json_delta/)
  assert.equal(rows.length,1)
  const row=rows[0]
  const stages=row.stages_ms
  assert.equal(row.request_id,response.headers.get('request-id'))
  assert.equal(row.outcome,'success')
  assert.deepEqual(Object.keys(stages),[
    'preflight','upstream_headers','first_upstream_byte','first_upstream_sse','first_text','upstream_end','first_tool',
  ])
  assert.ok(Object.values(stages).every((value,i,values)=>value>=(values[i-1]??0)&&value<=row.duration_ms))
  assert.doesNotMatch(JSON.stringify(row),/private|fixture/)
})

test('timed-out requests report the stage reached and abort the carrier',async()=>{
  const rows=[]
  let job
  const broker=new MitmBroker({token:'fixture',timeoutMs:20,logger:row=>rows.push(row),drive:current=>{
    job=current
    job.timing.mark('account_queue')
  }})
  const response=await send(broker)
  assert.equal(response.status,504)
  assert.equal(job.signal.aborted,true)
  assert.equal(broker.jobs.size,0)
  assert.equal(rows[0].outcome,'timeout')
  assert.equal(rows[0].phase,'account_queue')
})
