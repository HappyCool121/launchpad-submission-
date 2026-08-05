# Architecture

## Request flow

1. CLI or Agent sends the selected Agnes model, thinking level, permitted messages/tools, ads
   preference, and local bearer to `POST /v1/agent/turn`.
2. Router authenticates the local bearer, applies request/admission bounds, and validates the exact
   four-model LaunchPad catalog.
3. The latest user request alone enters the guardrail and sponsor matcher. The model path retains
   the full permitted agent context.
4. Router emits an `ad` event first. `NONE` is a normal outcome.
5. The Agnes adapter sends model messages/tools using the backend-only provider credential and
   streams `text`, `thinking`, and tool-call data.
6. Router normalizes usage, estimates model cost, applies the simulated tier subsidy, emits
   `settlement`, then `done`.

## Trust boundaries

| Boundary | Data allowed | Data forbidden |
| --- | --- | --- |
| Client → Router | local bearer, model selection, messages/tools, ads preference | Agnes key |
| Router → Agnes | permitted model context and tools | sponsor metadata, local client bearer |
| Router → sponsor matcher | latest user request and synthetic campaign data | full transcript/tool history |
| Router → client display | sponsor outcome, model events, settlement | backend provider key |
| Agent renderer | narrow IPC results and display state | raw Node/fs access and plaintext stored bearer |

## Protocol surface

- `GET /health`, `/health/live`, `/health/ready` — process/readiness checks.
- `GET /v1/models` — four LaunchPad Agnes model descriptors.
- `GET /v1/profile` — bearer-protected local profile.
- `POST /v1/agent/turn` — bearer-protected ad-first NDJSON/JSON generation path.

The copied backend contains additional source inherited from the product repository, but the
documented submission path is the local demo profile. Hosted deployment, Supabase, WebUI, and
installation-auth operations are not part of this submission.
