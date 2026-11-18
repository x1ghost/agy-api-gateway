# Magpie AGY provider

This project is an independent Magpie provider plugin that uses an installed, signed-in official Antigravity CLI. Magpie owns the gateway, client authentication, account selection, routing, session identity and usage presentation. The plugin translates Magpie's Anthropic Messages requests through the official CLI using a process-local proxy. The CLI owns Google sign-in and all model network requests.

Read `index.mjs`, `plugin-runtime.mjs` and `packages/agy-cli/mitm/` before changing request handling. Magpie passes the client's session in `x-magpie-session` when known; its `chat.headers` hook receives Magpie's conversation identity. Keep subagents distinct using `x-magpie-subagent`. Do not invent an unrelated session ID when Magpie supplies none. Each signed-in AGY HOME is a Magpie account. AGY credentials never enter the repository.

Magpie can infer its conversation identity from the first user message when the client sends no session ID. Such identities are not guaranteed unique: two conversations with the same first message can share the same ACP session. Clients should send a session ID when they can.

`AGY_ACP_CONCURRENCY` sets the per-account default. `AGY_ACP_CONCURRENCY_BY_HOME` optionally overrides it with a JSON object mapping canonical AGY HOME paths to limits from 1 to 64; do not put real account paths in the repository.

Generation diagnostics appear in Magpie's plugin logs as `agy_request` JSON. Match `request_id` to the response `request-id` header. `stages_ms` contains offsets from plugin request start, and `phase` is the last stage reached. For a dispatched ACP prompt, an additional `acp_cancellation` event records the CLI's terminal outcome and how long it took to arrive. The wait is bounded to five seconds and holds the affected turn's slots. Set `AGY_DIAGNOSTICS=0` to disable these logs.

The plugin is not a complete Anthropic API implementation. Preserve the source and license credits in `LICENSES/MIT.txt`: the project incorporates code from an independently developed AGY-to-Anthropic bridge (snapshot `e6ee0456`), informed by and reusing the agy-cli plugin from [magpie-community/plugins](https://github.com/magpie-community/plugins) at `09e59709963af9088cf0e5307247ef40ec390f33`; that plugin traces to DylanLIiii/opencode-antigravity-bridge and gitxm/yce-magpie-agy. Project contributions are under `LICENSE`; existing MIT rights remain intact.

## Priorities

Investigate upstream 429 and 403 first, keeping provider errors distinguishable and letting Magpie own routing decisions. Do not commit credentials, real conversations, account identifiers or private runtime state. Do not silently invent model responses or successful tool results.

## Validation

Run `npm test`. Test protocol changes with synthetic inputs. For real tests, use an explicitly authorized account and bounded requests; stop after an upstream refusal. The static project website is `site/index.html`.
