# Magpie provider

`packages/magpie-provider` is an OpenCode provider plugin that connects Magpie to an existing AGY Gateway. It does not start AGY, manage Gateway accounts, or issue model requests itself. Magpie sends Anthropic Messages through the plugin to the Gateway; the Gateway continues to own its AGY CLI and account selection.

For a local checkout, add the absolute path to `packages/magpie-provider` on Magpie's Plugins page, or run `magpie plugin add /absolute/path/to/agy-api-gateway/packages/magpie-provider`. Sign in to the **AGY Gateway** provider with the Gateway URL and API key. The default URL is `http://127.0.0.1:3437`; remote deployments need their own reachable URL and key. The address may include `/v1`, which is normalized automatically. No address or key from a deployment is included in this package.

The provider reads `/v1/models` for the selected Gateway account, follows pagination, and omits the Gateway's `claude-agy/` picker aliases. Model visibility is not a quota or inference check. Model limits are not supplied by the Gateway, so the plugin does not invent them. The plugin uses Anthropic Messages, preserves upstream error responses and streaming, and supports no automatic account selection or failover. Usage data remains available through the Gateway operator's existing account tools; the plugin does not invent a usage API.

The Gateway currently admits recognizable Claude Code and DeepSeek Harness identities. The plugin does not rewrite caller identity or impersonate a client. A Magpie version or configuration that replaces the original client's User-Agent may cause a DSH custom persona without the standard DSH identity to be rejected; the Gateway's identity check returns an explicit 400. Other client identities remain unsupported.

To validate the plugin offline, run `node --test tests/magpie-provider.mjs`. Its endpoint, credentials, and model data are synthetic.

Messages require a stable `metadata.user_id` or `X-CC-Session-ID`; the plugin preserves a supplied session header but does not invent a session ID when Magpie omits one.
