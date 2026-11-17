import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fail } from './protocol.mjs'

// One official CLI process hosts independent ACP sessions. The proxy replaces
// each marked request and the CLI receives only the carrier ACK.
export class CliCarrier {
  constructor({agy,workspace,env}) {
    this.agy=agy;this.workspace=workspace;this.env=env
    this.limit=Number(env.AGY_ACP_CONCURRENCY||8)
    if(!Number.isInteger(this.limit)||this.limit<1||this.limit>64)throw Error('AGY_ACP_CONCURRENCY must be between 1 and 64')
    this.child=null;this.ready=false;this.starting=null;this.retired=Promise.resolve();this.epoch=0
    this.pending=new Map();this.sessions=new Map();this.nextId=0;this.active=0;this.waiters=[];this.created=0
    this.stats={starts:0,acks:0}
  }
  async enter(){
    if(this.active<this.limit){this.active++;return}
    await new Promise(resolve=>this.waiters.push(resolve))
  }
  leave(){
    this.active--
    // Retire idle processes periodically without interrupting active sessions.
    if(!this.active&&this.created>=32)this.stop()
    if(this.waiters.length){this.active++;this.waiters.shift()()}
  }
  run=async job=>{
    await this.enter()
    try {if(!job.done)await this.turn(job)} finally {this.leave()}
  }
  async turn(job){
    const controller=new AbortController();let sessionId
    job.cancel=()=>{controller.abort();if(sessionId)this.notify('session/cancel',{sessionId})}
    await this.ensure()
    if(job.done)return
    this.created++
    const session=await this.request('session/new',{cwd:this.workspace,mcpServers:[]},45000,controller.signal)
    sessionId=session?.sessionId
    if(typeof sessionId!=='string'||!sessionId)throw fail('Official AGY did not create an ACP session',502)
    if(job.done){this.notify('session/cancel',{sessionId});return}
    const turn={text:'',invalid:false};this.sessions.set(sessionId,turn)
    try {
      await this.request('session/set_model',{sessionId,modelId:job.body.model},45000,controller.signal)
      if(job.done)return
      const result=await this.request('session/prompt',{sessionId,prompt:[{type:'text',text:job.marker+'\nReply only AGY_CC_CARRIER_ACK. Do not call tools.'}]},125000,controller.signal)
      if(controller.signal.aborted)return
      if(turn.invalid||turn.text.trim()!=='AGY_CC_CARRIER_ACK'||result?.stopReason!=='end_turn')throw fail('Official CLI carrier did not acknowledge the intercepted turn',502)
      this.stats.acks++;this.recordStats()
    } finally {this.sessions.delete(sessionId)}
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
  request(method,params,timeout,signal){
    if(!this.child||signal?.aborted)return Promise.reject(fail('Official CLI carrier retired',409))
    const id=++this.nextId
    return new Promise((resolve,reject)=>{
      const finish=(error,value)=>{
        if(!this.pending.delete(id))return
        clearTimeout(timer);signal?.removeEventListener('abort',abort)
        if(error)reject(error);else resolve(value)
      }
      const abort=()=>finish(fail('Official CLI carrier cancelled',409))
      const timer=setTimeout(()=>finish(fail(`Official AGY ACP ${method} timed out`,504)),timeout)
      this.pending.set(id,{method,finish});signal?.addEventListener('abort',abort,{once:true})
      if(signal?.aborted){abort();return}
      this.write({jsonrpc:'2.0',id,method,params})
    })
  }
  write(message){if(this.child?.stdin.writable)this.child.stdin.write(JSON.stringify(message)+'\n')}
  notify(method,params){this.write({jsonrpc:'2.0',method,params})}
  recordStats(){fs.writeFileSync(path.join(this.workspace,'carrier-stats.json'),JSON.stringify(this.stats),{mode:0o600})}
  stop(){
    this.epoch++;const child=this.child;this.child=null;this.ready=false;this.created=0
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
