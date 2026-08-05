# Plan: LaunchPad Submission Repository

## Goal

Create a clean public repository at `antigravity/launchpad/` that packages runnable, local demo
snapshots of the AdRouter backend, AdRouterCLI, and AdRouter Agent for the LaunchPad challenge, then
verify it offline and push it to `HappyCool121/launchpad-submission-`.

## Context

- The source workspace is a consolidation directory, not a monorepo. Router, CLI, Agent, and pitch
  material have independent histories and instructions.
- The submission is an update to an existing challenge entry. The local destination is
  `/Users/ahmadzuhri/antigravity/launchpad/`; the requested public remote is
  `https://github.com/HappyCool121/launchpad-submission-`.
- The submission is CLI-first. The Agent is included as runnable source, but native packaging,
  live-provider acceptance, and platform acceptance are not submission gates.
- The Router demo must require a live Agnes API credential at runtime. Preparation and CI must not
  make live Agnes calls or require provider credentials.
- The public Agnes catalog is intentionally limited to `agnes-2.0-flash`, `agnes-2.5-flash`,
  `agnes-2.5-pro`, and `agnes-2.5-pro-alpha`, with `agnes-2.5-flash` as the default.
- Current source snapshots are Router `d6b32a25e3d20bde5b7b82cb02ac116a1d9ce4e5`, CLI
  `e3c1bd06b9986b42761ea27f8057eb92046a688b`, and Agent base
  `3db591b264f18f47a798a8b65838ae832bb6d6fb` plus its current intentional working-tree parity work.
- The previous root `PLAN.md` described an unrelated rollout. The user explicitly authorized its
  replacement with this plan.

## Research Summary

- `pitch/comp/launchpad.md` requires a short summary, an approximately 1,000-word write-up, exact
  repository review paths, run instructions, honest external-service/mock/incomplete disclosures,
  a public GitHub main-page link, and a playable YouTube link if one is supplied.
- The current challenge page at `https://symposium.acacia-ai.org/` emphasizes that judges should be
  able to understand the work, see it operate, and inspect the reasoning/evidence. The forwarded
  local brief remains the submission-specific formatting authority.
- Current Router source contains the four requested Agnes models and their model-specific limits.
  Current CLI and Agent source already contain supported loopback/custom bearer-key paths.
- GitHub CLI authentication was not valid at discovery time. Repository construction and offline
  verification can proceed; push requires re-authentication or another working Git credential.
- No live Agnes validation is needed. Offline provider-adapter and integration fixtures must prove
  request shaping, streaming, catalog restriction, and credential boundaries without external
  network calls.

## Constraints

- Never read, copy, print, or commit current `.env*`, `.protected/`, keys, tokens, local databases,
  browser/session state, generated release assets, provenance artifacts, or nested Git metadata.
- Snapshot current executable source, including the Agent's intentional uncommitted source/tests,
  while excluding caches, build output, deployment infrastructure, publication workflows, and
  release-only machinery.
- Keep the provider credential backend-only. CLI and Agent receive only a local Router URL and a
  separate local bearer credential.
- Preserve sponsor metadata as display/accounting data only; it must never enter model messages,
  tools, commands, edits, patches, or compacted context.
- Clearly label seeded sponsor inventory and subsidy as synthetic/simulated. Do not claim live
  advertisers, revenue, conversion, user acceptance, or validated economics.
- Preserve component licensing: CLI remains MIT, Agent remains Apache-2.0, and Router receives an
  explicit source/provenance notice without applying an unsupported blanket license.
- Preserve existing source repositories and dirty user work. Build the submission as a new clean
  repository with no nested `.git` directories.
- Keep the implementation reviewable and avoid new runtime dependencies unless required by the
  copied source.

## Out of Scope

- Router WebUI, Supabase service deployment, infrastructure-as-code, production identity, hosted
  installation auth, advertiser operations, and database migrations.
- OpenCode, the landing page, npm publication, native Agent packaging/signing/notarization, tags,
  releases, deployments, traffic changes, or hosted database changes.
- Live Agnes calls during construction, testing, or CI.
- A new challenge submission, fabricated demo video, placeholder YouTube claim, or edits to the
  challenge form.
- Unrelated source cleanup, dependency upgrades, UI redesign, or re-licensing.

## Reversibility

- Source repositories remain untouched except for this consolidation-level `PLAN.md`.
- The new repository records exact source SHAs and snapshot rules so it can be regenerated.
- Submission-specific behavior stays within the new repository and does not alter deployed or
  published AdRouter products.
- Keep implementation phases aligned with commits: scaffold/snapshot, runtime contract, docs/tests,
  then final verification.
- If the destination already exists, inspect and preserve it before any replacement; never delete
  an unknown directory recursively.

---

## Step A: Create the sanitized repository and provenance record

### Status

`done`

### Objective

Create one clean repository containing reviewable snapshots of the three requested components and
an explicit record of what was included and excluded.

### Tasks

- [x] Inspect the destination and remote without modifying unknown content.
- [x] Create the root scaffold, ignore rules, source manifest, component license map, and provenance
      documentation.
- [x] Export Router backend and CLI tracked source through explicit file lists.
- [x] Export Agent tracked source plus an explicit allowlist of its intentional untracked source and
      tests.
- [x] Exclude secrets, nested Git metadata, caches, build output, release/provenance assets,
      deployment inputs, and publication workflows.

### Relevant Files

- `router/backend/`
- `adrouter_release/adrouterCLI/`
- `adrouter_release/adrouterAgent/`
- `launchpad/NOTICE.md`
- `launchpad/docs/SOURCE_SNAPSHOT.md`

### Expected Changes

- create: `launchpad/` repository scaffold and sanitized component snapshots
- modify: `/Users/ahmadzuhri/antigravity/3days/PLAN.md`
- no change: source repositories and their Git histories

### Do Not Modify

- `router/`, `adrouter_release/adrouterCLI/`, `adrouter_release/adrouterAgent/`, and `pitch/`
- ignored secret/private paths or generated output

### Commands

```bash
git -C router status --short --branch
git -C adrouter_release/adrouterCLI status --short --branch
git -C adrouter_release/adrouterAgent status --short --branch
git -C launchpad status --short
```

### Acceptance Criteria

- [x] The new repository has no nested Git metadata or copied ignored credentials.
- [x] Every component has an exact source baseline and inclusion/exclusion note.
- [x] Agent working-tree source is included without copying generated/release/private state.
- [x] Component licenses remain attributable and no blanket Router license is invented.

### Validation Results

- Source repository status and SHAs: passed during discovery on 2026-08-05.
- Destination repository inspection: passed; the destination was absent and a fresh staging tree was created.
- Submission boundary scan: passed; no nested Git metadata, private env, protected, release provenance, or publication workflow paths remain.

### Findings / Notes

- Router and CLI were clean at discovery; Router was one commit ahead of its origin.
- Agent intentionally contains extensive tracked and untracked parity work, so a plain `git archive`
  would omit required latest source.

---

## Step B: Implement the live-only local Agnes demo contract

### Status

`done`

### Objective

Make the copied Router, CLI, and Agent work together on loopback with separate backend/provider and
client/Router credentials, exposing only the four requested Agnes models.

### Tasks

- [x] Add a submission demo profile that fails closed when `AGNES_API_KEY` or the local Router bearer
      is absent and rejects mock provider execution.
- [x] Restrict `/v1/models` and turn validation to the four Agnes IDs and default to
      `agnes-2.5-flash`.
- [x] Preserve ad-first NDJSON, tool/thinking/text events, settlement, `done`, sanitized errors, and
      sponsor/model-context separation.
- [x] Configure CLI loopback startup and catalog/defaults without passing the Agnes credential to
      the client.
- [x] Configure Agent loopback defaults and safe local bearer storage without claiming native or
      live acceptance.
- [x] Add checked-in `.env.example` schemas containing placeholders only.

### Relevant Files

- `launchpad/router/backend/src/`
- `launchpad/adrouterCLI/packages/`
- `launchpad/adrouterAgent/src/`
- component `.env.example` and package manifests

### Expected Changes

- modify: submission-copy runtime configuration, model catalog, scripts, and focused tests
- create: local submission/demo entry points and credential-free configuration examples
- delete: submission-copy-only hosted/deploy/release entry points that are outside scope

### Do Not Modify

- Original source repositories.
- Sponsor isolation, local HTTP loopback restriction, approval boundaries, or secret redaction.
- Generated build output by hand.

### Commands

```bash
cd launchpad/router/backend && npm run typecheck && npm test && npm run build
cd launchpad/adrouterCLI && npm run check:submission
cd launchpad/adrouterAgent && npm run check:submission
```

### Acceptance Criteria

- [x] A runtime user must supply a live Agnes key to Router, while CLI and Agent never receive it.
- [x] `/v1/models` exposes exactly the four requested Agnes models with `agnes-2.5-flash` documented
      and selected as default.
- [x] Missing provider/local credentials and requested mock mode fail with bounded safe errors.
- [x] Offline tests prove catalog, request shaping, stream ordering, and credential separation.
- [x] Seeded sponsor inventory and subsidy remain clearly synthetic/simulated.

### Validation Results

- Router checks: passed typecheck, LaunchPad unit/integration, full backend suite, and build.
- CLI submission check: passed four-workspace build, boundary check, focused tests, and broad workspace suites.
- Agent submission check: passed typecheck, 36 unit files/129 tests, 3 integration files/12 tests, catalog, bundle, and boundary checks.

### Findings / Notes

- Runtime execution may call the live Agnes OpenAI-compatible endpoint; no preparation/CI command
  may do so.

---

## Step C: Write judge-facing documentation and offline evidence

### Status

`done`

### Objective

Make the repository understandable and reproducible without requiring judges to infer architecture,
credential boundaries, evidence strength, or known limitations.

### Tasks

- [x] Write the root README with architecture, prerequisites, three-terminal CLI-first setup,
      credential boundaries, four-model catalog, disclosures, and exact review paths.
- [x] Write detailed Router, CLI, and Agent READMEs describing behavior, configuration, source map,
      validation, and limitations.
- [x] Add `SUBMISSION.md` with the short summary and approximately 1,000-word challenge write-up.
- [x] Add architecture, decisions, demo script, results/evidence, source snapshot, and security notes.
- [x] Add an offline fake Agnes upstream/integration fixture that never binds to or contacts an
      external host.
- [x] Add CI jobs pinned to each component's required Node version with no secrets.

### Relevant Files

- `launchpad/README.md`
- `launchpad/SUBMISSION.md`
- `launchpad/router/README.md`
- `launchpad/adrouterCLI/README.md`
- `launchpad/adrouterAgent/README.md`
- `launchpad/docs/`
- `launchpad/.github/workflows/ci.yml`

### Expected Changes

- create: judge-facing docs, demo procedure, offline evidence, and CI
- modify: copied component READMEs and scripts for submission-specific operation

### Do Not Modify

- Product claims beyond available implementation/tests.
- Insert a YouTube placeholder that could be mistaken for a playable demo.

### Commands

```bash
cd launchpad && npm run check:submission
```

### Acceptance Criteria

- [x] Judges can understand, run, and review the primary flow from the root README.
- [x] Every required brief section and exact review path is present.
- [x] External dependencies, synthetic data, incomplete areas, and unvalidated claims are explicit.
- [x] CI and local preparation need no credentials and make no live Agnes request.
- [x] Each of the three components has a detailed, accurate README.

### Validation Results

- Documentation checks: passed; 16 required files and an 818-word challenge write-up.
- Offline integration fixture: passed with two local loopback servers and no external request.
- CI syntax/boundary review: passed manual review and the root credential/private-path checker.

### Findings / Notes

- A demo video URL will only be included if a real public/unlisted URL is available.

---

## Step D: Final verification and cleanup

### Status

`done`

### Objective

Prove the exported repository is clean, credential-free, reproducible, and ready for public review,
then commit and push the exact verified state.

### Tasks

- [x] Run all component typechecks/tests/builds and the offline cross-component fixture.
- [x] Run secret, private-path, nested-Git, catalog, documentation, and repository-boundary scans.
- [x] Review the final diff and remove temporary/debug/generated files.
- [x] Initialize/confirm `main`, commit the verified repository, and require a clean status.
- [x] Move the local repository to `/Users/ahmadzuhri/antigravity/launchpad/` if built in a writable
      staging location.
- [x] Authenticate GitHub CLI if needed, configure the requested remote, push `main`, and verify the
      public repository main page and anonymous file access.
- [x] Record exact validation results and remaining risks in this plan and `docs/RESULTS.md`.

### Relevant Files

- all `launchpad/` source, tests, docs, scripts, workflows, and Git metadata
- `/Users/ahmadzuhri/antigravity/3days/PLAN.md`

### Expected Changes

- modify: validation/result records
- create: clean Git commit and requested remote branch
- no change: source repository histories, hosted services, npm channels, or challenge form

### Do Not Modify

- Existing source remotes, tags, releases, deployments, credentials, or hosted state.
- The target remote beyond pushing the submission repository's `main` branch.

### Commands

```bash
cd launchpad
npm run check:submission
git diff --check
git status --short
git log -1 --oneline
gh repo view HappyCool121/launchpad-submission-
```

### Acceptance Criteria

- [x] All offline checks pass and every skipped/live/native check has a documented reason.
- [x] Secret scans find no credentials and the repository contains no nested Git metadata.
- [x] The final commit exactly matches the tested tree and local status is clean.
- [x] `main` is pushed to `HappyCool121/launchpad-submission-` and the repository main page is
      publicly readable.
- [x] No deploy, npm publish, tag, release, live provider call, or challenge-form mutation occurred.

### Validation Results

- Full submission gate: passed across Router, CLI, Agent, and root checks; see `docs/RESULTS.md`.
- Secret/private boundary scan: passed with known synthetic credential fixtures allowlisted narrowly.
- GitHub push/public verification: passed; the public empty repository accepted `main` without a force push.

### Findings / Notes

- If GitHub authentication remains unavailable after three confirmed attempts, finish the clean
  local repository and report the single exact authentication action required from the user.

---

## Follow-up Work

- Record and add a real public/unlisted YouTube demo URL when available.
- Run a live Agnes smoke only when a disposable submission-only provider key is explicitly supplied
  in the operator environment.
- Run native Agent acceptance on the intended macOS/Windows platforms if the submission later makes
  packaged-desktop claims.
- Update the existing LaunchPad entry with the final public repository URL outside this code task.

## Decision Log

| Date | Decision | Rationale | Impact |
| --- | --- | --- | --- |
| 2026-08-05 | Build a new snapshot repository instead of combining Git histories. | The source workspace contains independent repositories and intentional dirty Agent work. | Preserves provenance and produces a judge-friendly single repo. |
| 2026-08-05 | Require live Agnes only when a user runs the demo; keep preparation and CI offline. | Protects credentials and avoids brittle external-service validation. | Offline fixtures prove the contract; live output remains an explicit runtime dependency. |
| 2026-08-05 | Expose four Agnes models and default to `agnes-2.5-flash`. | This is the user's requested LaunchPad catalog and current source supports all four. | Simplifies the judge path and prevents non-Agnes routing. |
| 2026-08-05 | Make CLI the primary demo and include Agent without native/live acceptance claims. | The terminal flow is the most reproducible challenge path. | Agent remains inspectable/runnable without blocking the submission on packaging. |
| 2026-08-05 | Preserve per-component licensing. | CLI and Agent have different existing licenses, and Router lacks authority for blanket relicensing. | Root notices map provenance without inventing new rights. |
