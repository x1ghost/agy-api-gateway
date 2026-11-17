import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { MitmBroker } from './packages/agy-cli/mitm/broker.mjs'
import { CliCarrier } from './packages/agy-cli/mitm/carrier.mjs'
import { createModelProvider } from './packages/agy-cli/mitm/models.mjs'
import { assertForwardableSystem } from './packages/agy-cli/mitm/system-policy.mjs'
import { fetchUsage } from './packages/agy-cli/usage.mjs'

const addon=fileURLToPath(new URL('./packages/agy-cli/mitm/addon.py',import.meta.url))
const instances=new Map()
const proxyChildren=new Set()
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function freePort(){
  const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port
}
export function accountHome(auth){
  const raw=auth?.key
  if(typeof raw!=='string'||!path.isAbsolute(raw))throw Error('Select the absolute HOME of a signed-in AGY account')
  const home=fs.realpathSync(raw);if(!fs.statSync(home).isDirectory())throw Error('AGY HOME is not a directory')
  return home
}
export function accountConcurrency(home,env=process.env){
  let limits={}
  if(env.AGY_ACP_CONCURRENCY_BY_HOME){
    try{limits=JSON.parse(env.AGY_ACP_CONCURRENCY_BY_HOME)}catch{throw Error('AGY_ACP_CONCURRENCY_BY_HOME must be a JSON object')}
    if(!limits||typeof limits!=='object'||Array.isArray(limits))throw Error('AGY_ACP_CONCURRENCY_BY_HOME must be a JSON object')
  }
  const limit=Number(Object.hasOwn(limits,home)?limits[home]:env.AGY_ACP_CONCURRENCY||8)
  if(!Number.isInteger(limit)||limit<1||limit>64)throw Error('AGY ACP concurrency must be between 1 and 64')
  return limit
}
async function start(home){
  const agy=process.env.AGY_PATH||'agy', mitmdump=process.env.MITMDUMP_PATH||'mitmdump'
  const concurrency=accountConcurrency(home)
  const key=createHash('sha256').update(home).digest('hex').slice(0,24)
  const root=process.env.AGY_MAGPIE_STATE_DIR||path.join(os.homedir(),'.local','state','agy-magpie')
  if(!path.isAbsolute(root))throw Error('AGY_MAGPIE_STATE_DIR must be an absolute path')
  const account=path.join(root,key)
  for(const dir of [root,account]){fs.mkdirSync(dir,{recursive:true,mode:0o700});const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink()||st.mode&0o077||(process.getuid&&st.uid!==process.getuid()))throw Error('Plugin state must be private and owned by this user')}
  // Each host has its own control socket and CA; wire metadata stays shared
  // by the account across host restarts.
  const state=fs.mkdtempSync(path.join(account,'run-')),workspace=path.join(state,'workspace'),ca=path.join(state,'ca')
  for(const dir of [workspace,ca])fs.mkdirSync(dir,{mode:0o700})
  const token=randomBytes(32).toString('hex'),port=await freePort()
  const base={...process.env,HOME:home,AGY_MITM_STATE_DIR:state,AGY_MITM_ALLOW_MODEL_FORWARD:'1'}
  for(const name of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','AGY_CC_TOKEN','AGY_ACCOUNTS_CONFIG'])delete base[name]
  const ready=path.join(state,'proxy-ready'),cert=path.join(ca,'mitmproxy-ca-cert.pem');fs.rmSync(ready,{force:true})
  const proxy=spawn(mitmdump,['--listen-host','127.0.0.1','--listen-port',String(port),'--set',`confdir=${ca}`,'--set','connection_strategy=lazy','--set','flow_detail=0','--set','termlog_verbosity=error','-s',addon],{env:base,stdio:['ignore','ignore','pipe']})
  proxyChildren.add(proxy);proxy.once('close',()=>proxyChildren.delete(proxy))
  let proxyError;proxy.on('error',error=>{proxyError=error});proxy.stderr.on('data',()=>{})
  let broker,carrier
  try{
    const deadline=Date.now()+45000
    while(Date.now()<deadline){
      if(proxyError||proxy.exitCode!==null)throw Error('mitmdump failed to start')
      if(fs.existsSync(ready)&&fs.existsSync(cert))break
      await sleep(100)
    }
    if(!fs.existsSync(ready)||!fs.existsSync(cert))throw Error('mitmdump startup timed out')
    const trust=path.join(state,'trust.pem')
    const system=process.env.AGY_SYSTEM_CA_BUNDLE?fs.readFileSync(process.env.AGY_SYSTEM_CA_BUNDLE,'utf8'):tls.rootCertificates.join('\n')
    fs.writeFileSync(trust,system+'\n'+fs.readFileSync(cert,'utf8'),{mode:0o600})
    const url=`http://127.0.0.1:${port}`
    const env={...base,AGY_ACP_CONCURRENCY:String(concurrency),HTTPS_PROXY:url,HTTP_PROXY:url,ALL_PROXY:url,https_proxy:url,http_proxy:url,all_proxy:url,NO_PROXY:'localhost,127.0.0.1',no_proxy:'localhost,127.0.0.1',SSL_CERT_FILE:trust,NODE_EXTRA_CA_CERTS:cert,REQUESTS_CA_BUNDLE:trust,GRPC_DEFAULT_SSL_ROOTS_FILE_PATH:trust}
    carrier=new CliCarrier({agy,workspace,env})
    broker=new MitmBroker({token,storeDir:path.join(account,'wire'),drive:carrier.run,preflight:assertForwardableSystem,logger:()=>{}})
    const controlPort=await broker.listen()
    fs.writeFileSync(path.join(state,'control.json'),JSON.stringify({port:controlPort,token}),{mode:0o600})
    const models=createModelProvider({agy,workspace,env})
    let closing
    const close=()=>closing??=(async()=>{await carrier.stop();await broker.close();if(proxy.exitCode===null&&proxy.signalCode===null){proxy.kill('SIGTERM');await Promise.race([new Promise(resolve=>proxy.once('close',resolve)),sleep(2000)]);if(proxy.exitCode===null&&proxy.signalCode===null)proxy.kill('SIGKILL')}fs.rmSync(state,{recursive:true,force:true})})()
    return {broker,carrier,models,proxy,usage:signal=>fetchUsage(agy,{env,signal}),close}
  }catch(error){await carrier?.stop();if(broker)await broker.close();proxy.kill('SIGTERM');fs.rmSync(state,{recursive:true,force:true});throw error}
}
export async function runtimeFor(home){
  if(!instances.has(home)){
    const pending=start(home);instances.set(home,pending)
    pending.catch(()=>{if(instances.get(home)===pending)instances.delete(home)})
    pending.then(instance=>instance.proxy.once('close',()=>{if(instances.get(home)===pending){instances.delete(home);instance.close().catch(()=>{})}}),()=>{})
  }
  return instances.get(home)
}
export async function closeRuntimes(){
  const values=[...instances.values()];instances.clear()
  await Promise.allSettled(values.map(async promise=>{const instance=await promise;await instance.close()}))
}
process.once('exit',()=>{for(const child of proxyChildren)child.kill('SIGTERM')})
