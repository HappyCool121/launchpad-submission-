# Upstream and provenance

This repository was created with `git archive` from the reviewed upstream
commit
[`e9ba9f3753ba8bc40fb5fbb84b61751e10ea9471`](https://github.com/badlogic/pi-mono/commit/e9ba9f3753ba8bc40fb5fbb84b61751e10ea9471).
No upstream Git metadata, ignored files, build output, dependency directory,
environment file, cache, or personal state was copied.

The codebase derives from Mario Zechner's Pi project at
<https://github.com/badlogic/pi-mono>. The original MIT copyright and license
are preserved in [`LICENSE`](LICENSE), package licenses, adapted-document
acknowledgements, and historical changelogs. AdRouter modifications include
hosted-gateway support, beta authentication, display-only sponsorship, AdRouter
state isolation, profiles, branding, bundled features, packaging, and release
policy.

Before the first public commit, the export removed private planning and local-operation material, internal `.pi` tooling, inherited contributor-gate automation, and the unpublished experimental orchestrator. Public release automation, governance, documentation, package metadata, provenance records, and boundary checks were then added.

For a future monorepo import, fetch this repository and use a history-preserving subtree import or merge with unrelated histories. Preserve all `v*` tags, record the imported repository URL and commit, and do not squash the standalone history.
