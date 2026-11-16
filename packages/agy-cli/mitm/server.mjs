#!/usr/bin/env node
// Experimental entry point, independent of native3438 and ACP3437. No default
// enabling of inference: the paired proxy must explicitly allow forwarding.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createCcServer } from '../cc-http.mjs'
import { MitmBroker } from './broker.mjs'
import { CliCarrier } from './carrier.mjs'
import { createModelProvider } from './models.mjs'
import { assertForwardableSystem } from './system-policy.mjs'
const state=process.env.AGY_MITM_STATE_DIR,token=process.env.AGY_CC_TOKEN,agy=process.env.AGY_PATH
if(!state||!token||!agy||!process.env.HTTPS_PROXY)throw Error('Set isolated state, bridge token, official AGY path and process-specific proxy')
const port=Number(process.env.AGY_CC_PORT||3437)
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid independent port')
fs.mkdirSync(state,{recursive:true,mode:0o700})
const workspace=path.join(state,'workspace');fs.mkdirSync(workspace,{recursive:true,mode:0o700})
const carrierEnv={...process.env}
delete carrierEnv.AGY_CC_TOKEN
const carrier=new CliCarrier({agy,workspace,env:carrierEnv})
const controlToken=randomBytes(32).toString('hex')
// Known provider refusal protection is unconditional. Neither an HTTP field
// nor a legacy environment diagnostic switch may disable it.
const broker=new MitmBroker({token:controlToken,storeDir:path.join(state,'wire'),drive:carrier.run,preflight:assertForwardableSystem})
const controlPort=await broker.listen()
fs.writeFileSync(path.join(state,'control.json'),JSON.stringify({port:controlPort,token:controlToken}),{mode:0o600})
const http=createCcServer({fetchMessages:broker.fetch,cancelSession:broker.cancelSession,resolveMessage:broker.resolveMessage,listModels:createModelProvider({agy,workspace,env:carrierEnv}),stateDir:path.join(state,'journal'),token,upstreamTransport:'mitm-no-mcp',statelessRequests:true})
http.server.listen(port,'127.0.0.1',()=>process.stderr.write(`Anthropic-compatible gateway on 127.0.0.1:${port}\n`))
let closing=false
async function close(){if(closing)return;closing=true;await http.close();carrier.stop();await broker.close()}
process.once('SIGTERM',()=>close().then(()=>process.exit(0)))
process.once('SIGINT',()=>close().then(()=>process.exit(0)))
