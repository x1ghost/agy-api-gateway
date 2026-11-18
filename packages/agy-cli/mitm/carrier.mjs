import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fail } from './protocol.mjs'
import { waitForSignal } from './request.mjs'

class TurnQueue {
  constructor(limit) {
    this.limit=limit
    this.active=0
    this.waiters=new Set()
  }
  async enter(signal) {
    signal.throwIfAborted()
    if(this.active<this.limit){this.active++;return}
    await new Promise((resolve,reject)=>{
      const ready=()=>{
        signal.removeEventListener('abort',abort)
        resolve()
      }
      const abort=()=>{
        this.waiters.delete(ready)
        reject(signal.reason)
      }
      this.waiters.add(ready)
      signal.addEventListener('abort',abort,{once:true})
    })
  }
  leave() {
    const next=this.waiters.values().next().value
    if(!next){this.active--;return}
    this.waiters.delete(next)
    next()
  }
}

// One official CLI process hosts independent ACP sessions. The proxy replaces
// each marked request and the CLI receives only the carrier ACK.
export class CliCarrier {
  constructor({agy,workspace,env,cancelTimeoutMs=5000}) {
    this.agy=agy;this.workspace=workspace;this.env=env
    this.limit=Number(env.AGY_ACP_CONCURRENCY||8)
    if(!Number.isInteger(this.limit)||this.limit<1||this.limit>64)throw Error('AGY_ACP_CONCURRENCY must be between 1 and 64')
    this.cancelTimeoutMs=cancelTimeoutMs
    this.child=null;this.ready=false;this.starting=null;this.retired=Promise.resolve();this.epoch=0
    this.pending=new Map();this.sessions=new Map();this.reusedSessions=new Map();this.scopeQueues=new Map();this.nextId=0;this.queue=new TurnQueue(this.limit);this.created=0
    this.stats={starts:0,acks:0}
  }
  run=async job=>{
    // Serialize turns only within the same client scope, including the period
    // after the HTTP response has ended but before the CLI finishes its ACK.
    const key=typeof job.scope==='string'&&job.scope?job.scope:null
    const {signal,timing}=job
    let scopeQueue,hasScopeSlot=false
    if(key){
      scopeQueue=this.scopeQueues.get(key)??new TurnQueue(1)
      this.scopeQueues.set(key,scopeQueue)
    }
    try {
      if(scopeQueue){
        timing?.mark('scope_queue')
        await scopeQueue.enter(signal)
        hasScopeSlot=true
      }
      timing?.mark('account_queue')
      await this.queue.enter(signal)
      try{
        signal.throwIfAborted()
        await this.turn(job,key)
      } finally {this.queue.leave()}
    } finally {
      if(hasScopeSlot)scopeQueue.leave()
      if(scopeQueue?.active===0&&this.scopeQueues.get(key)===scopeQueue)this.scopeQueues.delete(key)
    }
  }
  async turn(job,key){
    const {signal,timing}=job
    timing?.mark('acp_start')
    await waitForSignal(this.ensure(),signal)
    signal.throwIfAborted()
    timing?.mark('acp_ready')
    const child=this.child
    let saved=key?this.reusedSessions.get(key):undefined,sessionId=saved?.id
    let completed=false
    try {
      if(!sessionId){
        timing?.mark('acp_session')
        const session=await this.request('session/new',{cwd:this.workspace,mcpServers:[]},45000,signal)
        sessionId=session?.sessionId
        if(typeof sessionId!=='string'||!sessionId)throw fail('Official AGY did not create an ACP session',502)
        signal.throwIfAborted()
        this.created++
        saved={id:sessionId,model:null}
        if(key)this.reusedSessions.set(key,saved)
      }
      const turn={text:'',invalid:false};this.sessions.set(sessionId,turn)
      if(saved.model!==job.body.model){
        timing?.mark('acp_model')
        await this.request('session/set_model',{sessionId,modelId:job.body.model},45000,signal)
        saved.model=job.body.model
      }
      signal.throwIfAborted()
      timing?.mark('acp_prompt')
      const result=await this.request('session/prompt',{sessionId,prompt:[{type:'text',text:job.marker+'\nReply only AGY_CC_CARRIER_ACK. Do not call tools.'}]},605000,signal,job.recordCancellation)
      signal.throwIfAborted()
      if(turn.invalid||turn.text.trim()!=='AGY_CC_CARRIER_ACK'||result?.stopReason!=='end_turn')throw fail('Official CLI carrier did not acknowledge the intercepted turn',502)
      completed=true;this.stats.acks++;this.recordStats()
    } finally {
      if(this.child===child&&sessionId)this.sessions.delete(sessionId)
      if(!completed&&key&&this.reusedSessions.get(key)===saved)this.reusedSessions.delete(key)
    }
  }
  async ensure(){
    if(this.child&&this.ready)return
    if(!this.starting){
      const epoch=this.epoch
      const starting=this.start(epoch)
      this.starting=starting
      starting.finally(()=>{if(this.starting===starting)this.starting=null}).catch(()=>{})
    }
    await this.starting
  }
  async start(epoch){
    await this.retired
    if(epoch!==this.epoch)throw fail('Official CLI carrier retired',409)
    const dir=path.join(this.workspace,'.agents/agents/cc-carrier');fs.mkdirSync(dir,{recursive:true,mode:0o700})
    fs.writeFileSync(path.join(dir,'agent.md'),'---\nname: cc-carrier\ndescription: Isolated transport carrier\nmainAgent: true\nsubagent: false\ntools: []\ninheritMcp: false\ninheritCustomizations: false\nexcludeDefaultComponents: true\n---\nReply only AGY_CC_CARRIER_ACK. Do not call tools.\n',{mode:0o600})
    const child=spawn(this.agy,['acp','--stdio','--agent','cc-carrier'],{cwd:this.workspace,env:this.env,stdio:['pipe','pipe','pipe']})
    this.child=child;this.ready=false;this.stats.starts++;let buffer=''
    child.stderr.on('data',()=>{}) // Never log private CLI/auth output.
    child.stdin.on('error',()=>{if(this.child===child)this.stop()})
    child.once('error',()=>{if(this.child===child)this.stop()})
    child.once('exit',()=>{if(this.child===child)this.stop()})
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      if(this.child!==child)return
      buffer+=chunk;if(buffer.length>8*1024*1024){this.stop();return}
      let end
      while((end=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let message
        try{message=JSON.parse(line)}catch{continue}
        this.dispatch(message)
      }
    })
    try {
      const init=await this.request('initialize',{protocolVersion:1,clientCapabilities:{}},45000)
      if(init?.protocolVersion!==1||this.child!==child)throw fail('Official AGY ACP initialization failed',502)
      this.ready=true
    } catch(error){if(this.child===child)this.stop();throw error}
  }
  dispatch(message){
    if(!message||typeof message!=='object')return
    if(Object.hasOwn(message,'id')&&!message.method){
      const entry=this.pending.get(message.id);if(!entry)return
      entry.finish(message.error?fail(`Official AGY ACP ${entry.method} failed`,502):null,message.result);return
    }
    if(message.method==='session/update'){
      const turn=this.sessions.get(message.params?.sessionId),update=message.params?.update
      if(!turn||!update)return
      if(update.sessionUpdate==='agent_message_chunk'){
        if(update.content?.type!=='text'||typeof update.content.text!=='string')turn.invalid=true
        else {turn.text+=update.content.text;if(turn.text.length>1024)turn.invalid=true}
      } else if(update.sessionUpdate==='tool_call'||update.sessionUpdate==='tool_call_update')turn.invalid=true
      return
    }
    if(Object.hasOwn(message,'id')&&message.method){
      const result=message.method==='session/request_permission'?{outcome:{outcome:'cancelled'}}:undefined
      this.write(result?{jsonrpc:'2.0',id:message.id,result}:{jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported carrier request'}})
    }
  }
  request(method,params,timeout,signal,recordCancellation){
    if(!this.child||signal?.aborted)return Promise.reject(fail('Official CLI carrier retired',409))
    const id=++this.nextId
    return new Promise((resolve,reject)=>{
      let timer,cancelStarted
      const finish=(error,value,outcome)=>{
        if(!this.pending.delete(id))return
        clearTimeout(timer);signal?.removeEventListener('abort',abort)
        if(cancelStarted!==undefined){
          const state=outcome??(value?.stopReason==='cancelled'?'confirmed':value?.stopReason?'ended':'unconfirmed')
          recordCancellation?.(state,Math.round(performance.now()-cancelStarted))
        }
        if(error)reject(error);else resolve(value)
      }
      const abort=()=>{
        if(method!=='session/prompt'){finish(fail('Official CLI carrier cancelled',409));return}
        // Keep the original RPC pending: the cancellation notification has
        // no reply of its own. The client response has already been settled.
        cancelStarted=performance.now()
        clearTimeout(timer)
        timer=setTimeout(()=>finish(fail('Official AGY cancellation confirmation timed out',504),undefined,'timeout'),this.cancelTimeoutMs)
        this.notify('session/cancel',{sessionId:params.sessionId})
      }
      timer=setTimeout(()=>finish(fail(`Official AGY ACP ${method} timed out`,504)),timeout)
      this.pending.set(id,{method,finish});signal?.addEventListener('abort',abort,{once:true})
      this.write({jsonrpc:'2.0',id,method,params})
    })
  }
  write(message){if(this.child?.stdin.writable)this.child.stdin.write(JSON.stringify(message)+'\n')}
  notify(method,params){this.write({jsonrpc:'2.0',method,params})}
  recordStats(){fs.writeFileSync(path.join(this.workspace,'carrier-stats.json'),JSON.stringify(this.stats),{mode:0o600})}
  stop(){
    this.epoch++;const child=this.child;this.child=null;this.ready=false;this.created=0;this.reusedSessions.clear()
    for(const entry of [...this.pending.values()])entry.finish(fail('Official CLI carrier retired',409))
    this.sessions.clear()
    if(!child)return this.retired
    this.retired=new Promise(resolve=>{
      if(child.exitCode!==null||child.signalCode!==null){resolve();return}
      const timer=setTimeout(()=>child.kill('SIGKILL'),2000)
      child.once('close',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM')
    })
    return this.retired
  }
}
