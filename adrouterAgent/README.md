# AdRouter Agent — LaunchPad desktop source

The Agent is an Electron desktop coding client included as a runnable secondary path. It discovers
the local Router catalog, runs the coding runtime in a utility process, keeps Node/filesystem access
out of the renderer, shows diffs, and requires fresh approval for mutations/general commands.

## Run in development

Use the pinned Node.js 25.9.0 runtime.

```bash
npm ci
npm run dev:launchpad
```

Onboarding defaults to `http://127.0.0.1:8787`. Enter the local Router bearer—not the Agnes key—and
test the connection. The bearer is encrypted via Electron `safeStorage`; the renderer does not
receive plaintext stored credentials. Choose `agnes-2.5-flash` and a disposable project.

## How it works

- `src/main/configuration-store.ts` validates loopback/custom URLs, verifies Router health/profile,
  encrypts the bearer, stores the live catalog, and prefers Agnes 2.5 Flash.
- `src/runtime/router-client.ts` rejects credentialed URLs/redirects, fetches the model catalog,
  strips sponsor-shaped data from context, and parses bounded NDJSON events.
- `src/runtime/agent-session.ts`, `tools.ts`, and `workspace.ts` coordinate model turns, tools,
  workspace containment, and approval requests.
- `src/preload/index.ts` exposes a narrow isolated bridge; `src/renderer/App.tsx` owns onboarding,
  projects/tasks, approvals, diffs, sponsor display, and settlement UI.
- Current source also includes durable task/session, bundle, structured-operation, and delegation
  parity work from the latest working tree.

## Verification

```bash
npm run check:submission
```

That gate runs typechecking, unit tests, integration tests, model/bundle catalog checks, and a
submission boundary check without a live provider. Native packaging/E2E, signing/notarization,
auto-update activation, live-provider acceptance, and physical Windows acceptance are deliberately
not claimed. The small `packages/agent-launcher/lib/` subset is retained only because current Agent
source type-checks its disabled signed-update diagnostics; publication/installer assets are absent.
