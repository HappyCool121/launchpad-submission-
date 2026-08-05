# AdRouter — LaunchPad submission

[Public repository](https://github.com/HappyCool121/launchpad-submission-)

AdRouter explores whether clearly disclosed sponsorship can offset AI-agent inference cost without
letting the sponsor influence the agent. This submission packages a local Router, the terminal-first
AdRouterCLI demo, and the AdRouter Agent desktop source in one reviewable repository. The Router
uses a live Agnes API for model output; sponsor selection and simulated subsidy remain separate,
synthetic demo behavior.

## What to review

- `router/src/lib/agent-routing.ts` — sponsor selection, provider execution, event ordering, and
  settlement coordination.
- `router/src/lib/providers/agnes.ts` — Agnes-specific OpenAI-compatible adapter configuration.
- `router/scripts/verify-launchpad.ts` — offline proof of live-only configuration, four-model
  restriction, default model, and separate credential requirements.
- `adrouterCLI/packages/ai/src/api/adrouter.ts` — CLI request/stream transport.
- `adrouterCLI/packages/coding-agent/src/modes/interactive/components/adrouter-ad-panel.ts` —
  display-only sponsorship panel.
- `adrouterAgent/src/runtime/router-client.ts` — desktop Router client and sponsor-data stripping.
- `docs/RESULTS.md` — exact checks run for this exported repository and their limits.
- `SUBMISSION.md` — challenge summary, write-up, review guide, and disclosures.

## Architecture and trust boundaries

```text
AdRouterCLI or Agent
  |  local Router URL + local bearer only
  v
Router on 127.0.0.1:8787
  |-- latest user request -> guardrail + synthetic sponsor matcher
  |-- full permitted agent context -> Agnes adapter
  |                               |
  |                               +-- backend-only AGNES_API_KEY
  +-- ad event -> model events -> settlement -> done
```

Sponsor metadata is display/accounting data. It is not inserted into model messages, tool
definitions/results, commands, edits, patches, or compacted context. The local bearer authenticates
the clients to Router; `AGNES_API_KEY` authenticates Router to Agnes. They must be newly generated
submission-only credentials and must not be reused from another checkout.

## Agnes models

The LaunchPad runtime exposes exactly:

- `agnes-2.0-flash`
- `agnes-2.5-flash` (default)
- `agnes-2.5-pro`
- `agnes-2.5-pro-alpha`

Flash models support `none` or `high` thinking. The Pro models use their registered `high` thinking
contract. The live catalog is returned by `GET /v1/models`.

## Prerequisites

- Router: Node.js 22.13 or newer (Node 22 LTS recommended).
- AdRouterCLI: Node.js 22.19 or newer.
- AdRouter Agent: the pinned Node.js 25.9.0 runtime.
- A new Agnes API credential. It is required only when someone runs the demo; repository checks and
  CI are offline.
- A new random local Router bearer, for example from `openssl rand -hex 24`.

## Quick start: CLI-first demo

Use a disposable project with no personal or production data.

Terminal 1 — Router:

```bash
cd router
cp .env.example .env.local
# Edit .env.local: set a new ADROUTER_API_KEY and a new submission-only AGNES_API_KEY.
npm ci --ignore-scripts
npm run dev
```

Router fails at startup if either key is missing. It binds to `127.0.0.1`, requires live Agnes
execution, and rejects `runtime_mode=mock`.

Terminal 2 — build the CLI once:

```bash
cd adrouterCLI
cp .env.example .env.local
# Set ADROUTER_API_KEY to the Router bearer. Do not add AGNES_API_KEY.
npm ci --ignore-scripts
npm run build
```

Then launch it from the disposable project so its filesystem tools are scoped there:

```bash
cd /path/to/disposable-project
npm --prefix /path/to/launchpad/adrouterCLI run start:launchpad -- \
  --provider adrouter --model agnes-2.5-flash
```

Try a normal coding task, inspect the separately labeled sponsor panel and settlement, then run
`/ads off` and repeat a turn. Opt-out, sensitive requests, empty inventory, and routing failures can
produce `NONE` while Agnes still answers.

## Optional desktop Agent

```bash
cd adrouterAgent
npm ci
npm run dev:launchpad
```

In onboarding, keep `http://127.0.0.1:8787`, enter only the local Router bearer, select a disposable
project, and choose `agnes-2.5-flash`. The token is encrypted through Electron `safeStorage`. This
submission does not claim native packaging, signing, notarization, live acceptance, or physical
Windows acceptance; see `adrouterAgent/README.md`.

## Offline verification

No verification command needs or contacts Agnes:

```bash
npm run check:submission
cd router && npm run typecheck && npm run test:launchpad && npm run build
cd ../adrouterCLI && npm run check:submission
cd ../adrouterAgent && npm run check:submission
```

The CI workflow uses separate Node versions and supplies no credentials. Provider behavior is
checked with local fixtures, not a live call.

## Honest disclosures

- Live model output depends on the external Agnes API and a user-supplied key.
- Campaigns, sponsor copy, matching inventory, and subsidy percentages are synthetic fixtures.
- Subsidy is simulated accounting, not advertiser-funded settlement.
- Semantic matching can use an optional OpenAI embedding key; without it, the demo uses deterministic
  local vectors and keyword matching. This is independent of Agnes generation.
- The guardrail is a bounded pattern set, not comprehensive safety/legal/compliance coverage.
- No claims are made for advertiser demand, revenue, conversion, user acceptance, matching accuracy,
  production readiness, or sustainable unit economics.

See `docs/ARCHITECTURE.md`, `docs/DEMO.md`, `docs/SECURITY.md`, and `docs/DECISIONS.md` for details.
