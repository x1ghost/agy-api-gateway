# Contributing

Report problems directly in the project's issue tracker, or submit a pull request / merge request if you can provide a fix. Search for an existing report first and add relevant evidence there when appropriate. For an issue, include the affected client and versions, expected and observed behavior, a minimal synthetic reproduction, and relevant error codes. For a fix, explain the change and how it was verified. If the repository has no configured remote or tracker, record the finding locally and tell the user instead of guessing where to send it.

Do not include credentials, private prompts, account identifiers, proxy certificates, real tool output or private runtime state in reports or contributions.

Run `npm test` before submitting. Protocol changes should include meaningful offline tests for request conversion, streaming, errors, retries and tool history as applicable. Document unsupported features rather than silently approximating semantics. Real-model tests are optional and must use a contributor's own explicitly authorized environment and bounded requests.

Contributions to this project are submitted under the [PolyForm Noncommercial License 1.0.0](LICENSE). Preserve the upstream MIT notices in [LICENSES/MIT.txt](LICENSES/MIT.txt) and the source attribution in [AGENTS.md](AGENTS.md); pre-existing MIT rights are unaffected. Keep the gateway independent of any particular host, account, client, deployment or organization. Avoid adding dependencies on user-specific paths or configuration.
