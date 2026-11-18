import http from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { assertSupportedClient, isDshUserAgent } from './system-policy.mjs'
import { WireStore, WireTurn, projectCc, replaceRequest, fail } from './protocol.mjs'
import { logRequest, requestTiming } from './request.mjs'

const errorResponse=(e,id)=>Response.json({type:'error',error:{type:e.status===429?'rate_limit_error':'invalid_request_error',message:e.message,...(e.upstreamError?{upstream_error:e.upstreamError}:{})}},{status:e.status||502,headers:{'request-id':id,'x-should-retry':'false',...(e.retryAfter?{'retry-after':e.retryAfter}:{})}})
function upstreamFailure(status, encoded, retryAfter) {
  const e=fail(`Official AGY upstream HTTP ${status}`,status>=400&&status<=599?status:502)
  if(typeof encoded==='string' && encoded.length<=24000) {
    const raw=Buffer.from(encoded,'base64').toString('utf8')
    try {
      const value=JSON.parse(raw), detail=value?.error ?? value
      if(detail && typeof detail==='object' && !Array.isArray(detail)) {
        e.upstreamError=detail
        if(typeof detail.message==='string' && detail.message.trim()) e.message+=`: ${detail.message.slice(0,4096)}`
      }
    } catch { /* Invalid, truncated, or non-JSON errors retain the status. */ }
  }
  if(typeof retryAfter==='string' && retryAfter.length<=128 && /^[\x20-\x7e]+$/.test(retryAfter))e.retryAfter=retryAfter
  return e
}
const cancelled=(message,status=409)=>Object.assign(fail(message,status),{cancelled:true})
const sse=(name,value)=>new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`)
export class MitmBroker {
  constructor({token,storeDir,drive,preflight,timeoutMs=600000,logger=logRequest}) { if(!token)throw Error('Control token required');this.token=token;this.store=new WireStore(storeDir);this.drive=drive;this.preflight=preflight;this.timeoutMs=timeoutMs;this.logger=logger;this.jobs=new Map();this.terminal=new Map();this.server=http.createServer((q,s)=>this.control(q,s)) }
  remember(ticket,state){this.terminal.set(ticket,{state,at:Date.now()});this.prune()}
  prune(){for(const [ticket,row] of this.terminal)if(Date.now()-row.at>600000)this.terminal.delete(ticket);while(this.terminal.size>1024)this.terminal.delete(this.terminal.keys().next().value)}
  async listen() { await new Promise(r=>this.server.listen(0,'127.0.0.1',r));return this.server.address().port }
  async close() {for(const j of this.jobs.values())j.abort(cancelled('Bridge closing'));await new Promise(r=>this.server.close(r))}
  resolveMessage=messageId=>{for(const j of this.jobs.values())if(!j.done&&j.turn?.id===messageId)return j.httpRequestId}
  cancelSession=async scope=>{for(const j of this.jobs.values())if(j.scope===scope)j.abort(cancelled('CC cancelled'))}
  fetch=async (url,options)=>{
    const timing=options.timing??requestTiming(options.requestId)
    const disconnect=()=>options.signal?.reason?.code==='CC_CANCELLED'?cancelled('CC generation cancelled'):cancelled('Client disconnected',499)
    let body
    const dsh=isDshUserAgent(options.userAgent)
    timing.mark('preflight')
    try {
      if(options.signal?.aborted)throw disconnect()
      if(url.endsWith('/count_tokens'))throw fail('Exact token counting is not implemented',400)
      body=JSON.parse(options.body)
      assertSupportedClient(body,options.userAgent)
      const projected=projectCc(body,this.store,{dsh})
      this.preflight?.(projected)
    }catch(e){
      timing.finish(this.logger,e.status||502,e.cancelled?'cancelled':'preflight_error')
      return errorResponse(e,timing.id)
    }
    const ticket=randomUUID().replaceAll('-',''), cancellation=new AbortController()
    const responseHeaders={'request-id':timing.id}
    let resolveResponse,stream,controller
    const response=new Promise(r=>{resolveResponse=r})
    if(body.stream)stream=new ReadableStream({
      start(c){controller=c},
      cancel(){job.abort(disconnect(),'cancelled',true)},
    })
    const settle=(state,status,outcome)=>{
      job.done=true
      this.remember(ticket,state)
      this.jobs.delete(ticket)
      clearTimeout(job.timer)
      options.signal?.removeEventListener('abort',abort)
      timing.finish(this.logger,status,outcome,job.status)
    }
    const job={ticket,httpRequestId:timing.id,marker:`AGY_CC_CARRIER_${ticket}`,scope:body.metadata?.user_id,body,dsh,claimed:false,done:false,responseStarted:false,status:null,signal:cancellation.signal,timing,
      recordCancellation:(outcome,waitMs)=>{
        try {this.logger({event:'acp_cancellation',time:new Date().toISOString(),request_id:timing.id,outcome,wait_ms:waitMs})} catch {}
      },
      emit:(name,data)=>{
        if(name==='content_block_delta'&&data.delta.type==='text_delta')timing.mark('first_text')
        if(name==='content_block_start'&&data.content_block.type==='tool_use')timing.mark('first_tool')
        if(body.stream&&!job.done)controller.enqueue(sse(name,data))
      },
      headers:(status,errorBody,retryAfter)=>{
        if(job.status!==null)throw fail('Duplicate upstream headers',409)
        job.status=status
        timing.mark('upstream_headers')
        if(status!==200){job.abort(upstreamFailure(status,errorBody,retryAfter),'upstream_error');return}
        job.turn=new WireTurn(body,this.store,job.emit,()=>timing.mark('first_upstream_sse'))
        if(body.stream){job.responseStarted=true;resolveResponse(new Response(stream,{headers:{...responseHeaders,'content-type':'text/event-stream'}}));job.turn.start()}
      },
      chunk:bytes=>{
        if(job.status!==200||!job.turn)throw fail('Chunk before successful headers',409)
        timing.mark('first_upstream_byte')
        job.turn.push(bytes)
      },
      end:()=>{
        if(!job.turn)throw fail('End before headers',409)
        timing.mark('upstream_end')
        const result=job.turn.finish()
        settle('complete',200,'success')
        if(body.stream)controller.close();else resolveResponse(Response.json(result,{headers:responseHeaders}))
      },
      abort:(e,outcome=e.cancelled?'cancelled':'carrier_error',streamCancelled=false)=>{
        if(job.done)return
        settle(e.cancelled?'cancelled':'failed',e.status||502,outcome)
        cancellation.abort(e)
        if(!job.responseStarted)resolveResponse(errorResponse(e,timing.id))
        else if(!streamCancelled){
          controller.enqueue(sse('error',{type:'error',error:{type:e.status===429?'rate_limit_error':'api_error',message:e.message}}))
          controller.close()
        }
      },
    }
    job.timer=setTimeout(()=>job.abort(fail('MITM carrier timed out',504),'timeout'),this.timeoutMs)
    const abort=()=>job.abort(disconnect())
    options.signal?.addEventListener('abort',abort,{once:true})
    this.jobs.set(ticket,job)
    Promise.resolve().then(()=>{if(!job.done)return this.drive(job)}).catch(e=>job.abort(e))
    return response
  }
  async control(req,res) {
    try {
      const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+this.token)
      if(a.length!==b.length||!timingSafeEqual(a,b))throw fail('Unauthorized',401)
      if(req.method!=='POST')throw fail('POST required',405)
      let length=0;const chunks=[]
      for await(const c of req){length+=c.length;if(length>48*1024*1024)throw fail('Control body too large',413);chunks.push(c)}
      const input=JSON.parse(Buffer.concat(chunks).toString()),job=this.jobs.get(input.ticket)
      this.prune()
      const terminal=this.terminal.get(input.ticket)
      if(req.url==='/status'){
        const state=terminal?.state||((job&&!job.done)?'active':null)
        if(!state)throw fail('Unknown ticket',409)
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({state}));return
      }
      if(terminal?.state==='cancelled')throw Object.assign(fail('Ticket was explicitly cancelled',410),{code:'ticket_cancelled'})
      if(!job||job.done)throw fail('Unknown or completed ticket',409)
      if(req.url==='/claim') {
        if(job.claimed)throw fail('A ticket can forward only once; no CLI retry',409)
        if(!JSON.stringify(input.envelope.request?.contents||[]).includes(job.marker))throw fail('Carrier marker missing',409)
        const payload=replaceRequest(input.envelope,job.body,this.store,{dsh:job.dsh});job.claimed=true
        job.timing.mark('claimed')
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({payload}));return
      }
      if(req.url!=='/event'||!job.claimed)throw fail('Unclaimed or unknown control event',409)
      try {
        if(input.kind==='headers')job.headers(input.status,input.error_body,input.retry_after)
        else if(input.kind==='chunk')job.chunk(Buffer.from(input.data,'base64'))
        else if(input.kind==='end')job.end()
        else if(input.kind==='error')job.abort(fail('MITM transport failed',502),'transport_error')
        else throw fail('Unknown event')
      } catch(e){
        job.abort(e,'adapter_error')
        // A complete upstream response can fail our response adapter (for
        // example, an unknown tool). The client has received the error and
        // the proxy must settle this known response rather than treat it as an
        // uncertain transport failure and block subsequent requests.
        if(input.kind==='end' && job.status===200){res.writeHead(200,{'content-type':'application/json'}).end('{"ok":true,"adapter_error":true}');return}
        throw e
      }
      res.writeHead(200,{'content-type':'application/json'}).end('{"ok":true}')
    }catch(e){res.writeHead(e.status||500,{'content-type':'application/json'}).end(JSON.stringify({error:e.message,...(e.code?{code:e.code}:{})}))}
  }
}
