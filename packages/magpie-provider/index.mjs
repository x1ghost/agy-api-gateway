const PROVIDER = 'agy-gateway'
const SDK = '@ai-sdk/anthropic'
const DEFAULT_URL = 'http://127.0.0.1:3437'

// Keep credentials out of URLs, and allow a gateway under a reverse-proxy path.
export function gatewayBase(value) {
  const u = new URL(value || DEFAULT_URL)
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Gateway URL must be a plain HTTP(S) URL')
  u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  return u.href.replace(/\/$/, '')
}

function account(auth) {
  if (!auth || auth.type !== 'api' || typeof auth.key !== 'string' || !auth.key.trim()) throw new Error('Sign in with a Gateway API key')
  return {key:auth.key, base:gatewayBase(auth.metadata?.baseURL)}
}

async function catalog(auth, signal, fetchImpl = fetch) {
  const {key, base} = account(auth)
  const result = {}, seen = new Set()
  let after
  for (let i=0; i<100; i++) {
    const url = new URL(base + '/v1/models')
    url.searchParams.set('limit','1000')
    if (after) url.searchParams.set('after_id',after)
    const r = await fetchImpl(url, {headers:{'x-api-key':key, 'anthropic-version':'2023-06-01'}, redirect:'error', signal})
    if (!r.ok) { await r.body?.cancel(); throw new Error(`Gateway model discovery failed (HTTP ${r.status})`) }
    const page = await r.json()
    if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') throw new Error('Gateway returned an invalid model list')
    for (const m of page.data) {
      if (!m || typeof m.id !== 'string' || !m.id || m.id.startsWith('claude-agy/')) continue
      result[m.id] = {id:m.id, name:typeof m.display_name === 'string' ? m.display_name : m.id,
        api:{id:m.id, url:base + '/v1', npm:SDK}, limit:{context:0, output:0},
        capabilities:{toolcall:true, input:{text:true}, output:{text:true}}}
    }
    if (!page.has_more) return result
    if (typeof page.last_id !== 'string' || !page.last_id || seen.has(page.last_id)) throw new Error('Gateway returned an invalid model cursor')
    seen.add(page.last_id); after = page.last_id
  }
  throw new Error('Gateway model list has too many pages')
}

function targetPath(pathname) {
  if (/\/(?:v1\/)?messages\/count_tokens\/?$/.test(pathname)) return '/v1/messages/count_tokens'
  if (/\/v1\/messages\/?$/.test(pathname) || /\/messages\/?$/.test(pathname)) return '/v1/messages'
  throw new Error('Unsupported Gateway endpoint')
}

export async function AgyGatewayPlugin(_input, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  return {
    async config(config) {
      config.provider ??= {}
      config.provider[PROVIDER] ??= {name:'AGY Gateway', npm:SDK, models:{}}
    },
    auth:{
      provider:PROVIDER,
      methods:[{
        type:'api', keyless:true, label:'AGY Gateway',
        prompts:[
          {type:'text',key:'baseURL',message:'Gateway URL',placeholder:DEFAULT_URL,
            validate:v=>{try {gatewayBase(v); return undefined} catch {return 'Enter an HTTP(S) Gateway URL without credentials or query parameters'}}},
          {type:'password',key:'token',message:'Gateway API key',validate:v=>typeof v==='string'&&v.trim()?undefined:'API key required'},
        ],
        async authorize(input) {
          const values=input && typeof input==='object' ? input : {token:input}
          if (typeof values.token!=='string' || !values.token.trim()) return {type:'failed',error:'API key required'}
          try {return {type:'success',key:values.token.trim(),metadata:{baseURL:gatewayBase(values.baseURL)}}}
          catch {return {type:'failed',error:'Invalid Gateway URL'}}
        },
      }],
      async loader(getAuth) {
        const initial=account(await getAuth())
        return {
          baseURL:initial.base+'/v1', apiKey:initial.key,
          async fetch(input, init={}) {
            const req=new Request(input,init)
            if(req.method!=='POST') throw new Error('Gateway provider supports POST requests only')
            const {base,key}=account(await getAuth())
            const path=targetPath(new URL(req.url).pathname)
            const headers=new Headers({'x-api-key':key})
            for(const name of ['content-type','accept','anthropic-version','anthropic-beta','user-agent','x-cc-session-id','idempotency-key']) {
              const value=req.headers.get(name); if(value) headers.set(name,value)
            }
            if(!headers.has('anthropic-version')) headers.set('anthropic-version','2023-06-01')
            return fetchImpl(base+path,{method:'POST',headers,body:await req.arrayBuffer(),signal:req.signal,redirect:'error'})
          },
        }
      },
    },
    provider:{id:PROVIDER,npm:SDK,models:async (_provider,{auth,signal}={})=>auth?catalog(auth,signal,fetchImpl):{}},
  }
}

export default {id:PROVIDER, server:AgyGatewayPlugin}
