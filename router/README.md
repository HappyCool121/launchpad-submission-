# LaunchPad Router

This directory is the local AdRouter backend snapshot used by the submission. It matches synthetic
sponsor inventory separately from model generation and routes agent work to a live Agnes API.

## Runtime

`npm run dev` selects `LAUNCHPAD_SUBMISSION=true`, the local demo profile, and Agnes. Startup fails
closed unless `.env.local` supplies both a local `ADROUTER_API_KEY` and backend-only
`AGNES_API_KEY`. The server binds to `127.0.0.1:8787`; mock runtime requests are rejected.

```bash
cp .env.example .env.local
# Replace both placeholders with new submission-only values.
npm ci --ignore-scripts
npm run dev
```

Check process state with `curl -fsS http://127.0.0.1:8787/health/ready` and the public catalog with
`curl -fsS http://127.0.0.1:8787/v1/models`.

## Main routes

- `GET /v1/models` returns four Agnes models, defaulting at request validation to
  `agnes-2.5-flash`.
- `GET /v1/profile` requires the local bearer.
- `POST /v1/agent/turn` requires the local bearer and live Agnes. NDJSON ordering is `ad`, model or
  tool events, `settlement`, `done`.
- Health routes are public and do not prove Agnes authorization.

## Source map

- `src/lib/modelRegistry.ts` — canonical registry plus submission-mode Agnes filtering/default.
- `src/lib/agent-routing.ts` — sponsor/model separation, plan, stream, and settlement.
- `src/lib/providers/agnes.ts` — Agnes adapter specialization.
- `src/lib/providers/openai-compatible.ts` — message/tool serialization, streaming, and usage.
- `src/lib/guardrail.ts`, `router.ts`, `vector.ts` — sensitive-topic and matching path.
- `src/routes/agent-turn.ts` — authenticated CLI/Agent endpoint.
- `scripts/verify-launchpad.ts` — offline submission assertions.

## Verification

```bash
npm run typecheck
npm run test:launchpad
npm run test:launchpad:integration
npm test
npm run build
```

Tests use local fixtures/fake upstreams. Do not add a provider key to CI. `OPENAI_API_KEY` is
optional for semantic sponsor embeddings; without it, deterministic local matching is used. Sponsor
inventory/subsidy are synthetic and not proof of advertiser funding.
