# LaunchPad submission

## Short summary

AdRouter is a local gateway for solo founders testing whether clearly disclosed sponsorship can
offset AI-agent inference cost. It routes AdRouterCLI or the desktop Agent to live Agnes models,
shows any synthetic sponsor placement and simulated subsidy in a separate display channel, and
keeps sponsor data out of model messages, tools, commands, edits, and compacted context.

## Full write-up

### Problem and approach

AI coding agents let one person inspect a repository, use tools, and make substantial changes, but
every useful model turn has a variable inference cost. A solo founder often pays that cost before a
product has predictable revenue. The obvious advertising shortcuts are unsafe: sponsor instructions
inside the system prompt could influence the answer, while sending a transcript to an advertising
network exposes more context than matching needs.

AdRouter tests a narrower question: can commercial intent help fund agent compute without buying or
changing the work product? This submission is CLI-first. AdRouterCLI sends permitted agent context
to a local Router over an authenticated loopback connection. The Router uses only the latest user
request for sponsor matching, while the complete permitted conversation and tool history remains
available to the Agnes model. Sponsor and model routing are independent.

Before matching, a bounded guardrail suppresses sponsorship for configured sensitive categories.
Eligible requests are compared with synthetic campaign inventory using keyword scoring and vector
similarity. An optional OpenAI embedding credential enables semantic embeddings; without one, a
deterministic local vector path makes routing repeatable. Matching yields Tier A, B, C, or `NONE`.
Opt-out, guardrail, empty inventory, and routing failure can return `NONE` without blocking the model
answer.

Agnes is implemented as a backend provider adapter. The submission exposes `agnes-2.0-flash`,
`agnes-2.5-flash`, `agnes-2.5-pro`, and `agnes-2.5-pro-alpha`, defaulting to
`agnes-2.5-flash`. The adapter uses the Agnes OpenAI-compatible endpoint, merges system messages to
the supported shape, serializes tools and prior tool results, maps model-specific thinking options,
streams text/thinking/tool-call events, and normalizes usage for settlement. The Agnes key exists
only in Router. CLI and Agent receive a different local bearer and never receive the provider key.

The wire protocol emits a sponsor outcome first, then model or tool events, an authoritative
settlement, and `done`. The early placement is display metadata; observed provider usage drives the
final estimated cost and simulated subsidy. Sponsor copy, IDs, matching fields, and settlement never
enter model prompts, assistant output, tool arguments/results, commands, edits, patches, or compacted
context. `/ads off` is a non-overridable user control.

### Evidence and experiments

The evidence is implementation-backed rather than a claim of a proven advertising business. Router
tests cover model registration, thinking contracts, OpenAI-compatible request shaping, streamed
usage, guardrails, routing, ad-first ordering, settlement, opt-out, and sponsor separation. A
LaunchPad-specific offline check proves the runtime fails closed without both credentials, exposes
only four Agnes models, defaults correctly, and rejects mock mode. Existing provider tests use a
local fake upstream, so CI does not need or contact Agnes.

CLI source parses sponsor and settlement events separately from model content. Focused transport and
UI tests cover malformed streams, `NONE`, narrow terminals, stale-placement clearing, and settlement
association. The desktop client validates model discovery, strips sponsor-shaped data from model
context, keeps privileged filesystem/process access outside the renderer, and encrypts the local
bearer with Electron `safeStorage`.

The demonstration is intentionally straightforward: start Router with new submission-only keys,
run CLI against a disposable project, perform a normal coding turn, inspect the separately labeled
sponsor panel and settlement, disable ads, and repeat. Sensitive and no-inventory cases demonstrate
that the agent can continue without placement. These are reproducible behavior checks, not usage,
conversion, or revenue metrics.

### Constraints, limitations, and incomplete areas

Live output requires the external Agnes API and a valid user-supplied credential. No live Agnes call
was made while preparing or testing the repository. A judge who runs the demo incurs whatever terms,
limits, latency, and cost their Agnes account applies.

Campaigns, sponsor copy, inventory, and subsidy percentages are synthetic. There is no live
advertiser-funded settlement, production attribution, fraud prevention, validated fill rate,
conversion dataset, or demonstrated positive gross margin. Matching quality and p50/p95 latency have
not been benchmarked. The guardrail is a bounded keyword/pattern system and is not comprehensive
safety, legal, privacy, or compliance coverage. Optional external embeddings improve semantic
matching, but the default no-key matcher is deterministic rather than a production relevance model.

The desktop source is included and runnable in development, but this submission does not claim
signed/notarized native packages, live-provider desktop acceptance, or physical Windows validation.
The local bearer path is specifically for loopback/custom demos; it is not documentation for the
separate hosted installation-auth protocol.

### What I would improve next

The next validation would be a small pilot with 5–10 solo founders measuring setup friction,
eligible intent, disclosure comprehension, opt-out behavior, retention, and actual cost offset. In
parallel, I would test demand with 2–3 commercial or affiliate partners before building real
settlement. Engineering follow-ups would add a labeled relevance set, latency and cost benchmarks,
stronger guardrails, attribution, fraud controls, and a clearer campaign policy surface.

The ordering matters: prove founders use the agent, test whether they understand and accept the
separate sponsorship, then ask partners to fund it. Until those gates pass, AdRouter demonstrates a
privacy-conscious sponsored-compute mechanism and a basis for experiments—not a proven marketplace.

## Repository review guide

- `README.md` — architecture, credential boundaries, setup, model catalog, and disclosures.
- `router/src/lib/agent-routing.ts` — independent sponsor/model routing, ad-first streaming, and
  settlement.
- `router/src/lib/providers/agnes.ts` — Agnes adapter configuration and thinking mapping.
- `router/scripts/verify-launchpad.ts` — offline LaunchPad runtime and catalog assertions.
- `adrouterCLI/packages/ai/src/api/adrouter.ts` — CLI Router request and stream parsing.
- `adrouterCLI/packages/coding-agent/src/modes/interactive/components/adrouter-ad-panel.ts` —
  display-only sponsor UI.
- `adrouterAgent/src/runtime/router-client.ts` — Agent transport and sponsor-data removal.
- `docs/RESULTS.md` — executed checks, outcomes, and explicitly skipped live/native gates.
- `docs/SOURCE_SNAPSHOT.md` — exact source baselines and sanitization decisions.

## How to run

Follow the three-terminal instructions in `README.md`. Router requires a live Agnes key at runtime;
CLI/Agent use only a separate local Router bearer. All repository verification is offline.

## Submission links

- GitHub: https://github.com/HappyCool121/launchpad-submission-
- YouTube: not included in this repository; no recording URL was supplied.
