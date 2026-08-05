# About AdRouterCLI

AdRouterCLI is the terminal coding agent for AdRouter. The Router owns hosted model discovery,
routing, provider credentials, quota, sponsorship selection, settlement, and the streaming HTTP
contract. The CLI owns local workspace trust, model selection, installation authentication,
session history, tool approvals, edits, compaction, and terminal rendering. Provider credentials
for DeepSeek, MiMo, and Agnes never belong in the CLI.

## Official model catalog

The default product registry is generated from the versioned Router catalog. It is immutable and
contains exactly these models, in Router order:

<!-- BEGIN ADROUTER MODEL TABLE -->
| Model ID | Display name | Provider | Class | Description | Thinking modes | Default | Context | Max input | Max output |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: |
| `deepseek-v4-flash` | DeepSeek V4 Flash | deepseek | flash | Fast DeepSeek coding model for interactive development. | none, medium, high | medium | 131,072 | 126,976 | 4,096 |
| `deepseek-v4-pro` | DeepSeek V4 Pro | deepseek | pro | DeepSeek coding model for complex development tasks. | none, medium, high | medium | 131,072 | 126,976 | 4,096 |
| `mimo-v2.5` | MiMo V2.5 Flash | mimo | flash | Fast MiMo coding model for interactive development. | none, high | high | 131,072 | 126,976 | 4,096 |
| `mimo-v2.5-pro` | MiMo V2.5 Pro | mimo | pro | MiMo coding model for complex development tasks. | none, high | high | 131,072 | 126,976 | 4,096 |
| `agnes-2.0-flash` | Agnes 2.0 Flash | agnes | flash | Fast Agnes 2.0 coding model for interactive development. | none, high | none | 131,072 | 126,976 | 4,096 |
| `agnes-2.5-flash` | Agnes 2.5 Flash | agnes | flash | Fast Agnes 2.5 coding model for interactive development. | none, high | none | 131,072 | 126,976 | 4,096 |
| `agnes-2.5-pro` | Agnes 2.5 Pro | agnes | pro | Agnes 2.5 reasoning model for complex development tasks. | high | high | 131,072 | 126,976 | 4,096 |
| `agnes-2.5-pro-alpha` | Agnes 2.5 Pro Alpha | agnes | pro | Alpha Agnes 2.5 reasoning model for complex development tasks. | high | high | 131,072 | 126,976 | 4,096 |
<!-- END ADROUTER MODEL TABLE -->

The catalog schema is version 1. Its digest is
`sha256:e8e5f875b6c901ed98c3b07b5ad9aa107a52562dc9157aa8eae99b73562ca9be`.
The 131,072-token context is divided into at most 126,976 input tokens and 4,096 output tokens.
AdRouterCLI compacts before the hard input limit; the existing compaction calculations and
single pre-response overflow retry remain unchanged.

## Authentication and endpoint boundary

Official hosted access uses browser-first installation enrollment. The CLI creates an Ed25519
installation key, opens the matching approval handoff, and exchanges approval for short-lived
access plus rotating refresh material. Every hosted profile and turn request carries a fresh
DPoP-style proof. The private key and refresh material are stored in a mode-0600 file and reported
as `file_protected`; this is not an OS-keychain or software-attestation claim.

Long-lived bearer keys are not accepted for the official hosted origin. An explicitly configured
custom or loopback AdRouter endpoint may use its supported bearer flow and may expose private
AdRouter model IDs. Such IDs inherit the canonical AdRouter runtime limits and behavior. SDK code
that needs a non-AdRouter provider must construct `ModelRegistry.inMemory()`, register the provider
programmatically, and inject that registry into `createAgentSession()`. Extensions cannot register
or unregister providers, and the official registry cannot be mutated.

## Streaming lifecycle

The CLI sends turns to the hosted `/v1/agent/turn` route and consumes the bounded streaming
lifecycle: ad state, thinking, text, tool calls, settlement, and completion. Tool calls still pass
through workspace trust and per-command or per-mutation approval. Once any paid response event has
been consumed, the CLI never replays that turn. Abort, refresh rotation, tool approval, session
schema, and compaction behavior are unchanged by catalog synchronization.

## Sponsorship and settlement

Eligible non-`NONE` sponsorship is rendered as a full-width terminal panel with a sanitized title,
up to three body lines, and a visible HTTP(S) URL. Terminal hyperlinks are added only when the
terminal reports OSC-8 support. Invalid URLs, credentials, controls, and non-HTTP(S) schemes are
discarded. `NONE` remains a neutral three-line state; opt-out, degraded, and empty updates clear the
panel atomically. `/ads` shows or changes the sponsorship preference.

Sponsor and settlement data is display/accounting data only. Existing `adrouter.settlement`
entries, the replay card, and cumulative subsidy footer may remain in local session state. They
never enter provider messages, assistant text, prompts, tools, commands, approvals, edits, or
compacted model context.

## Install, diagnose, and log out

Node.js 22.19 or newer is required for the npm package:

```sh
npm install --global --ignore-scripts @adrouter/cli@beta
adrouter --version
adrouter --json doctor
adrouter --offline --list-models adrouter
```

`adrouter --json doctor` reports endpoint, catalog, reachability, and redacted installation state
as machine-readable JSON. It must not print keys, tokens, refresh material, proofs, comparison
codes, nonces, or full fingerprints.

Start `adrouter` in a trusted workspace and run `/login adrouter`. If browser launch fails, use the
printed Open or Copy fallback; Quit cancels and cleans pending enrollment. Run `/logout adrouter`
to attempt remote revocation and always remove the local AdRouter installation credential. Package
uninstallation does not remove `~/.adrouter`; delete that state only when you also intend to delete
local sessions, profiles, credentials, and trust decisions.
