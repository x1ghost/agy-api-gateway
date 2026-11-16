"""Experimental official-CLI MITM: CC owns model inputs and tools. No MCP.
Default denies ALL model forwarding. Optional offline fixtures never contact
model endpoints. This addon never obtains or stores authentication credentials.
"""
import asyncio, base64, json, math, os, re, shutil, socket, time, uuid, urllib.request, urllib.error
from pathlib import Path
from mitmproxy import http
STATE=Path(os.environ['AGY_MITM_STATE_DIR'])
FIXTURES=Path(os.environ['AGY_MITM_FIXTURE_DIR']) if os.environ.get('AGY_MITM_FIXTURE_DIR') else None
ALLOW=os.environ.get('AGY_MITM_ALLOW_MODEL_FORWARD')=='1'
MIN_INTERVAL=max(0,float(os.environ.get('AGY_MITM_MIN_INTERVAL_SECONDS','0')))
CAPTURE=Path(os.environ['AGY_MITM_CAPTURE_DIR']) if os.environ.get('AGY_MITM_CAPTURE_DIR') else None
HOST='daily-cloudcode-pa.googleapis.com'
ACK='AGY_CC_CARRIER_ACK'
BOOTSTRAP={'www.googleapis.com','oauth2.googleapis.com','accounts.google.com',HOST,'lh3.googleusercontent.com','aicode.googleapis.com','www.gstatic.com','play.googleapis.com'}
MODEL_PATH=re.compile(r'generatecontent|streamgenerate|generatemessage|generatechat|/chat/completions|/messages$',re.I)
def ack():
 return ('data: '+json.dumps({'response':{'candidates':[{'index':0,'content':{'role':'model','parts':[{'text':ACK}]},'finishReason':'STOP'}],'usageMetadata':{'promptTokenCount':1,'candidatesTokenCount':1,'totalTokenCount':2}}})+'\n\n').encode()
class TicketCancelled(Exception):pass
def control(endpoint,data):
 c=json.loads((STATE/'control.json').read_text())
 r=urllib.request.Request('http://127.0.0.1:'+str(c['port'])+endpoint,json.dumps(data).encode(),{'Authorization':'Bearer '+c['token'],'Content-Type':'application/json'},method='POST')
 try:
  with urllib.request.urlopen(r,timeout=20) as response:return json.load(response)
 except urllib.error.HTTPError as e:
  if e.code==410:
   try:value=json.loads(e.read())
   except Exception:value={}
   if value.get('code')=='ticket_cancelled':raise TicketCancelled('CC cancelled this ticket') from None
  raise
async def send(endpoint,data):return await asyncio.to_thread(control,endpoint,data)
class Bridge:
 def __init__(self,state=STATE):
  self.state=state
  self.counts={'forwarded':0,'fixtures':0,'blockedGenerations':0,'controlErrors':0,'upstream429':0,'statuses':[],'cancelledTickets':0}
  self.serial=0;self.refused=False;self.last_forward=0;self.last_forward_at=0;self.inflight=set();self.acknowledged_status_count=0;self.forward_lock=asyncio.Lock()
  state_file=self.state/'proxy-state.json'
  if state_file.exists():
   try:
    saved=json.loads(state_file.read_text());counts=saved['counts']
    if saved['version'] not in (1,2) or set(counts)!=set(self.counts):raise ValueError('Invalid state schema')
    if any(type(counts[k]) is not int or counts[k]<0 for k in counts if k!='statuses'):raise ValueError('Invalid counters')
    if not isinstance(counts['statuses'],list) or len(counts['statuses'])>counts['forwarded'] or any(type(x) is not int or not 100<=x<=599 for x in counts['statuses']):raise ValueError('Invalid statuses')
    if type(saved['serial']) is not int or saved['serial']<0 or type(saved['refused']) is not bool:raise ValueError('Invalid gate state')
    pending=saved['inflight'];stamp=saved['lastForwardAt'];ack=saved.get('acknowledgedStatusCount',0)
    if type(ack) is not int or not 0<=ack<=len(counts['statuses']):raise ValueError('Invalid acknowledged status count')
    if not isinstance(pending,list) or any(type(x) is not int or not 1<=x<=counts['forwarded'] for x in pending) or len(set(pending))!=len(pending):raise ValueError('Invalid reservations')
    if type(stamp) not in [int,float] or not math.isfinite(stamp) or stamp<0:raise ValueError('Invalid rate timestamp')
    if counts['forwarded'] and not stamp:raise ValueError('Missing forward reservation')
    self.counts=counts;self.serial=saved['serial'];self.inflight=set(pending);self.last_forward_at=stamp;self.acknowledged_status_count=ack
    # v1 conflated upstream 429 with uncertain failures. Clear only a fully
    # accounted 429-only stop; preserve all ambiguous or other failure states.
    legacy_429_only=(saved['version']==1 and saved['refused'] and counts['upstream429']>0
                     and counts['controlErrors']==0 and not pending
                     and len(counts['statuses'])==counts['forwarded']
                     and all(x<400 or x==429 for x in counts['statuses']))
    self.refused=(saved['refused'] and not legacy_429_only) or bool(pending) or bool(counts['controlErrors']) or any(x>=400 and x!=429 for x in counts['statuses'][ack:])
    if stamp:self.last_forward=time.monotonic()-max(0,time.time()-stamp)
   except Exception as e:raise RuntimeError('Invalid durable proxy state; use an explicitly new experiment scope, never reset silently') from e
  elif (self.state/'proxy-summary.json').exists():
   raise RuntimeError('Legacy proxy scope has no durable gate state; explicit new scope required')
 def settled(self,flow):
  self.inflight.discard(flow.metadata.get('capture_index'));self.report()
 def cancelled(self,flow):
  if not flow.metadata.get('cancelled'):
   flow.metadata['cancelled']=True;self.counts['cancelledTickets']+=1;self.settled(flow)
 async def active(self,ticket):
  status=await send('/status',{'ticket':ticket})
  if status.get('state')=='cancelled':raise TicketCancelled('CC cancelled this ticket')
  if status.get('state')!='active':raise ValueError('Ticket no longer active')
 def atomic(self,name,value):
  self.state.mkdir(parents=True,exist_ok=True,mode=0o700)
  target=self.state/name;tmp=self.state/(name+'.'+uuid.uuid4().hex+'.tmp')
  try:
   fd=os.open(tmp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
   with os.fdopen(fd,'w') as out:json.dump(value,out);out.flush();os.fsync(out.fileno())
   os.replace(tmp,target)
   directory=os.open(self.state,os.O_RDONLY)
   try:os.fsync(directory)
   finally:os.close(directory)
  finally:tmp.unlink(missing_ok=True)
 def report(self):
  try:
   self.atomic('proxy-state.json',{'version':2,'counts':self.counts,'serial':self.serial,'refused':self.refused,'inflight':sorted(self.inflight),'lastForwardAt':self.last_forward_at,'acknowledgedStatusCount':self.acknowledged_status_count})
   self.atomic('proxy-summary.json',self.counts)
  except Exception:
   self.refused=True
   raise
 def running(self):self.report();(STATE/'proxy-ready').write_text('ready')
 async def server_connect(self,data):
  host,port=data.server.address
  if host not in BOOTSTRAP:data.server.error='Unapproved carrier destination';return
  addresses=await asyncio.get_running_loop().getaddrinfo(host,port,family=socket.AF_INET,type=socket.SOCK_STREAM)
  data.server.address=(addresses[0][4][0],port)
  if not data.server.sni:data.server.sni=host
 async def request(self,flow):
  p=flow.request.path.split('?',1)[0]
  if not MODEL_PATH.search(p):
   if flow.request.host not in BOOTSTRAP:flow.response=http.Response.make(403,b'Unapproved carrier destination')
   return
  flow.metadata['model']=True
  try:
   if flow.request.host!=HOST or p!='/v1internal:streamGenerateContent':raise ValueError('Unsupported generation route')
   payload=json.loads(flow.request.content)
   # Search newest contents first. Old marker strings in CLI carrier history
   # never get another forwarding permit after the ticket has been claimed.
   found=re.findall(r'AGY_CC_CARRIER_([a-f0-9]{32})',json.dumps(payload.get('request',{}).get('contents',[])))
   if not found:raise ValueError('Unmarked/auxiliary generation')
   ticket=found[-1];claim=await send('/claim',{'ticket':ticket,'envelope':payload})
   flow.metadata['ticket']=ticket
   flow.request.content=json.dumps(claim['payload'],ensure_ascii=False,separators=(',',':')).encode()
   flow.request.headers['accept-encoding']='identity'
   if FIXTURES:
    self.serial+=1;fixture=FIXTURES/(str(self.serial)+'.json')
    if not fixture.exists():raise ValueError('Offline fixture budget exhausted')
    spec=json.loads(fixture.read_text());self.counts['fixtures']+=1
    # Synthetic CC input/output only. Never persist headers or login responses.
    (STATE/f'rewrite-{self.serial}.json').write_text(json.dumps(claim['payload'],ensure_ascii=False))
    await send('/event',{'ticket':ticket,'kind':'headers','status':spec.get('status',200)})
    if spec.get('status',200)==200:
     for frame in spec['events']:
      chunk=('data: '+json.dumps(frame)+'\n\n').encode()
      await send('/event',{'ticket':ticket,'kind':'chunk','data':base64.b64encode(chunk).decode()})
      await asyncio.sleep(.04)
     await send('/event',{'ticket':ticket,'kind':'end'})
    flow.metadata['fixture']=True
    flow.response=http.Response.make(200,ack(),{'content-type':'text/event-stream'})
   elif not ALLOW:raise ValueError('Model forwarding disabled')
   else:
    async with self.forward_lock:
     if self.refused:raise ValueError('Live refusal gate')
     if MIN_INTERVAL and self.last_forward:
      await asyncio.sleep(max(0,MIN_INTERVAL-(time.monotonic()-self.last_forward)))
     if self.refused:raise ValueError('Previous refusal')
     await self.active(ticket) # Recheck after the rate-limit wait, immediately before forwarding.
     if self.refused:raise ValueError('Gate changed while checking ticket')
     self.counts['forwarded']+=1;self.last_forward=time.monotonic();self.last_forward_at=time.time();self.inflight.add(self.counts['forwarded'])
     flow.metadata['capture_index']=self.counts['forwarded']
     flow.metadata['forwarded_at']=time.monotonic()
     if CAPTURE:
      CAPTURE.mkdir(parents=True,exist_ok=True,mode=0o700)
      (CAPTURE/f"model-{self.counts['forwarded']:02d}-request.json").write_text(json.dumps(claim['payload'],ensure_ascii=False))
  except TicketCancelled:
   self.cancelled(flow);flow.metadata['blocked']=True
   flow.response=http.Response.make(499,b'CC cancelled this generation; nothing forwarded.',{'x-should-retry':'false'})
  except Exception:
   if flow.metadata.get('capture_index'):self.refused=True # A reserved forward failed before release (for example capture I/O).
   self.counts['blockedGenerations']+=1
   flow.metadata['blocked']=True
   # No model response, tool success or model text is invented for CC.
   if flow.metadata.get('ticket'):
    try:await send('/event',{'ticket':flow.metadata['ticket'],'kind':'error'})
    except Exception:pass
   flow.response=http.Response.make(403,b'Local MITM gate refused this generation; nothing forwarded.',{'x-should-retry':'false'})
  try:self.report() # Durable reservation before returning control to the network.
  except Exception:
   flow.metadata['blocked']=True;flow.response=http.Response.make(403,b'Local durable gate unavailable; nothing forwarded.',{'x-should-retry':'false'})
   if flow.metadata.get('ticket'):
    try:await send('/event',{'ticket':flow.metadata['ticket'],'kind':'error'})
    except Exception:pass
 def responseheaders(self,flow):
  if not flow.metadata.get('ticket') or flow.metadata.get('fixture') or flow.metadata.get('blocked'):return
  ticket=flow.metadata['ticket'];status=flow.response.status_code;original_encoding=flow.response.headers.get('content-encoding','');original_type=flow.response.headers.get('content-type','');retry_after=flow.response.headers.get('retry-after','')
  # Install the ACK-only filter before fallible persistence/capture operations.
  flow.response.status_code=200
  for h in ['content-length','content-encoding','transfer-encoding']:flow.response.headers.pop(h,None)
  flow.response.headers['content-type']='text/event-stream'
  flow.response.stream=lambda chunk:b'' if chunk else ack()
  self.counts['statuses'].append(status)
  if status>=400 and status!=429:self.refused=True
  if status==429:self.counts['upstream429']+=1
  try:
   self.report()
   if CAPTURE and flow.metadata.get('capture_index'):
    (CAPTURE/f"model-{flow.metadata['capture_index']:02d}-response-meta.json").write_text(json.dumps({'status':status,'contentType':original_type,'contentEncoding':original_encoding,'responseHeaders':{k:flow.response.headers[k] for k in ['retry-after','x-request-id','x-goog-request-id','grpc-status','grpc-message','server','date'] if k in flow.response.headers},'headersAfterForwardMs':round((time.monotonic()-flow.metadata.get('forwarded_at',time.monotonic()))*1000)}))
  except Exception:
   self.refused=True;self.counts['controlErrors']+=1
   async def notify_failure():
    try:await send('/event',{'ticket':ticket,'kind':'error'})
    except Exception:pass
    try:self.report()
    except Exception:pass
   flow.metadata['worker']=asyncio.create_task(notify_failure());return
  q=asyncio.Queue();flow.metadata['queue']=q;flow.metadata['size']=0
  async def worker():
   try:
    if status!=200:
     error_body=bytearray()
     while True:
      chunk=await q.get()
      if chunk is None:break
      if isinstance(chunk,Exception):raise chunk
      if len(error_body)<16384:error_body.extend(chunk[:16384-len(error_body)])
     await send('/event',{'ticket':ticket,'kind':'headers','status':status,
                          'error_body':base64.b64encode(error_body).decode(),'retry_after':retry_after[:128]})
     flow.metadata['control_complete']=True;self.settled(flow);return
    await send('/event',{'ticket':ticket,'kind':'headers','status':status})
    while True:
     chunk=await q.get()
     if chunk is None:break
     if isinstance(chunk,Exception):raise chunk
     await send('/event',{'ticket':ticket,'kind':'chunk','data':base64.b64encode(chunk).decode()})
    await send('/event',{'ticket':ticket,'kind':'end'})
    flow.metadata['control_complete']=True;self.settled(flow)
   except TicketCancelled:
    self.cancelled(flow)
    if flow.killable:flow.kill()
   except Exception:
    self.counts['controlErrors']+=1;self.refused=True # Stop new CC/CLI retries after a local protocol failure.
    try:await send('/event',{'ticket':ticket,'kind':'error'})
    except Exception:pass
    self.report()
  flow.metadata['worker']=asyncio.create_task(worker())
  # Hide actual model calls from CLI entirely. It only receives a local carrier
  # acknowledgement, never a synthesized CC answer. CC gets the original SSE.
  flow.response.status_code=200
  for h in ['content-length','content-encoding','transfer-encoding']:flow.response.headers.pop(h,None)
  flow.response.headers['content-type']='text/event-stream'
  def intercept(chunk):
   if chunk:
    if flow.metadata.get('stream_failed'):return b''
    try:
     flow.metadata['size']+=len(chunk)
     if flow.metadata['size']>32*1024*1024:raise ValueError('Response exceeds limit')
     if CAPTURE and flow.metadata.get('capture_index') and flow.metadata['size']<=4*1024*1024:
      with open(CAPTURE/f"model-{flow.metadata['capture_index']:02d}-response.bin",'ab') as capture:capture.write(chunk)
     q.put_nowait(bytes(chunk))
    except Exception:
     self.refused=True;flow.metadata['stream_failed']=True;q.put_nowait(RuntimeError('Response interception failed'))
    return b''
   q.put_nowait(None);return ack()
  flow.response.stream=intercept
 async def response(self,flow):
  task=flow.metadata.get('worker')
  if task:await task
 async def error(self,flow):
  task=flow.metadata.get('worker')
  if task:task.cancel()
  ticket=flow.metadata.get('ticket')
  if not ticket or flow.metadata.get('cancelled') or flow.metadata.get('control_complete'):return
  try:
   status=await send('/status',{'ticket':ticket})
   if status.get('state')=='cancelled':self.cancelled(flow);return
   if status.get('state')=='complete':self.settled(flow);return
  except Exception:pass
  # A network/control failure is not evidence of deliberate cancellation.
  self.refused=True;self.counts['controlErrors']+=1;self.report()
  try:await send('/event',{'ticket':ticket,'kind':'error'})
  except Exception:pass
 def done(self):self.report()
class AccountBridge:
 # Per-account durable forwarding state; control and proxy remain shared.
 def __init__(self,config_path):
  self.config_path=Path(config_path);self.accounts={}
  self.load_accounts()
  self.root=STATE/'account-proxy';self.bridges={}
  # Preserve the existing single-account gate when account mode is enabled.
  if (STATE/'proxy-state.json').exists() and not self.root.exists():
   matches=[name for name,home in self.accounts.items() if os.path.realpath(home)==os.path.realpath(os.environ.get('HOME',''))]
   if len(matches)!=1:raise RuntimeError('Configure the current HOME exactly once to preserve existing proxy state')
   temp=STATE/('.account-proxy-'+uuid.uuid4().hex+'.tmp')
   try:
    target=temp/matches[0];target.mkdir(parents=True,mode=0o700)
    for name in ('proxy-state.json','proxy-summary.json'):
     source=STATE/name
     if source.exists():shutil.copy2(source,target/name)
    os.rename(temp,self.root)
   finally:
    if temp.exists():shutil.rmtree(temp)
  self.default=next(iter(self.accounts))
 def load_accounts(self):
  config=json.loads(self.config_path.read_text())
  accounts={}
  for account in config.get('accounts',[]):
   name=account.get('id');home=account.get('home')
   if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',name) or name in accounts or not isinstance(home,str) or not os.path.isabs(home):raise RuntimeError('Invalid account config')
   accounts[name]=home
  if not accounts:raise RuntimeError('At least one account is required')
  self.accounts=accounts
 def selected(self):
  try:name=json.loads((STATE/'selected-account.json').read_text())['id']
  except FileNotFoundError:name=self.default
  if name not in self.accounts:self.load_accounts()
  if name not in self.accounts:raise RuntimeError('Selected account is not configured')
  return name
 def bridge(self):
  name=self.selected()
  if name not in self.bridges:self.bridges[name]=Bridge(self.root/name)
  return self.bridges[name]
 def running(self):self.bridge().report();(STATE/'proxy-ready').write_text('ready')
 async def server_connect(self,data):await self.bridge().server_connect(data)
 async def request(self,flow):
  bridge=self.bridge();flow.metadata['account_bridge']=bridge
  await bridge.request(flow)
 def responseheaders(self,flow):
  if flow.metadata.get('account_bridge'):flow.metadata['account_bridge'].responseheaders(flow)
 async def response(self,flow):
  if flow.metadata.get('account_bridge'):await flow.metadata['account_bridge'].response(flow)
 async def error(self,flow):
  if flow.metadata.get('account_bridge'):await flow.metadata['account_bridge'].error(flow)
 def done(self):
  for bridge in self.bridges.values():bridge.report()

addons=[AccountBridge(os.environ['AGY_ACCOUNTS_CONFIG']) if os.environ.get('AGY_ACCOUNTS_CONFIG') else Bridge()]
