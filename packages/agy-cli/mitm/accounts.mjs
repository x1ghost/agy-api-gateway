// Explicit account selection for one gateway. AGY still owns credentials.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(id)
export class Accounts {
  constructor(configPath,state) {
    if(!path.isAbsolute(configPath))throw Error('AGY_ACCOUNTS_CONFIG must be an absolute path')
    const stat=fs.lstatSync(configPath)
    if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||stat.mode&0o077)throw Error('Account config must be a private regular file owned by this user')
    this.configPath=configPath;this.state=state;this.adding=false
    const config=JSON.parse(fs.readFileSync(configPath,'utf8'));this.config=config
    if(!Array.isArray(config.accounts)||!config.accounts.length)throw Error('At least one account is required')
    this.accounts=new Map();const homes=new Set()
    for(const account of config.accounts) {
      if(!validId(account?.id)||this.accounts.has(account.id)||typeof account.home!=='string'||!path.isAbsolute(account.home))throw Error('Invalid account ID or HOME')
      const dir=fs.lstatSync(account.home)
      if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid()||dir.mode&0o077)throw Error('Account HOME must be a private directory owned by the gateway user')
      const home=fs.realpathSync(account.home)
      if(homes.has(home))throw Error('Each account must have a distinct HOME')
      homes.add(home);this.accounts.set(account.id,{id:account.id,home})
    }
    this.file=path.join(state,'selected-account.json')
    let selected
    try {selected=JSON.parse(fs.readFileSync(this.file,'utf8')).id} catch(error) {if(error.code!=='ENOENT')throw Error('Invalid selected account state')}
    this.id=selected??config.accounts[0].id
    if(!this.accounts.has(this.id))throw Error('Selected account is not configured')
  }
  list(){return {accounts:[...this.accounts.keys()],active:this.id}}
  current(){return this.accounts.get(this.id)}
  select(id) {
    if(!this.accounts.has(id))throw Object.assign(Error('Unknown account'),{status:400})
    const temp=this.file+'.'+randomUUID()+'.tmp'
    try {fs.writeFileSync(temp,JSON.stringify({id}),{mode:0o600,flag:'wx'});fs.renameSync(temp,this.file)}
    finally {fs.rmSync(temp,{force:true})}
    this.id=id
    return this.list()
  }
  async add(id,refreshToken,validate) {
    if(!validId(id)||typeof refreshToken!=='string'||!refreshToken.trim()||refreshToken.length>8192||/[\r\n\0]/.test(refreshToken))throw Object.assign(Error('Invalid account ID or refresh token'),{status:400})
    if(this.accounts.has(id))throw Object.assign(Error('Account already exists'),{status:409})
    if(this.adding)throw Object.assign(Error('An account is already being added'),{status:409})
    this.adding=true
    const root=path.join(this.state,'account-homes'),home=path.join(root,id)
    let created=false,temp
    try {
      fs.mkdirSync(root,{mode:0o700,recursive:true})
      const rootStat=fs.lstatSync(root)
      if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||rootStat.uid!==process.getuid()||rootStat.mode&0o077)throw Error('Account homes directory must be private')
      try {fs.mkdirSync(home,{mode:0o700});created=true}
      catch(error){if(error.code==='EEXIST')throw Object.assign(Error('Account HOME already exists'),{status:409});throw error}
      const credentialDir=path.join(home,'.gemini','antigravity-cli');fs.mkdirSync(credentialDir,{mode:0o700,recursive:true})
      const credential={token:{access_token:'',token_type:'Bearer',refresh_token:refreshToken,expiry:'1970-01-01T00:00:00Z',expires_in:0},auth_method:'consumer',id_token_email:''}
      fs.writeFileSync(path.join(credentialDir,'antigravity-oauth-token'),JSON.stringify(credential),{mode:0o600,flag:'wx'})
      await validate({id,home})
      const config={...this.config,accounts:[...this.config.accounts,{id,home}]}
      temp=this.configPath+'.'+randomUUID()+'.tmp'
      fs.writeFileSync(temp,JSON.stringify(config),{mode:0o600,flag:'wx'});fs.renameSync(temp,this.configPath);temp=null
      this.config=config;this.accounts.set(id,{id,home});created=false
      return this.list()
    } finally {
      if(temp)fs.rmSync(temp,{force:true})
      if(created)fs.rmSync(home,{recursive:true,force:true})
      this.adding=false
    }
  }
  envFor(base,account){
    const env={...base,HOME:account.home}
    for(const key of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME'])delete env[key]
    return env
  }
  env(base){
    return this.envFor(base,this.current())
  }
}
