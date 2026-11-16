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
    const config=JSON.parse(fs.readFileSync(configPath,'utf8'))
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
  env(base){
    const env={...base,HOME:this.current().home}
    for(const key of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME'])delete env[key]
    return env
  }
}
