import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fail } from './protocol.mjs'
// Persistent official CLI, serial tiny carrier turns. Never consumes CC tools,
// real model text or model function calls. The MITM routes those directly to CC.
export class CliCarrier {
  constructor({agy,workspace,env}) {this.agy=agy;this.workspace=workspace;this.env=env;this.queue=Promise.resolve();this.child=null;this.pending=null;this.completed=0;this.stats={starts:0,acks:0}}
  run=job=>{
    const task=this.queue.catch(()=>{}).then(()=>this.turn(job));this.queue=task;return task
  }
  async turn(job) {
    if(job.done)return
    job.cancel=()=>this.stop() // Init may be slow; cancellation must already own this process.
    if(!this.child || this.model!==job.body.model || this.completed>=32){this.stop();await this.start(job.body.model)}
    if(job.done)return
    return new Promise((resolve,reject)=>{
      this.pending={job,resolve,reject};job.cancel=()=>this.stop()
      this.child.stdin.write(JSON.stringify({event:'user',message:{content:job.marker+'\nReply only AGY_CC_CARRIER_ACK. Do not call tools.'}})+'\n',e=>{if(e)this.stop()})
    })
  }
  async start(model) {
    this.model=model;this.completed=0;this.stats.starts++
    const dir=path.join(this.workspace,'.agents/agents/cc-carrier');fs.mkdirSync(dir,{recursive:true,mode:0o700})
    fs.writeFileSync(path.join(dir,'agent.md'),'---\nname: cc-carrier\ndescription: Isolated transport carrier\nmainAgent: true\nsubagent: false\ntools: []\ninheritMcp: false\ninheritCustomizations: false\nexcludeDefaultComponents: true\n---\nReply only AGY_CC_CARRIER_ACK. Do not call tools.\n',{mode:0o600})
    const child=spawn(this.agy,['--input-format','stream-json','--output-format','stream-json','--model',model,'--agent','cc-carrier'],{cwd:this.workspace,env:this.env,stdio:['pipe','pipe','pipe']})
    this.child=child;let buffer=''
    child.stderr.on('data',()=>{}) // Never log private CLI/auth output.
    child.stdin.on('error',()=>{})
    await new Promise((ready,reject)=>{
      const timer=setTimeout(()=>{reject(fail('Official CLI init timed out',504));this.stop()},45000)
      child.once('error',e=>{clearTimeout(timer);reject(e);this.stop()})
      child.once('exit',()=>{clearTimeout(timer);reject(fail('Official CLI exited',502));if(this.child===child)this.stop()})
      child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
        buffer+=chunk;if(buffer.length>8*1024*1024){this.stop();return}
        let end
        while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let e;try{e=JSON.parse(line)}catch{continue}
          if(e.event==='init'){clearTimeout(timer);ready()}
          if(e.event==='result'&&this.pending){const p=this.pending;this.pending=null;this.completed++
            if(e.result?.status==='SUCCESS'&&e.result.response?.trim()==='AGY_CC_CARRIER_ACK'){this.stats.acks++;this.recordStats();p.resolve()}
            else {p.reject(fail('Official CLI carrier did not acknowledge the intercepted turn',502));this.stop()}
          }
        }
      })
    })
  }
  recordStats(){fs.writeFileSync(path.join(this.workspace,'carrier-stats.json'),JSON.stringify(this.stats),{mode:0o600})}
  stop(){const child=this.child;this.child=null;child?.kill('SIGTERM');const p=this.pending;this.pending=null;p?.reject(fail('Official CLI carrier retired',409))}
}
