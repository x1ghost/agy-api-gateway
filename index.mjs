import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { accountHome, runtimeFor } from './plugin-runtime.mjs'

const PROVIDER='claude',SDK='@ai-sdk/anthropic',BASE='agy://local'
const errors=(status,message)=>Response.json({type:'error',error:{type:status===400?'invalid_request_error':'api_error',message}},{status,headers:{'x-should-retry':'false'}})
function chosenHome(value){
  const input=typeof value==='string'&&value.trim()?value.trim():os.homedir()
  return accountHome({key:input==='~'?os.homedir():input.startsWith('~/')?path.join(os.homedir(),input.slice(2)):input})
}
export async function AgyMagpiePlugin(_input,options={}){
  const getRuntime=options.runtimeFor||runtimeFor
  return {
    async config(config){config.provider??={};config.provider[PROVIDER]??={name:'Antigravity CLI',npm:SDK,models:{}}},
    // Magpie supplies its own conversation identity to this hook. Its explicit
    // x-magpie-session still takes precedence over the fallback conversation.
    async 'chat.headers'(input,output){
      if((input?.model?.providerID||input?.provider?.info?.id)!==PROVIDER)return
      if(typeof input.sessionID==='string'&&input.sessionID)output.headers['x-agy-magpie-conversation']=input.sessionID
    },
    auth:{provider:PROVIDER,methods:[{
      type:'api',keyless:true,label:'Use a signed-in AGY home',
      prompts:[{type:'text',key:'home',message:'HOME directory of the signed-in AGY account',placeholder:os.homedir()}],
      async authorize(values={}){
        try{
          const home=chosenHome(values.home)
          if(!fs.existsSync(path.join(home,'.gemini','antigravity-cli','antigravity-oauth-token')))return {type:'failed',error:'Sign in with the official AGY CLI in this HOME first'}
          const runtime=await getRuntime(home);await runtime.models()
          return {type:'success',key:home,accountId:home}
        }catch(error){return {type:'failed',error:error?.message||'Could not read the signed-in AGY account'}}
      },
    }],
      async loader(getAuth){
        const home=accountHome(await getAuth())
        return {baseURL:BASE,apiKey:'agy',async fetch(input,init={}){
          const request=new Request(input,init),headers=request.headers
          const session=headers.get('x-magpie-session')||headers.get('x-agy-magpie-conversation')
          if(!session)return errors(400,'Magpie did not supply a session identity')
          const subagent=headers.get('x-magpie-subagent')||''
          const scope=createHash('sha256').update(JSON.stringify([session,subagent])).digest('hex')
          let body
          try{body=await request.json()}catch{return errors(400,'Invalid JSON body')}
          if(!body||typeof body!=='object'||!Array.isArray(body.messages)||typeof body.model!=='string')return errors(400,'A model and messages are required')
          const agent=body.metadata?.__agy_magpie_agent
          body.metadata={...body.metadata,user_id:scope}
          delete body.metadata.__agy_magpie_agent
          try{
            const runtime=await getRuntime(home)
            return await runtime.broker.fetch(request.url,{body:JSON.stringify(body),signal:request.signal,requestId:randomUUID(),userAgent:agent==='dsh'?'deepseek-harness/1':headers.get('user-agent')||''})
          }catch(error){return errors(error?.status||502,error?.message||'AGY plugin failed')}
        }}
      },
      async usage(getAuth){try{const runtime=await getRuntime(accountHome(await getAuth()));return await runtime.usage()}catch(error){return {windows:[],error:error.message}}},
    },
    provider:{id:PROVIDER,npm:SDK,async models(_provider,{auth}={}){
      if(!auth)return {}
      const runtime=await getRuntime(accountHome(auth)),models=await runtime.models(),result={}
      for(const model of models){
        result[model.id]={id:model.id,name:model.display_name,npm:SDK,api:{id:model.id,url:BASE,npm:SDK},limit:{context:0,output:0},capabilities:{toolcall:true,input:{text:true},output:{text:true}}}
      }
      return result
    }},
  }
}
export default {id:PROVIDER,server:AgyMagpiePlugin}
