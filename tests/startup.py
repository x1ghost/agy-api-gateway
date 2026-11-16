#!/usr/bin/env python3
"""Local process integration: real proxy, fake CLI, no model requests."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

with tempfile.TemporaryDirectory() as directory:
    gateway_port, proxy_port = port(), port()
    while proxy_port == gateway_port:
        proxy_port = port()
    env = os.environ.copy()
    env.update(AGY_CC_TOKEN='a' * 64, AGY_MITM_STATE_DIR=directory,
               AGY_PATH='/usr/bin/true', AGY_CC_PORT=str(gateway_port),
               AGY_MITM_PROXY_PORT=str(proxy_port))
    child = subprocess.Popen([sys.executable, str(ROOT / 'gateway.py')], env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError('Gateway exited: ' + child.stderr.read().decode())
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{gateway_port}/health', timeout=1) as response:
                    health = json.load(response)
                assert health['transport'] == 'mitm-no-mcp'
                break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('Health check timed out')
        assert (Path(directory) / 'trust.pem').exists()
        assert json.loads((Path(directory) / 'proxy-summary.json').read_text())['forwarded'] == 0
    finally:
        child.send_signal(signal.SIGTERM)
        child.wait(timeout=15)
    assert child.returncode == 0
print('Portable startup and shutdown passed; zero model requests')
