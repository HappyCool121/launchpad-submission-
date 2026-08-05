# AdRouter backend (router wrapper)

The demo backend for **AdRouter** — a revenue-aware AI gateway that offsets
LLM inference cost with transparent, display-only sponsorship. This service
sits between the user and a configured provider: it streams the **unmodified**
model answer while, in parallel, routes the latest user message through a
semantic sponsor match and ships an ad payload plus cost settlement to the
client. Sponsor data never enters model messages, tools, or model context.

The current Fly staging service is live in owner-only canary mode. Hosted
sponsor inventory is intentionally empty: `/api/sponsors` returns no records,
and live turns follow the supported `NONE`/`no_inventory` path with zero
subsidy. Service mode does not load `sponsors.json` bootstrap fixtures and keeps
sponsor writes disabled. This is the preserved known-good posture until sponsor
onboarding is separately approved.

For the complete CLI workflow—including credential separation, source builds,
the `adrouter` versus `adrouter-live` launchers, authenticated verification,
runtime modes, SQLite backup, and troubleshooting—see the sibling checkout's
[AdRouterCLI server and CLI operations guide](../../../adrouterCLI/docs/server-cli-operations.md).

---

## Quick start

```bash
cd /path/to/3days/router/backend
npm install
cp .env.example .env.local
npm run dev                  # http://localhost:8787
```

Set `ADROUTER_API_KEY` in `.env.local` even in mock mode because model turns,
profile lookup, sponsor writes, and analytics require it. Generate a local
token with `openssl rand -hex 32`. Keep `DEEPSEEK_API_KEY` backend-only and
never reuse it as the AdRouter bearer token.

Without a configured provider, the server runs in **mock mode**. The current
registered live adapter is DeepSeek, so this normally means no
`DEEPSEEK_API_KEY`:

- `/api/chat` returns a JSON object `{ mode, ad, text, settlement }` instead of
  a data stream. The full router pipeline (guardrail → vector match → tier →
  settlement) still runs, so tiers, the privacy guardrail, and wallet math are
  all testable with no key.
- The mock response is a **standard canned answer** (a math solve) surfaced for
  every prompt until a live key is set — this is intentional, to give a stable
  demo while the live API is wired up.
- Embeddings fall back to deterministic mock vectors, and sponsor matching also
  uses an explicit keyword signal. Set `OPENAI_API_KEY` for real
  `text-embedding-3-small` semantic matching.

Set `DEEPSEEK_API_KEY` in `.env.local` to switch to **live mode**. Add
`OPENAI_API_KEY` when you want real dense semantic matching instead of the
keyword/mock-vector fallback.

The backend loads only `.env.local`; `.env` is not read. `ADROUTER_API_KEY` is
the documented shared bearer token; `ROUTER_AUTH_KEY` remains a legacy fallback.
For `/v1/agent/turn`, each NDJSON stream is ad-first and every turn calculates
a fresh outcome from the latest user message only. The full conversation and
tool results still pass to the selected provider for generation.

---

## Verify

```bash
npm run dev         # terminal 1 — start the server
npm run test:loop   # terminal 2 — exercises Tier A/B/C + guardrail NONE + sponsor list
```

The script is read-only: it deliberately does **not** POST test sponsors
(that would persist to SQLite on every run). Exercise
`POST /api/sponsors/add` manually when you want to test ingestion.

Manual smoke test (mock mode):

```bash
set -a
. .env.local
set +a

# default — mock response + auto tier (usually C in mock embedding mode)
curl --fail --silent --show-error -X POST localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${ADROUTER_API_KEY}" \
  -d '{"messages":[{"role":"user","content":"solve 1 + 2x = 3"}]}'

# force a tier for the demo — coherent similarity + settlement per tier
curl --fail --silent --show-error -X POST localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${ADROUTER_API_KEY}" \
  -d '{"messages":[{"role":"user","content":"solve 1 + 2x = 3"}],"tier_override":"A"}'
```

Tier override is automatic in mock mode. In live mode it additionally requires
`ENABLE_DEMO_TIER_OVERRIDE=true` and can never supersede guardrail, opt-out,
inventory, or routing-failure `NONE` outcomes.

### Verify CLI integration

The CLI and backend share the same local `ADROUTER_API_KEY`. Start the backend
in one terminal, then verify public reachability and authenticated access from
another:

```bash
curl --fail --silent --show-error http://localhost:8787/health
curl --fail --silent --show-error http://localhost:8787/v1/models

set -a
. .env.local
set +a
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${ADROUTER_API_KEY}" \
  http://localhost:8787/v1/profile
```

`/health` is public, so it proves that the process is listening but does not
prove that the bearer token is valid. `/v1/profile` checks the shared local
authentication without invoking the model provider.

The CLI-facing smoke test exercises the authenticated `POST /v1/agent/turn`
route, including ad-first ordering, model output, settlement, completion,
conversation context, sponsor refresh, and the privacy guardrail:

```bash
npm run typecheck
npm run test:agent-turn
npm run test:loop
```

From any project directory, the configured Zsh shortcut loads the CLI checkout's
dotenv file and preserves the current directory as the agent workspace:

```zsh
source ~/.zshrc
adrouter-live --json doctor
adrouter-live --json request get /health
adrouter-live
```

The installed `adrouter` executable does not load the CLI `.env.local` by
itself; use exported variables or use `adrouter-live` for the configured local
backend. Never redefine `adrouter()` around the live shortcut because the
launcher resolves the real executable with `type -P adrouter`.

---

## Endpoints

The current hosted deployment contract and stream-ordering acceptance gates are
documented in the [Fly staging runbook](../../docs/flyio/flyio-staging.md).

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ status, mode, model_catalog, providers, persistence, capabilities }` — provider-neutral capability state |
| GET | `/api/sponsors` | — | `{ sponsors: [...] }` — current sponsors, embedding vectors stripped |
| POST | `/api/sponsors/add` | `{ brand_name, ad_copy, target_keywords[], click_url }` | Authenticated and enabled only: embeds, caches, and persists the new sponsor |
| POST | `/api/chat` | `{ messages, model?, thinking_level?, runtime_mode?, ads_enabled?, tier_override? }` | **mock:** `{ mode, ad, text, settlement }` · **live:** ad-first NDJSON (ad, text, settlement) |
| POST | `/v1/turn` | `{ client, input, model?, ads_enabled? }` | Authenticated canonical ad-first NDJSON provider stream |
| POST | `/v1/agent/turn` | `{ context, model?, metadata: { ads_enabled? } }` | Authenticated CLI JSON or ad-first NDJSON; both carry an ad outcome and explicit display status |
| GET | `/api/analytics/summary` | `?from=<ISO>&to=<ISO>` | Authenticated aggregate totals, tier/status counts, and subsidy |
| GET | `/api/analytics/campaigns` | `?from=<ISO>&to=<ISO>` | Authenticated per-campaign aggregate counts and subsidy |

### `/api/chat` response shape

The **ad payload** (delivered *before* the stream finishes — Stage 3):

```jsonc
{
  "type": "ad",
  "ad": {
    "tier": "A",                 // "A" | "B" | "C" | "NONE"
    "similarity": 0.88,          // cosine score that produced the tier (0 for NONE)
    "provisional_savings": 0.012,// estimate shown while streaming
    "reason": "High commercial intent …",
    "sponsor": {                 // omitted when tier === "NONE"
      "brand_name": "Calculator.com",
      "target_keywords": ["calculator", "math", …],
      "click_url": "https://calculator.com",
      "ad_copy": "…"
    }
  }
}
```

The **settlement** (delivered on stream finish — Stage 4):

```jsonc
{
  "type": "settlement",
  "settlement": {
    "tier": "A",
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "cache_hit_tokens": 42,
    "cache_miss_tokens": 500,
    "usage": { "input_tokens": 500, "cache_read_tokens": 42, "cache_write_tokens": 0, "output_tokens": 1187, "total_tokens": 1729 },
    "cost": { "input_cache_hit": 0.0, "input_cache_miss": 0.00007, "cache_write": 0, "output": 0.000332, "total": 0.000402 },
    "prompt_cost": 0.000402,   // real token counts × selected model rates
    "ad_subsidy": 0.000341,    // tier fraction of prompt_cost
    "paid": 0.0,               // prompt_cost − ad_subsidy
    "cache_hit": false
  }
}
```

The frontend's **Compute Wallet** animates `prompt_cost | ad_subsidy | paid`.

### `tier_override`

An optional `{ tier_override: "A" | "B" | "C" | "NONE" }` field on the chat
body lets the frontend's **Dev Preview** dropdown force a tier. When set, the
backend re-assigns an otherwise sponsor-eligible tier, gives it a representative similarity
(A `0.91`, B `0.72`, C `0.42`, NONE `0`), recomputes `provisional_savings`
and the **settlement subsidy** for that tier, and clears the sponsor for
NONE. This makes the previewed tier coherent end-to-end (display, AdDetailsBar
similarity, and wallet math), instead of just a display swap.

> **Security note:** `tier_override` is automatically honored in backend mock
> mode so the Web UI can preview all ad surfaces. In live mode it requires
> `ENABLE_DEMO_TIER_OVERRIDE=true`, and it cannot override guardrail, opt-out,
> inventory, or routing-failure `NONE` outcomes to a sponsored tier.

---

## How it works — the 4-stage pipeline

```
            ┌─ Stage 1: Semantic Gateway ─────────────────────┐
 prompt ──► │ guardrail → embed → cosine search → tier + subsidy │
            └───────────────────────┬───────────────────────────┘
                                    │ adPayload
            ┌─ Stage 2: Parallel split ─────────────────────────┐
            │  Track X: selected provider — UNMODIFIED answer     │
            │  Track Y: finalize ad payload                       │
            └───────────────────────┬───────────────────────────┘
                                    │
            ┌─ Stage 3: Async UI payload ───────────────────────┐
            │  ad payload sent to client BEFORE stream finishes  │
            └───────────────────────┬───────────────────────────┘
                                    │
            ┌─ Stage 4: Client intersect + settle ──────────────┐
            │  frontend renders Tier A/B/C; on finish, exact     │
            │  token cost × tier subsidy → Compute Wallet        │
            └────────────────────────────────────────────────────┘
```

**The trust pillar:** the ad **never** enters the LLM prompt. The system
prompt tells the model to answer objectively and never mention sponsors.
Sponsor selection is entirely separate from generation — sponsors cannot
alter the model's answer (zero deep-prompt tampering).

Client-supplied `role: 'system'` messages are stripped before calling the model;
only the server-owned `SYSTEM_PROMPT` controls generation.

### Ad tiers (from the cache-hit similarity score)

| Tier | Similarity | What happens | Subsidy |
|---|---|---|---|
| A | `> 0.85` | inline highlighted sponsored run within the response (rendered by the frontend) | 100% |
| B | `> 0.60` | "Sponsored Agent" side panel, parallel to the answer | 40% |
| C | `≤ 0.60` | static baseline banner while the model "thinks" | 5% |
| NONE | — | guardrail blocked (health/finance/legal/politics) — full answer, no ad | 0% |

> **Tuning note:** the 0.85 / 0.60 thresholds now apply to the strongest routing
> signal: dense semantic similarity when available, or deterministic keyword
> similarity for explicit sponsor keywords such as "leaky pipe".

---

## Module map

| File | Responsibility |
|---|---|
| `src/index.ts` | Express boot; initializes SQLite campaigns, embeddings, and shutdown handling |
| `src/lib/types.ts` | `Sponsor`, `AdTier`, `AdPayload`, `Settlement` shared types |
| `src/lib/router.ts` | **Stage 1** orchestrator: embed → guardrail → match → tier → `AdPayload` |
| `src/lib/embeddings.ts` | pluggable embedding seam (OpenAI default; hashed mock fallback) |
| `src/lib/vector.ts` | `cosineSimilarity` + `findBestMatch` over the sponsor DB |
| `src/lib/guardrail.ts` | sensitive-category blocklist → tier `NONE` (privacy pillar) |
| `src/lib/tiers.ts` | score → tier thresholds |
| `src/lib/providers/` | Provider adapters, model descriptors, and dormant provider definitions |
| `src/lib/pricing.ts` | Per-model cache-hit/cache-miss/cache-write/output rates + subsidy math |
| `src/lib/database.ts` | Additive SQLite migrations, campaigns, private event aggregates, and shutdown-safe closure |
| `src/lib/sponsorStore.ts` | in-memory embedding cache backed by SQLite campaigns; `sponsors.json` is immutable bootstrap data |
| `src/lib/sponsors.json` | seed sponsors (text-only; embeddings live only in memory) |
| `src/routes/chat.ts` | **Stages 2–4**: stream the selected provider, ship ad early, settle on finish |
| `src/routes/sponsors.ts` | sponsor list + ingestion |
| `src/routes/analytics.ts` | authenticated aggregate analytics only; never returns prompt/model content |
| `src/routes/health.ts` | mode + key-config probe |
| `scripts/verify-loop.ts` | read-only smoke test for all tiers + guardrail |

---

## Configuration (`.env.local`)

| Var | Required | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek live mode only | DeepSeek adapter credential. Absent ⇒ mock mode unless another registered provider is configured |
| `OPENAI_API_KEY` | semantic matching only | embeddings provider. Absent ⇒ keyword/mock-vector fallback |
| `DEEPSEEK_BASE_URL` | no | default `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | no | default `deepseek-v4-flash` |
| `ADROUTER_DB_PATH` | no | package-relative default `data/adrouter.sqlite`; use `:memory:` for an isolated process test |
| `ADROUTER_API_KEY` | yes for authenticated routes | shared local bearer token required for turns, profile, writes, and analytics |
| `PORT` | no | default `8787` |
| `ENABLE_DEMO_TIER_OVERRIDE` | no | live-mode only; mock mode enables the Web UI ad preview automatically |

---

## Notes & caveats

- **DeepSeek has no embeddings endpoint.** The semantic router needs embeddings,
  so they come from a separate provider (OpenAI `text-embedding-3-small`) behind
  the `lib/embeddings.ts` seam. Swap to a local MiniLM (via `@xenova/transformers`)
  by editing that one module — the rest of the router is provider-agnostic.
- **Model naming.** The initial runnable catalog exposes `deepseek-v4-flash`
  and `deepseek-v4-pro`. Qwen and MiMo adapter definitions are deliberately
  dormant until their vendor contracts are supplied.
- **Thinking effort.** Live calls pass `reasoningEffort: 'medium'`. DeepSeek's
  OpenAI-compatible docs state thinking is enabled by default and that `low` and
  `medium` are currently mapped to `high`, so "medium" is requested but may run
  at DeepSeek's high effort internally.
- **Pricing** in `lib/pricing.ts` is set from DeepSeek's V4 Flash pricing page:
  `$0.0028/1M` cache-hit input, `$0.14/1M` cache-miss input, `$0.28/1M`
  output. All wallet math flows from the provider-neutral `MODEL_PRICING`
  catalog, including cache-read and optional cache-write components.
- **Cache-hit handling.** Adapters normalize cache reads separately from cache
  misses, so cached prompt tokens are not double-counted in settlement totals.
- **Local auth only.** The shared bearer token protects turns, writes, and
  analytics, but this local design is not production identity or
  authorization. Treat the value as sensitive in logs and do not expose the
  demo publicly without secret management, rate limits, and spend controls.
