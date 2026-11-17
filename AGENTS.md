# AGY Anthropic Gateway

This file is the entry point for agents working on this project. Read it and
[compatibility](docs/compatibility.md) before changing the gateway. Follow
[CONTRIBUTING.md](CONTRIBUTING.md) for tests, privacy and source attribution.
Do not treat unverified features as implemented or include private runtime data
in the repository.

When you encounter a project problem, report it directly in the project's issue
tracker; if you can fix it, submit a pull request or merge request instead. Check
for an existing report first and include a minimal synthetic reproduction and
relevant validation. Never publish credentials, real conversations, tool results,
account identifiers or private runtime state. If no project remote or tracker is
configured, record the finding locally and tell the user; do not invent a destination.

An independent, experimental Anthropic Messages-compatible gateway backed by an installed official Antigravity CLI (AGY). Run it on the machine where AGY is already signed in; clients connect to the gateway over HTTP. Claude Code is one possible client, not a prerequisite or part of the server.

The gateway translates requests and responses around the official CLI using a process-local TLS proxy. The CLI owns authentication and makes model network requests. Client messages, conversation history and tool execution remain under the client's control. This project is independent of Google, Anthropic and the upstream projects credited below.

## Source and license

The project's own contributions in this distribution are offered under the [PolyForm Noncommercial License 1.0.0](LICENSE), to the extent the project licensor has rights to license them. Commercial use of those contributions requires separate permission. This does not revoke or restrict any existing MIT rights in previously licensed code.

This project incorporates code from an independently developed AGY-to-Anthropic bridge, source snapshot `e6ee0456`; the original development repository retains its history. The bridge was informed by and reused the `agy-cli` plugin from [magpie-community/plugins](https://github.com/magpie-community/plugins), baseline `09e59709963af9088cf0e5307247ef40ec390f33` (version 0.1.49). That plugin traces its origin to [DylanLIiii/opencode-antigravity-bridge](https://github.com/DylanLIiii/opencode-antigravity-bridge) and [gitxm/yce-magpie-agy](https://github.com/gitxm/yce-magpie-agy). Upstream MIT-licensed portions retain their original license and copyright notices in [LICENSES/MIT.txt](LICENSES/MIT.txt).

## Status

This is **not a complete Anthropic API implementation**. Text, streaming, client tool calls, base64 PNG/JPEG/WebP and adaptive thinking are implemented with limitations. Batches, files, exact token counting, server-side tools, PDFs, URL images, structured output, stop sequences and several other options are not implemented. Some fields and model behaviors are not equivalent. Unsupported requests must not be assumed to work. See [compatibility](docs/compatibility.md).

The optional Magpie provider connects to an existing Gateway; see [Magpie provider](docs/magpie.md) for installation and client-identity limitations.

The portable launcher has passed a real AGY 1.5.9 tool-call and tool-result round trip in one deployment, alongside offline tests. Other environments and the full API surface remain unverified. The supported CLI version and provider behavior may change. Contributions to compatibility and portable deployment are welcome.

## Investigation priorities

Treat upstream HTTP 429 (rate limits/quota) and 403 (access/refusal) as the highest-priority operational issues. Use gateway diagnostics and official AGY CLI behavior to identify the upstream cause, affected models, and whether other requests are impacted. Issue #5 (small output limits versus thinking budgets) is lower priority.

## Run

Prerequisites: Unix-like environment, Node.js 22+, Python 3.10+, `mitmdump` (mitmproxy 12.x), an installed official `agy` CLI, and an existing AGY login for the same OS user. The gateway does not manage accounts or sign in for you.

```sh
export AGY_CC_TOKEN="$(openssl rand -hex 32)"
export AGY_MITM_STATE_DIR="$HOME/.local/state/agy-anthropic-gateway"
export AGY_PATH="$(command -v agy)"
python3 gateway.py
```

The service listens on `127.0.0.1:3437`. Pass the token as `x-api-key` or `Authorization: Bearer ...`. Use an AGY model ID actually available to your login, not an assumed Anthropic model ID. Clients may send ordinary Messages requests without an additional session identifier. Each request should use a unique `Idempotency-Key` when retryable replay is desired.

`AGY_CC_PORT` changes the gateway port; `AGY_MITM_PROXY_PORT` changes the private proxy port (default 3441); `MITMDUMP_PATH`, `NODE_PATH` and `AGY_SYSTEM_CA_BUNDLE` select executable or trust bundle paths. The state directory must be absolute, private and dedicated to one instance. It contains potentially sensitive response journals, tool arguments and signature metadata. Back it up and restrict access accordingly.

Only the gateway and its child CLI trust the proxy's private CA; the system trust store is not modified. The gateway intentionally intercepts and translates the CLI's model traffic. Do not expose its loopback listener directly to the internet; remote access needs an authenticated, encrypted transport managed by the operator.

The forwarding gate retains counters and stops on non-429 upstream errors or uncertain failure. An upstream 429 is returned to its caller without stopping other requests. Restarting does not reset a refusal. No automatic account switching is performed. Optional manual selection can switch the official CLI between private account HOME directories; see [multiple accounts](docs/multiple-accounts.md). Consult [compatibility](docs/compatibility.md) for system-instruction transformations and refusal protection.

The known CC safety paragraph is replaced with the native AGY safety instruction by default; set `AGY_CC_NATIVE_SECURITY_SWAP=0` to disable that substitution.

## Account quota

Run `./agy-usage` as the gateway's OS user with its `HOME`, `AGY_PATH` and `AGY_MITM_STATE_DIR` to read the gateway's private, timestamped quota cache. `./agy-usage --refresh` explicitly runs the official CLI `/usage` command and replaces that cache only on success. It may make network requests and does not invoke a model. Use the same proxy and CA environment as the gateway when the host needs it; CLI output reports the current login's available quota windows, which may be unknown or stale. The snapshot is not bound to an account identity; refresh after a login change. This is separate from per-response token usage and gateway request counts.

## Development

```sh
npm test
python3 tests/startup.py  # Requires mitmdump; starts no model request.
node docs/vision/build.mjs  # Rebuild the static architecture page.
```

The tests use synthetic data and do not call a model or require AGY login. See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. License and source credits are in [LICENSE](LICENSE) and the source section above.
