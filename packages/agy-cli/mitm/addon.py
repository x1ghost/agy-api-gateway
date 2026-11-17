"""Private AGY transport for the Magpie provider; no standalone gateway."""
import asyncio, base64, json, os, re, socket, urllib.request, urllib.error
from pathlib import Path
from mitmproxy import http

STATE=Path(os.environ['AGY_MITM_STATE_DIR'])
FIXTURES=Path(os.environ['AGY_MITM_FIXTURE_DIR']) if os.environ.get('AGY_MITM_FIXTURE_DIR') else None
ALLOW=os.environ.get('AGY_MITM_ALLOW_MODEL_FORWARD')=='1'
HOST='daily-cloudcode-pa.googleapis.com'
BOOTSTRAP={'www.googleapis.com','oauth2.googleapis.com','accounts.google.com',HOST,'lh3.googleusercontent.com','aicode.googleapis.com','www.gstatic.com','play.googleapis.com'}
MODEL_PATH=re.compile(r'generatecontent|streamgenerate|generatemessage|generatechat|/chat/completions|/messages$',re.I)
MARKER=re.compile(r'AGY_CC_CARRIER_([a-f0-9]{32})')
ACK='AGY_CC_CARRIER_ACK'
def ack():
 return ('data: '+json.dumps({'response':{'candidates':[{'index':0,'content':{'role':'model','parts':[{'text':ACK}]},'finishReason':'STOP'}],'usageMetadata':{'promptTokenCount':1,'candidatesTokenCount':1,'totalTokenCount':2}}})+'\n\n').encode()
def control(endpoint,data):
 c=json.loads((STATE/'control.json').read_text())
 req=urllib.request.Request('http://127.0.0.1:'+str(c['port'])+endpoint,json.dumps(data).encode(),{'Authorization':'Bearer '+c['token'],'Content-Type':'application/json'},method='POST')
 with urllib.request.urlopen(req,timeout=20) as response:return json.load(response)
async def send(endpoint,data):return await asyncio.to_thread(control,endpoint,data)

class Bridge:
 def __init__(self):self.serial=0
 def running(self):(STATE/'proxy-ready').write_text('ready')
 async def server_connect(self,data):
  host,port=data.server.address
  if host not in BOOTSTRAP:data.server.error='Unapproved carrier destination';return
  addresses=await asyncio.get_running_loop().getaddrinfo(host,port,family=socket.AF_INET,type=socket.SOCK_STREAM)
  data.server.address=(addresses[0][4][0],port)
  if not data.server.sni:data.server.sni=host
 async def request(self,flow):
  route=flow.request.path.split('?',1)[0]
  if not MODEL_PATH.search(route):
   if flow.request.host not in BOOTSTRAP:flow.response=http.Response.make(403,b'Unapproved carrier destination')
   return
  try:
   if flow.request.host!=HOST or route!='/v1internal:streamGenerateContent':raise ValueError('Unsupported generation route')
   payload=json.loads(flow.request.content);req=payload.get('request',{})
   markers=MARKER.findall(json.dumps(req.get('contents',[])))
   title=(payload.get('requestType')=='checkpoint' and payload.get('model')=='gemini-3.5-flash-lite'
          and 'You are a conversation title generator.' in json.dumps(req.get('systemInstruction',{})) and markers)
   if title:
    if FIXTURES:
     value={'response':{'candidates':[{'index':0,'content':{'role':'model','parts':[{'text':'Carrier Session'}]},'finishReason':'STOP'}]}}
     flow.response=http.Response.make(200,('data: '+json.dumps(value)+'\n\n').encode(),{'content-type':'text/event-stream'})
    elif not ALLOW:raise ValueError('Model forwarding disabled')
    return
   if not markers:raise ValueError('Unmarked generation')
   ticket=markers[-1];claim=await send('/claim',{'ticket':ticket,'envelope':payload})
   flow.metadata['ticket']=ticket
   flow.request.content=json.dumps(claim['payload'],ensure_ascii=False,separators=(',',':')).encode()
   flow.request.headers['accept-encoding']='identity'
   if FIXTURES:
    self.serial+=1;fixture=FIXTURES/(str(self.serial)+'.json')
    spec=json.loads(fixture.read_text())
    await send('/event',{'ticket':ticket,'kind':'headers','status':spec.get('status',200)})
    if spec.get('status',200)==200:
     for frame in spec['events']:
      chunk=('data: '+json.dumps(frame)+'\n\n').encode()
      await send('/event',{'ticket':ticket,'kind':'chunk','data':base64.b64encode(chunk).decode()})
     await send('/event',{'ticket':ticket,'kind':'end'})
    flow.metadata['fixture']=True
    flow.response=http.Response.make(200,ack(),{'content-type':'text/event-stream'})
   elif not ALLOW:raise ValueError('Model forwarding disabled')
  except Exception:
   ticket=flow.metadata.get('ticket')
   if ticket:
    try:await send('/event',{'ticket':ticket,'kind':'error'})
    except Exception:pass
   flow.metadata['blocked']=True
   flow.response=http.Response.make(403,b'AGY plugin could not route this request',{'x-should-retry':'false'})
 def responseheaders(self,flow):
  if not flow.metadata.get('ticket') or flow.metadata.get('fixture') or flow.metadata.get('blocked'):return
  ticket=flow.metadata['ticket'];status=flow.response.status_code;retry=flow.response.headers.get('retry-after','')
  flow.response.status_code=200
  for name in ['content-length','content-encoding','transfer-encoding']:flow.response.headers.pop(name,None)
  flow.response.headers['content-type']='text/event-stream'
  queue=asyncio.Queue();flow.metadata['queue']=queue;flow.metadata['size']=0
  async def worker():
   try:
    if status!=200:
     error=bytearray()
     while True:
      chunk=await queue.get()
      if chunk is None:break
      if isinstance(chunk,Exception):raise chunk
      if len(error)<16384:error.extend(chunk[:16384-len(error)])
     await send('/event',{'ticket':ticket,'kind':'headers','status':status,'error_body':base64.b64encode(error).decode(),'retry_after':retry[:128]})
    else:
     await send('/event',{'ticket':ticket,'kind':'headers','status':status})
     while True:
      chunk=await queue.get()
      if chunk is None:break
      if isinstance(chunk,Exception):raise chunk
      await send('/event',{'ticket':ticket,'kind':'chunk','data':base64.b64encode(chunk).decode()})
     await send('/event',{'ticket':ticket,'kind':'end'})
    flow.metadata['complete']=True
   except Exception:
    try:await send('/event',{'ticket':ticket,'kind':'error'})
    except Exception:pass
  flow.metadata['worker']=asyncio.create_task(worker())
  def intercept(chunk):
   if chunk:
    flow.metadata['size']+=len(chunk)
    if flow.metadata['size']>32*1024*1024:queue.put_nowait(ValueError('Response too large'))
    else:queue.put_nowait(bytes(chunk))
    return b''
   queue.put_nowait(None);return ack()
  flow.response.stream=intercept
 async def response(self,flow):
  task=flow.metadata.get('worker')
  if task:await task
 async def error(self,flow):
  task=flow.metadata.get('worker')
  if task:task.cancel()
  ticket=flow.metadata.get('ticket')
  if ticket and not flow.metadata.get('complete'):
   try:await send('/event',{'ticket':ticket,'kind':'error'})
   except Exception:pass
addons=[Bridge()]
