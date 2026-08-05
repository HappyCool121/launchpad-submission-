# Configuration

Precedence is command-line flags, environment variables, project `.adrouter/` settings, profile/global settings under `~/.adrouter/agent`, then built-in defaults.

The hosted beta defaults to `https://api-staging.adrouter.co`. A custom or local router can be selected with `ADROUTER_API_URL`; custom routers are operator-managed and are not covered by the hosted privacy commitment.

Supported AdRouter variables include:

- `ADROUTER_API_URL`
- `ADROUTER_API_KEY` (loopback or explicit non-official custom origins only)
- `ADROUTER_AD_MODE=live|mock|off`
- `ADROUTER_CODING_AGENT_DIR`
- `ADROUTER_WORKSPACE`
- `ADROUTER_MODEL_ROUTE`
- `ADROUTER_RUNTIME_MODE=live|mock|auto`
- `ADROUTER_ALLOW_BROWSER_COOKIES`

Official hosted origins ignore copied bearer configuration and use the user-approved installation created by `/login adrouter`. The private Ed25519 JWK and rotating refresh credential are stored in the locked mode-0600 auth file under the global agent directory; access tokens are memory-only. The CLI reports this as `file_protected`, which does not imply OS-keychain encryption. Losing or corrupting the private key requires a new enrollment.

`ADROUTER_API_KEY` and `--api-key` remain available only for deliberate loopback or non-official custom-router compatibility. Never commit bearer keys, private JWKs, refresh/access credentials, device codes, nonces, or proofs; do not paste them into reports or put them in command arguments visible to other users.
