import http from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { WireStore, WireTurn, projectCc, replaceRequest, fail } from './protocol.mjs'
const errorResponse=e=>Response.json({type:'error',error:{type:e.status===429?'rate_limit_error':'invalid_request_error',message:e.message}},{status:e.status||502,headers:{'x-should-retry':'false'}})
const cancelled=message=>Object.assign(fail(message,409),{cancelled:true})
const sse=(name,value)=>new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`)
export class MitmBroker {
  constructor({token,storeDir,drive,preflight,timeoutMs=120000}) { if(!token)throw Error('Control token required');this.token=token;this.store=new WireStore(storeDir);this.drive=drive;this.preflight=preflight;this.timeoutMs=timeoutMs;this.jobs=new Map();this.terminal=new Map();this.server=http.createServer((q,s)=>this.control(q,s)) }
  remember(ticket,state){this.terminal.set(ticket,{state,at:Date.now()});this.prune()}
  prune(){for(const [ticket,row] of this.terminal)if(Date.now()-row.at>600000)this.terminal.delete(ticket);while(this.terminal.size>1024)this.terminal.delete(this.terminal.keys().next().value)}
  async listen() { await new Promise(r=>this.server.listen(0,'127.0.0.1',r));return this.server.address().port }
  async close() {for(const j of this.jobs.values())j.abort(cancelled('Bridge closing'));await new Promise(r=>this.server.close(r))}
  resolveMessage=messageId=>{for(const j of this.jobs.values())if(!j.done&&j.turn?.id===messageId)return j.httpRequestId}
  cancelSession=async scope=>{for(const j of this.jobs.values())if(j.scope===scope)j.abort(cancelled('CC cancelled'))}
  fetch=async (url,options)=>{
    if(url.endsWith('/count_tokens'))return errorResponse(fail('Exact token counting is not implemented',400))
    let body
    try {body=JSON.parse(options.body);const projected=projectCc(body,this.store);this.preflight?.(projected)}catch(e){return errorResponse(e)}
    const ticket=randomUUID().replaceAll('-','');let resolveResponse,resolveCompletion,stream,controller
    const completion=new Promise(r=>{resolveCompletion=r})
    const response=new Promise(r=>{resolveResponse=r})
    if(body.stream)stream=new ReadableStream({start(c){controller=c}})
    const job={ticket,httpRequestId:options.requestId,marker:`AGY_CC_CARRIER_${ticket}`,scope:body.metadata?.user_id,body,claimed:false,done:false,responseStarted:false,status:null,
      emit:(name,data)=>{if(body.stream&&!job.done)controller.enqueue(sse(name,data))},
      headers:status=>{
        if(job.status!==null)throw fail('Duplicate upstream headers',409)
        job.status=status
        if(status!==200){job.abort(fail(`Official AGY upstream HTTP ${status}`,status>=400&&status<=599?status:502));return}
        job.turn=new WireTurn(body,this.store,job.emit)
        if(body.stream){job.responseStarted=true;resolveResponse(new Response(stream,{headers:{'content-type':'text/event-stream'}}));job.turn.start()}
      },
      chunk:bytes=>{if(job.status!==200||!job.turn)throw fail('Chunk before successful headers',409);job.turn.push(bytes)},
      end:()=>{
        if(!job.turn)throw fail('End before headers',409)
        const result=job.turn.finish();job.done=true;this.remember(ticket,'complete');clearTimeout(job.timer);resolveCompletion()
        if(body.stream)controller.close();else resolveResponse(Response.json(result))
      },
      abort:e=>{
        if(job.done)return
        if(job.responseStarted){job.emit('error',{type:'error',error:{type:e.status===429?'rate_limit_error':'api_error',message:e.message}});controller.close()}
        else resolveResponse(errorResponse(e))
        job.done=true;this.remember(ticket,e.cancelled?'cancelled':'failed');clearTimeout(job.timer);resolveCompletion();job.cancel?.()
      },
    }
    job.timer=setTimeout(()=>job.abort(fail('MITM carrier timed out',504)),this.timeoutMs)
    const abort=()=>job.abort(options.signal?.reason?.code==='CC_CANCELLED'?cancelled('CC generation cancelled'):fail('CC transport aborted unexpectedly',502));options.signal?.addEventListener('abort',abort,{once:true})
    this.jobs.set(ticket,job)
    Promise.resolve().then(()=>{if(options.signal?.aborted){abort();return}return this.drive(job)}).then(()=>completion).catch(e=>job.abort(e)).finally(()=>{this.jobs.delete(ticket);clearTimeout(job.timer);options.signal?.removeEventListener('abort',abort)})
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
        const payload=replaceRequest(input.envelope,job.body,this.store);job.claimed=true
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({payload}));return
      }
      if(req.url!=='/event'||!job.claimed)throw fail('Unclaimed or unknown control event',409)
      try {
        if(input.kind==='headers')job.headers(input.status)
        else if(input.kind==='chunk')job.chunk(Buffer.from(input.data,'base64'))
        else if(input.kind==='end')job.end()
        else if(input.kind==='error')job.abort(fail('MITM transport failed',502))
        else throw fail('Unknown event')
      } catch(e){job.abort(e);throw e}
      res.writeHead(200,{'content-type':'application/json'}).end('{"ok":true}')
    }catch(e){res.writeHead(e.status||500,{'content-type':'application/json'}).end(JSON.stringify({error:e.message,...(e.code?{code:e.code}:{})}))}
  }
}
