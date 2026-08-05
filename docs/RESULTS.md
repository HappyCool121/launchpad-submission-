# Verification results

This file records checks against the exported submission repository. It distinguishes offline source
evidence from live/native evidence.

## Completed during construction

- Source repository status and exact base SHAs were captured before export.
- Ignored environment files, nested Git metadata, generated output, protected bundles, deployment
  workflows, release provenance, and publication helpers were excluded from the submission tree.
- Root `npm run check:submission`: passed; 16 required documents/configs, 1,441 source files,
  818-word write-up, credential/private-path rules, and component boundary checks.
- Router Node.js 22.19.0: typecheck, LaunchPad configuration test, offline fake-Agnes integration,
  complete backend test suite, and production TypeScript build passed. The integration proves four
  exposed Agnes models, default live execution, ad-first/text/settlement/done order, backend-only
  provider authorization, sponsor-data exclusion, and mock rejection.
- CLI Node.js 22.19.0: four-workspace build and submission boundary check passed. Focused AdRouter
  suites passed 31 AI tests and 11 coding-agent tests. The broad workspace run passed the TUI suite,
  16 agent-core files/182 tests, and 177 coding-agent files/1,492 tests (45 skipped). After adapting
  the release-manifest fixture to the submission boundary, the complete AI suite passed 85 files/
  548 tests (710 skipped).
- Agent Node.js 25.9.0: typecheck passed; 36 unit files/129 tests and 3 integration files/12 tests
  passed; model and bundle catalogs passed; the submission boundary check passed. The local RPC
  socket test was run with normal host permissions because the workspace sandbox blocks Unix socket
  creation.

## Final repository state

- Verified implementation commit: `934c641` (`fix(agent): allow trusted sandbox runtime helper`).
- Local repository: `/Users/ahmadzuhri/antigravity/launchpad/` on clean `main`.
- Public remote: `https://github.com/HappyCool121/launchpad-submission-`.
- GitHub Actions run `31022727609` passed all boundary, Router, CLI, and Agent jobs, including the
  credential-free fake-Agnes path and Linux sandbox integration tests.
- The remote was confirmed public and empty before the first normal (non-force) push. `main` was
  pushed successfully; the final documentation-only commit records these results.

## Intentionally not run

- Live Agnes smoke: requires an operator-supplied submission-only key; preparation and CI are
  deliberately credential-free.
- Native Agent packaging/signing/notarization and physical Windows acceptance: outside the
  submission claims and scope.
- Deployments, npm publication, tags, releases, hosted databases, traffic gates, and challenge-form
  changes: not authorized or required.
