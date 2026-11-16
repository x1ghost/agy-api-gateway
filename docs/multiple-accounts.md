# Manual account selection

One Gateway and its process-local proxy serve all clients. The operator manually chooses an AGY login; the Gateway restarts the official CLI carrier with that account's HOME. The selection is global for this gateway, so all clients use the selected account. There is no automatic account selection, load balancing, or retry on a different account.

The current implementation isolates accounts by private HOME directories owned by the same Linux user as the Gateway. It does **not** yet run AGY under separate Linux users: doing so requires a separately configured privilege boundary and access to the proxy's private trust bundle and workspace. Do not run the gateway as root to achieve this. Multiple Linux users and credential import/refresh automation remain future work.

For each account, provision an official CLI login in its private HOME using the operator's existing AGY credential procedure. A credential file was observed under `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`; format and refresh behavior depend on the official CLI version. The Gateway does not read refresh tokens or implement OAuth refresh.

Create a private JSON configuration file owned by the Gateway user, mode 0600. Each HOME must be an absolute path to an existing private, non-symlink directory owned by that user. Example:

```json
{"accounts":[
  {"id":"account-a","home":"/var/lib/agy-accounts/a"},
  {"id":"account-b","home":"/var/lib/agy-accounts/b"}
]}
```

Set `AGY_ACCOUNTS_CONFIG` to the config's absolute path in the Gateway environment and restart. The first account is selected on first startup; the selected ID persists in the Gateway state directory. The account IDs are operator-defined labels and should not contain personal information.

Run these commands on the Gateway host with the Gateway's API token in `AGY_CC_TOKEN` and, if changed, `AGY_CC_PORT`:

```sh
./agy-account list
./agy-account select account-b
```

The corresponding authenticated endpoints are `GET /gateway/accounts` and `POST /gateway/accounts/select` with `{"id":"account-b"}`. A switch is rejected while a request or model discovery is active. It retires the previous carrier, uses the new HOME for subsequent CLI launches, and refreshes model discovery on its next use. In-flight requests are never moved or retried. Existing model-list caching remains per active carrier and is discarded on switch.

The response journal and signed tool/thinking metadata are scoped by account, so switching accounts in an existing conversation may fail if the new account lacks the prior response metadata. Start a new conversation after a switch until cross-account continuation has been validated. Switching does not clear or bypass the proxy's durable refusal state: a prior non-429 error can still require operator recovery. Existing cached usage is not account-bound; refresh it for the selected account using the matching HOME and state, or treat it as stale.
