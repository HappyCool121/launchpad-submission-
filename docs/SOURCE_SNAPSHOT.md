# Source snapshot and sanitization

Export date: 2026-08-05 (Asia/Singapore).

| Destination | Source | Baseline |
| --- | --- | --- |
| `router/` | `/Users/ahmadzuhri/antigravity/3days/router/backend/` | `d6b32a25e3d20bde5b7b82cb02ac116a1d9ce4e5` on `main`; clean and one commit ahead of its origin at export. |
| `adrouterCLI/` | `/Users/ahmadzuhri/antigravity/3days/adrouter_release/adrouterCLI/` | `e3c1bd06b9986b42761ea27f8057eb92046a688b` on `codex/public-friendly-readme`; clean at export. Manifest source reports beta.18. |
| `adrouterAgent/` | `/Users/ahmadzuhri/antigravity/3days/adrouter_release/adrouterAgent/` | Base `3db591b264f18f47a798a8b65838ae832bb6d6fb` on `codex/agent-parity-roadmap`, plus the intentional current tracked/untracked source and tests. |

Router and CLI were exported from tracked source. Agent was exported from tracked working-tree files
plus an explicit allowlist of untracked `src/`, `tests/`, and catalog-check source needed by the
current parity implementation. Generated files were not inferred to be source.

Excluded from all components:

- nested `.git` metadata and workspace `AGENTS.md` files;
- ignored `.env*`, credentials, `.protected/`, sessions, local databases, logs, and caches;
- `node_modules`, `dist`, `out`, `.vite`, coverage, browser/Electron test artifacts;
- component GitHub release/promotion workflows, deployment inputs, release provenance, native
  launcher publication assets, candidate/publish/tag helpers, and release manifests;
- Router WebUI, Supabase/infrastructure/deployment directories, landing page, OpenCode, and pitch
  repository files beyond the requirements restated in `SUBMISSION.md`.

Submission-specific changes are deliberately isolated here: live-only LaunchPad configuration,
four-model API filtering, Agnes defaults, loopback client setup, detailed documentation, offline
checks, and credential-free CI. The source repositories were not edited.
