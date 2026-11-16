#!/usr/bin/env python3
"""Start an isolated process-local proxy and an Anthropic-compatible gateway."""
import fcntl
import os
from pathlib import Path
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent

def executable(value):
    found = shutil.which(value)
    if not found:
        raise SystemExit(f'Executable not found: {value}')
    return found

def main():
    token = os.environ.get('AGY_CC_TOKEN', '')
    if len(token) < 32:
        raise SystemExit('Set AGY_CC_TOKEN to a private random token of at least 32 characters')
    state_name = os.environ.get('AGY_MITM_STATE_DIR')
    if not state_name or not Path(state_name).is_absolute():
        raise SystemExit('Set AGY_MITM_STATE_DIR to an absolute, dedicated private directory')
    state = Path(state_name)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    if state.is_symlink() or state.stat().st_uid != os.getuid() or state.stat().st_mode & 0o077:
        raise SystemExit('State directory must be owned by the current user, private and not a symlink')
    lock = open(state / 'gateway.lock', 'a')
    os.chmod(state / 'gateway.lock', 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('Another gateway owns this state directory')
    agy = executable(os.environ.get('AGY_PATH', 'agy'))
    mitmdump = executable(os.environ.get('MITMDUMP_PATH', 'mitmdump'))
    node = executable(os.environ.get('NODE_PATH', 'node'))
    port = int(os.environ.get('AGY_CC_PORT', '3437'))
    proxy_port = int(os.environ.get('AGY_MITM_PROXY_PORT', '3441'))
    budget = int(os.environ.get('AGY_MITM_MAX_FORWARDS', '128'))
    if not 1 <= port <= 65535 or not 1 <= proxy_port <= 65535 or port == proxy_port or budget < 1:
        raise SystemExit('Invalid ports or request budget')
    ca_dir = state / 'ca'
    ca_dir.mkdir(mode=0o700, exist_ok=True)
    ready = state / 'proxy-ready'
    ready.unlink(missing_ok=True)
    env = os.environ.copy()
    env.update(AGY_MITM_STATE_DIR=str(state), AGY_MITM_ALLOW_MODEL_FORWARD='1',
               AGY_MITM_MAX_FORWARDS=str(budget))
    proxy_env = env.copy()
    proxy_env.pop('AGY_CC_TOKEN', None)
    proxy = subprocess.Popen([mitmdump, '--listen-host', '127.0.0.1', '--listen-port', str(proxy_port),
                              '--set', f'confdir={ca_dir}', '--set', 'connection_strategy=lazy',
                              '--set', 'flow_detail=0', '--set', 'termlog_verbosity=error',
                              '-s', str(ROOT / 'packages/agy-cli/mitm/addon.py')], env=proxy_env)
    bridge = None
    stopping = False
    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        cert = ca_dir / 'mitmproxy-ca-cert.pem'
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline and not stopping:
            if proxy.poll() is not None:
                raise RuntimeError('Proxy exited during startup')
            if ready.is_file() and cert.is_file():
                try:
                    with socket.create_connection(('127.0.0.1', proxy_port), timeout=1):
                        break
                except OSError:
                    pass
            time.sleep(.1)
        else:
            raise RuntimeError('Proxy startup timed out')
        system_ca = os.environ.get('AGY_SYSTEM_CA_BUNDLE') or ssl.get_default_verify_paths().cafile
        if not system_ca or not Path(system_ca).is_file():
            raise RuntimeError('System CA bundle unavailable; set AGY_SYSTEM_CA_BUNDLE')
        trust = state / 'trust.pem'
        temporary = state / 'trust.tmp'
        fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as out:
            out.write(Path(system_ca).read_bytes() + b'\n' + cert.read_bytes())
        os.replace(temporary, trust)
        proxy_url = f'http://127.0.0.1:{proxy_port}'
        env.update(AGY_PATH=agy, AGY_CC_PORT=str(port), HTTPS_PROXY=proxy_url, HTTP_PROXY=proxy_url,
                   ALL_PROXY=proxy_url, https_proxy=proxy_url, http_proxy=proxy_url, all_proxy=proxy_url,
                   NO_PROXY='localhost,127.0.0.1', no_proxy='localhost,127.0.0.1',
                   SSL_CERT_FILE=str(trust), NODE_EXTRA_CA_CERTS=str(cert),
                   REQUESTS_CA_BUNDLE=str(trust), GRPC_DEFAULT_SSL_ROOTS_FILE_PATH=str(trust))
        bridge = subprocess.Popen([node, str(ROOT / 'packages/agy-cli/mitm/server.mjs')], env=env)
        while not stopping and bridge.poll() is None and proxy.poll() is None:
            time.sleep(.2)
        if not stopping:
            raise RuntimeError('Gateway or proxy exited unexpectedly')
    finally:
        for process in (bridge, proxy):
            if process and process.poll() is None:
                process.terminate()
        for process in (bridge, proxy):
            if process:
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        ready.unlink(missing_ok=True)
        lock.close()

if __name__ == '__main__':
    main()
