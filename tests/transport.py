"""Exercise passthrough titles and independent upstream response handling."""
import asyncio, base64, importlib.util, json, os, sys, tempfile, types
from pathlib import Path

with tempfile.TemporaryDirectory() as directory:
    os.environ['AGY_MITM_STATE_DIR'] = directory
    os.environ['AGY_MITM_ALLOW_MODEL_FORWARD'] = '1'
    sys.modules['mitmproxy'] = types.SimpleNamespace(http=types.SimpleNamespace())
    spec=importlib.util.spec_from_file_location('agy_addon',Path(__file__).resolve().parents[1]/'packages/agy-cli/mitm/addon.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    events=[]
    async def send(endpoint,payload):
        events.append((endpoint,payload))
        return {}
    module.send=send
    async def verify():
        bridge=module.Bridge()
        title={'model':'gemini-3.5-flash-lite','requestType':'checkpoint','request':{'systemInstruction':{'parts':[{'text':'You are a conversation title generator.'}]},'contents':[{'role':'user','parts':[{'text':'AGY_CC_CARRIER_'+'a'*32}]}]}}
        raw=json.dumps(title).encode()
        flow=types.SimpleNamespace(metadata={},response=None,request=types.SimpleNamespace(path='/v1internal:streamGenerateContent',host=module.HOST,content=raw))
        await bridge.request(flow)
        assert flow.response is None and flow.request.content==raw and not events
        for code in (429,200):
            flow=types.SimpleNamespace(metadata={'ticket':str(code)},response=types.SimpleNamespace(status_code=code,headers={},stream=None))
            bridge.responseheaders(flow)
            payload=b'{"error":{"message":"synthetic limit"}}' if code==429 else b'data: synthetic\n\n'
            assert flow.response.stream(payload)==b''
            assert b'AGY_CC_CARRIER_ACK' in flow.response.stream(b'')
            await flow.metadata['worker']
        header429=next(v for _,v in events if v.get('ticket')=='429' and v.get('kind')=='headers')
        assert header429['status']==429 and json.loads(base64.b64decode(header429['error_body']))['error']['message']=='synthetic limit'
        assert any(v.get('ticket')=='200' and v.get('kind')=='end' for _,v in events)
    asyncio.run(verify())
print('Magpie transport passed')
