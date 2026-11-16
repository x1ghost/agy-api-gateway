# Multiple accounts with isolated Linux users

Run one ordinary gateway and official AGY CLI per Linux service user. Each user owns its own private HOME, AGY credentials, state directory, API token, gateway port, and proxy port. A separate router exposes one loopback endpoint and selects the backend using the client's API token. The router is optional; a client can instead connect to an individual backend directly.

The current gateway does not sign in or import refresh tokens. Provision the official CLI login for each service user using the CLI's supported workflow or the operator's existing credential provisioning procedure. In one observed AGY CLI installation, credentials were under `$HOME/.gemini/antigravity-cli/antigravity-oauth-token` and `$HOME/.config/antigravity/credential-user-scope`; credential format and refresh behavior are CLI-version dependent and have not been validated by this router. Keep each HOME private and owned by its service user. Never put actual credentials in the repository, a command line, or diagnostics.

## Backends

For each account, create a dedicated non-login Linux system user and run `gateway.py` as that user. Configure distinct values in its private environment file:

```
HOME=/var/lib/agy-account-a
AGY_MITM_STATE_DIR=/var/lib/agy-account-a/gateway-state
AGY_CC_PORT=3511
AGY_MITM_PROXY_PORT=3611
AGY_CC_TOKEN=<backend-token-a>
AGY_PATH=/path/to/official/agy
```

Create the HOME and gateway state with mode 0700, owned by that user; use an environment file with mode 0600. For each additional account use a different service user, HOME, state directory, gateway port, proxy port, and backend token. Each account's official AGY installation must be executable by its service user. Run and monitor each gateway using the host's service manager; do not run the CLI as root. The Gateway itself does not need permission to read other users' HOME directories.

## Router

Create a private JSON configuration file owned by the router's Linux user with mode 0600 (the file must not be a symbolic link). Replace every placeholder with a distinct random token of at least 32 characters; a backend token must match its corresponding `AGY_CC_TOKEN`. Router client tokens must be unique.

```json
{
  "accounts": [
    {"id":"account-a", "client_token":"<client-token-a>", "backend":"http://127.0.0.1:3511", "backend_token":"<backend-token-a>"},
    {"id":"account-b", "client_token":"<client-token-b>", "backend":"http://127.0.0.1:3512", "backend_token":"<backend-token-b>"}
  ]
}
```

Start the router under its own service user, pointing at the config file:

```sh
export AGY_ROUTER_CONFIG=/absolute/path/to/private/router.json
export AGY_CC_PORT=3437
node packages/agy-cli/router/server.mjs
```

The router listens only on `127.0.0.1`. A client's `x-api-key` or Bearer token selects its account; the router replaces it with the backend token. Model discovery, inference, streaming, idempotency, errors, and cancellation are handled by the selected backend. Switching the client token changes accounts. Config changes require a router restart. The router forwards a backend's errors without retrying on another account. Its `agy_account` diagnostics contain only account ID and HTTP status, not tokens or request content.

Model lists and quota are account-specific. Use `agy-usage` as the selected backend's service user with its own HOME and state directory. A router health response means the router is running; it does not check whether each backend or AGY login is healthy. Existing per-backend signed tool and thinking history is private to that backend. Until cross-account history migration is implemented and verified, start a new conversation after switching accounts; an existing session may return 409 when its retained metadata is unavailable on the new backend.
