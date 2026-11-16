#!/usr/bin/env node
// Account routing only: each backend owns its official CLI, credentials and state.
import fs from 'node:fs'
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const hopHeaders = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'])
const same = (a,b) => { const x=Buffer.from(a||''), y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y) }
const error = (res,status,message) => {
  if(res.headersSent) { res.destroy(); return }
  res.writeHead(status,{'content-type':'application/json','x-should-retry':'false','cache-control':'no-store'})
  res.end(JSON.stringify({type:'error',error:{type:'api_error',message}}))
}
export function validateAccounts(accounts) {
  if(!Array.isArray(accounts)||!accounts.length)throw Error('At least one account is required')
  const ids=new Set(),keys=new Set()
  return accounts.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(row.id)||ids.has(row.id))throw Error('Invalid or duplicate account ID')
    if(typeof row.client_token!=='string'||row.client_token.length<32||typeof row.backend_token!=='string'||row.backend_token.length<32||keys.has(row.client_token))throw Error('Invalid or duplicate account token')
    let url
    try { url=new URL(row.backend) } catch { throw Error('Invalid backend URL') }
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Backend must be an HTTP loopback address with a port')
    ids.add(row.id);keys.add(row.client_token)
    return {id:row.id,clientToken:row.client_token,backendToken:row.backend_token,url}
  })
}
export function createAccountRouter(accounts,{logger=()=>{}}={}) {
  accounts=validateAccounts(accounts)
  const server=http.createServer((req,res)=>{
    if(req.method==='GET'&&req.url==='/health') {res.writeHead(200,{'content-type':'application/json'}).end('{"status":"ok","mode":"account-router"}');return}
    const candidate=req.headers['x-api-key']||req.headers.authorization?.replace(/^Bearer /i,'')||''
    const account=accounts.find(row=>same(candidate,row.clientToken))
    if(!account){error(res,401,'Invalid gateway token');return}
    const headers={}
    for(const [key,value] of Object.entries(req.headers))if(!hopHeaders.has(key)&&!['authorization','x-api-key','host'].includes(key))headers[key]=value
    headers['x-api-key']=account.backendToken
    const upstream=http.request({hostname:'127.0.0.1',port:account.url.port,path:req.url,method:req.method,headers},reply=>{
      const output={}
      for(const [key,value] of Object.entries(reply.headers))if(!hopHeaders.has(key))output[key]=value
      res.writeHead(reply.statusCode,output)
      reply.pipe(res)
      reply.once('error',()=>res.destroy())
      try{logger({account:account.id,status:reply.statusCode})}catch{}
    })
    upstream.once('error',()=>error(res,502,'Account gateway unavailable'))
    req.once('aborted',()=>upstream.destroy())
    res.once('close',()=>{if(!res.writableEnded)upstream.destroy()})
    req.pipe(upstream)
  })
  server.requestTimeout=30000;server.headersTimeout=15000
  return server
}
function readConfig(file) {
  if(!file||!file.startsWith('/'))throw Error('AGY_ROUTER_CONFIG must be an absolute path')
  const stat=fs.lstatSync(file)
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error('Router config must be a private regular file owned by this user')
  return JSON.parse(fs.readFileSync(file,'utf8'))
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const config=readConfig(process.env.AGY_ROUTER_CONFIG),port=Number(process.env.AGY_CC_PORT||3437)
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid router port')
  const server=createAccountRouter(config.accounts,{logger:row=>process.stderr.write('agy_account '+JSON.stringify(row)+'\n')})
  server.listen(port,'127.0.0.1',()=>process.stderr.write(`Account router on 127.0.0.1:${port}\n`))
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)))
}
