"""Offline regression for upstream 429 and durable state migration."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    os.environ['AGY_MITM_STATE_DIR'] = directory
    sys.modules['mitmproxy'] = types.SimpleNamespace(http=types.SimpleNamespace())
    spec = importlib.util.spec_from_file_location('gateway_addon', root/'packages/agy-cli/mitm/addon.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    state = Path(directory)/'proxy-state.json'
    counts = {'forwarded':1,'fixtures':0,'blockedGenerations':0,'controlErrors':0,
              'upstream429':1,'statuses':[429],'cancelledTickets':0}
    saved = {'version':1,'counts':counts,'serial':0,'refused':True,'inflight':[],
             'budget':128,'lastForwardAt':1}
    state.write_text(json.dumps(saved))
    bridge = module.Bridge()
    assert not bridge.refused and not hasattr(bridge,'budget')
    bridge.report()
    assert json.loads(state.read_text())['version'] == 2
    assert 'budget' not in json.loads(state.read_text())
    assert not module.Bridge().refused
    exhausted = dict(saved, counts=dict(counts, forwarded=129, statuses=[200]*129, upstream429=0), refused=False)
    state.write_text(json.dumps(exhausted))
    assert not module.Bridge().refused and module.Bridge().counts['forwarded'] == 129
    saved['inflight'] = [1]
    state.write_text(json.dumps(saved))
    assert module.Bridge().refused
    saved['inflight'] = []
    saved['counts']['controlErrors'] = 1
    state.write_text(json.dumps(saved))
    assert module.Bridge().refused
    saved['counts']['controlErrors'] = 0
    saved['counts']['statuses'] = [500]
    state.write_text(json.dumps(saved))
    assert module.Bridge().refused
    saved['acknowledgedStatusCount'] = 1
    saved['refused'] = False
    state.write_text(json.dumps(saved))
    acknowledged = module.Bridge()
    assert not acknowledged.refused and acknowledged.counts['statuses'] == [500]
    acknowledged.report()
    assert not module.Bridge().refused
    state.unlink()
    (Path(directory)/'proxy-summary.json').unlink()
    bridge = module.Bridge()
    bridge.counts['forwarded'] = 1
    bridge.last_forward_at = 1
    bridge.inflight.add(1)
    flow = types.SimpleNamespace(metadata={'ticket':'synthetic','capture_index':1},
        response=types.SimpleNamespace(status_code=429, headers={}, stream=None))
    events = []
    async def fake_send(*args):
        events.append(args)
        return {}
    module.send = fake_send
    async def check():
        bridge.responseheaders(flow)
        assert flow.response.stream(b'{"error":{"message":"synthetic quota"}}') == b''
        assert b'AGY_CC_CARRIER_ACK' in flow.response.stream(b'')
        await flow.metadata['worker']
        event = events[0][1]
        import base64
        assert json.loads(base64.b64decode(event['error_body']))['error']['message'] == 'synthetic quota'
        assert bridge.counts['upstream429'] == 1 and not bridge.refused
        assert not module.Bridge().refused
    asyncio.run(check())
    # Account mode preserves the old gate for the current HOME and keeps a
    # refusal on one account from stopping another, including after restart.
    asyncio.set_event_loop(asyncio.new_event_loop())
    with tempfile.TemporaryDirectory() as isolated:
        original_state = module.STATE
        original_home = os.environ.get('HOME')
        try:
            module.STATE = Path(isolated)
            home_a = Path(isolated)/'home-a'; home_b = Path(isolated)/'home-b'
            home_a.mkdir(); home_b.mkdir(); os.environ['HOME'] = str(home_a)
            config = Path(isolated)/'accounts.json'
            config.write_text(json.dumps({'accounts':[{'id':'a','home':str(home_a)},{'id':'b','home':str(home_b)}]}))
            legacy = module.Bridge(module.STATE); legacy.counts['forwarded'] = 1
            legacy.counts['statuses'] = [403]; legacy.last_forward_at = 1
            legacy.refused = True; legacy.report()
            pool = module.AccountBridge(config)
            assert pool.bridge().refused and pool.bridge().counts['statuses'] == [403]
            (Path(isolated)/'selected-account.json').write_text(json.dumps({'id':'b'}))
            assert not pool.bridge().refused and pool.bridge().counts['forwarded'] == 0
            pool.bridge().report()
            assert not module.AccountBridge(config).bridge().refused
            (Path(isolated)/'selected-account.json').write_text(json.dumps({'id':'a'}))
            assert module.AccountBridge(config).bridge().refused
            config.write_text(json.dumps({'accounts':[{'id':'a','home':str(home_a)},{'id':'b','home':str(home_b)},{'id':'c','home':str(Path(isolated)/'home-c')}]}))
            (Path(isolated)/'selected-account.json').write_text(json.dumps({'id':'c'}))
            assert not pool.bridge().refused
        finally:
            module.STATE = original_state
            if original_home is None: os.environ.pop('HOME',None)
            else: os.environ['HOME'] = original_home
print('429 handling and durable migration passed')
