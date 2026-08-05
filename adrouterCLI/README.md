# AdRouterCLI — LaunchPad demo client

AdRouterCLI is the primary judge path: a terminal coding agent that sends model work to the local
Router, renders sponsorship in a separate panel, and associates final settlement with the completed
turn.

## Build and run

Use Node.js 22.19 or newer.

```bash
cp .env.example .env.local
# Set ADROUTER_API_KEY to the same new local bearer used by Router.
npm ci --ignore-scripts
npm run build
```

Launch from a disposable project:

```bash
cd /path/to/disposable-project
npm --prefix /path/to/launchpad/adrouterCLI run start:launchpad -- \
  --provider adrouter --model agnes-2.5-flash
```

The launcher reads the ignored client `.env.local`, forces live Router mode, defaults to Agnes 2.5
Flash, and refuses to start if `AGNES_API_KEY` is present. CLI needs only the Router URL/bearer;
Router owns the provider key. Run `/ads` to inspect sponsorship and `/ads off` to disable it.

## How it works

- `packages/ai/src/api/adrouter.ts` builds `/v1/agent/turn` requests, parses bounded NDJSON, and
  keeps ad/settlement events distinct from assistant content.
- `packages/ai/src/providers/adrouter.models.ts` contains the generated upstream catalog used as a
  compatibility baseline; the local Router's live catalog narrows the submission to four Agnes
  models.
- `packages/coding-agent/src/core/model-resolver.ts` selects `agnes-2.5-flash` in LaunchPad mode.
- `packages/coding-agent/src/modes/interactive/components/adrouter-ad-panel.ts` renders only the
  display metadata; `adrouter-settlement-entry.ts` renders final accounting.
- Workspace trust and per-command/per-mutation approval behavior are preserved from the current CLI
  source.

## Verification

```bash
npm run check:submission
npm run test --workspace @adrouter/ai -- test/adrouter.test.ts test/adrouter-config.test.ts
npm run test --workspace @adrouter/cli -- test/adrouter-ad-panel.test.ts test/adrouter-session.test.ts
```

No check needs Agnes. Build output, sessions, trust state, `.env.local`, and package/release artifacts
are excluded from Git. This snapshot is a challenge demo, not an npm publication source.
