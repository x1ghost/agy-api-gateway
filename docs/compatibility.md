# Compatibility and operational boundaries

The public surface currently implements `POST /v1/messages`, health, and a bridge-specific cancellation endpoint. Token counting returns an explicit error on this transport. It is not a drop-in implementation of the entire Anthropic API.

Messages support text, streamed or buffered output, client-provided tool schemas, parallel tool calls and results, inline base64 PNG/JPEG/WebP, and adaptive thinking with private signature references. The server stores the provider's original signatures privately to restore tool and thinking history; edited or missing records fail instead of fabricating signatures. One carrier runs requests serially. Retries with the same idempotency key replay the recorded response; requests without a key receive independent scopes.

URL images, documents, assistant prefill, numeric thinking budgets, structured output, nonempty stop sequences and some tool options are rejected. Model and generation parameter semantics differ between providers. Limits, all tools, long outputs, arbitrary failures, and interoperability across every SDK version remain unverified. There is no guarantee of exactly-once client-side tool execution after a client crash.

System instructions are transformed: case-insensitive occurrences of `Claude` and `Anthropic` become `Antigravity`; specific known SDK identity and billing lines receive dedicated substitutions. A known previously refused safety paragraph is replaced by the AGY native safety instruction by default. Set `AGY_CC_NATIVE_SECURITY_SWAP=0` to preserve that paragraph and retain the local refusal preflight. User messages, tool schemas and tool results are not filtered by this policy.

The proxy permits only a fixed set of CLI bootstrap destinations and the observed model route. Upstream protocol changes can break the gateway. It is deliberately fail-closed on errors or ambiguous interrupted forwarding. Private state contains model responses and tool data; do not publish it.
