# Changelog

All notable changes to AdRouter Agent are documented here.

## Unreleased

### Added

- Added exact Router model-catalog validation, token-aware sponsor-free context compaction, safe
  checkpoints, and durable session fork/search/redacted import/export workflows.
- Added immutable approved structured file, dependency, script, network, and Git operations plus a
  capacity-bounded workspace/Git lease scheduler and opt-in bounded child delegation.
- Added exact-digest declarative bundles and GUI-paired Ed25519 automation over owner-only local IPC,
  with dependency-free launcher `pair` and `rpc` commands.
- Added backward-readable RFC 8785/Ed25519 release-manifest schema 4, fixed-origin signed update
  checks, healthy-start rollback state, and protected macOS/Windows signing hooks.

### Security

- Every mutation and Git write remains bound to an expiring one-use operation and a fresh exact
  approval; scheduler concurrency, delegation, automation, network, outputs, and queues are bounded.
- Release/update application remains disabled until a production public key and signing identities
  are provisioned and exact native/physical schema-2 acceptance is recorded.

## [0.1.0-beta.12] - 2026-08-01

### Added

- Added sign-in-first Desktop Agent enrollment: the browser authenticates first, and the Agent
  creates its installation key and approval request only after the user selects **Continue**.
- Added main-process controls to reopen or copy the sign-in/approval link and signed best-effort
  cancellation for abandoned or failed authorizations.

### Changed

- Existing installations remain active while a replacement is pending and are replaced only after
  the candidate installation completes signed profile validation.
- Pending approvals resume after restart, while the pre-Continue browser handoff remains memory-only.
- The hosted AdRouter WebUI now distinguishes Desktop Agent handoffs and completion guidance from
  AdRouterCLI without changing the shared backend protocol.

### Security

- Kept browser handoff identifiers, direct enrollment URLs, key generation, clipboard access, and
  browser launching out of the sandboxed renderer.
- Sanitized enrollment and network failures so raw platform or server errors are not exposed to the
  renderer.

## [0.1.0-beta.11] - 2026-07-29

### Security

- Pinned transitive build dependencies to `tar@7.5.22` and `tmp@0.2.7`, removing the open
  path-traversal, archive-write, denial-of-service, and critical decompression advisory roots.
- Replaced packaged staging-origin substring matching with parsed exact JavaScript literal checks
  in both main and renderer bundles, backed by fresh-install packaged acceptance.
- Added a fail-closed build audit that rejects every new high or critical advisory while narrowly
  bounding the known dev-only Electron Forge `brace-expansion` advisory.

### Changed

- CI and immutable release-tag validation now run both production and build-tool dependency audits.
- Beta.11 publishes under npm `candidate` first and cannot move `beta` or `latest` until exact
  acceptance includes a physical Windows 11 x64 cohort.

## [0.1.0-beta.10] - 2026-07-28

### Added

- Added a persisted light/dark theme with an accessible bottom-left switch and smooth whole-app
  theme transitions that respect reduced-motion preferences.

### Changed

- Refined the chat composer, sponsor banners, and approval surfaces into opaque flat cards, with
  improved dark-mode colors, clearer approval actions, and extra end-of-thread clearance for the
  post-stream banner.
- Made drawers, composer panels, suggestions, and theme motion slower and smoother across the app.
- Made model/custom-instruction settings collapsible and improved settings-section spacing.
- Simplified the Changes drawer to show only changed lines in a familiar before/after diff view.

### Fixed

- Bottom sponsor banners now wait until model streaming finishes, and internal final-evidence
  payloads no longer appear in the chat transcript.
- Dark mode now keeps the main composer, settings sign-out action, and permission panel fully
  opaque with readable contrast.

## [0.1.0-beta.9] - 2026-07-28

### Fixed

- Changes now render from the bundled Monaco editor under the desktop app's strict offline content
  security policy instead of remaining indefinitely on a loading state.
- Switching projects or starting a new chat now clears the previous thread and diff state
  immediately, preventing stale workspace content from remaining visible.

### Changed

- Packaged Electron acceptance now verifies a rendered Monaco diff and an empty transcript after
  starting a new chat, protecting both functional fixes at the release boundary.

## [0.1.0-beta.8] - 2026-07-27

### Added

- User-approved Desktop installations with OS-encrypted Ed25519 keys, resumable WebUI approval,
  rotating refresh credentials, signed profile/turn requests, and privileged revocation.
- Redacted installation diagnostics, exact-candidate authentication acceptance validation, and a
  packaged manual smoke mode that never accepts bearer credentials.

### Changed

- Official hosted origins now use installation-bound authentication. Explicit local and custom
  routers retain an isolated advanced bearer-token path.
- Release and promotion workflows are credential-free; manual exact-artifact cohorts provide hosted
  authentication evidence before channel promotion.

### Security

- Private keys, refresh credentials, device codes, access tokens, nonces, and proofs remain outside
  renderer IPC, local journals, model/tool context, workflow secrets, and diagnostic output.
- The utility process can request protected headers only for bounded exact-byte profile and agent
  turn requests through a dedicated allowlisted main-process broker.

## [0.1.0-beta.7] - 2026-07-26

### Added

- Device-local sign out clears only the OS-encrypted AdRouter API credential and returns to
  prefilled onboarding so users can replace a rotated key without losing projects, chats, or
  preferences.
- Canonical jellyfish branding and Lucide controls now carry through the first-run experience,
  workspace toolbar, chat empty state, native app bundle, executable, and Linux window identity.

### Changed

- The desktop chat and tiered sponsor surfaces now more closely follow the shared WebUI ivory/blue
  design while retaining desktop project, approval, and review controls.
- History slides in and out from the left; Changes and Settings slide in and out from the right,
  with reduced-motion behavior preserved.

### Security

- Sign out remains a privileged main-process operation, is rejected while an agent task is active,
  and never exposes credential plaintext to the renderer.

## [0.1.0-beta.6] - 2026-07-26

### Fixed

- The Windows launcher now accepts Electron Forge's verified flat portable ZIP
  layout while continuing to reject absolute paths, drive-qualified paths,
  traversal, ambiguous path segments, and escaping symbolic links.
- Cross-platform promotion smokes no longer cancel healthy operating-system
  jobs when another matrix member fails, preserving complete deployment
  evidence before public distribution tags can move.

## [0.1.0-beta.5] - 2026-07-26

### Fixed

- The Windows launcher now binds ZIP inspection and extraction paths through
  explicit PowerShell parameters, so a verified portable archive is listed and
  expanded correctly on Windows 11.
- Windows npm smoke tests invoke the native `.cmd` launcher shim instead of the
  MSYS shell shim, preventing runner drive-letter translation from corrupting
  the installed package path.

## [0.1.0-beta.4] - 2026-07-26

### Added

- Portable Ubuntu 24.04 x64 and Windows 11 x64 desktop distributions alongside
  the existing universal macOS application.
- Platform-specific sandbox readiness diagnostics, secure credential-store
  checks, launcher installation paths, and native CI acceptance jobs.
- The live `https://api-staging.adrouter.co` origin as the default for fresh
  desktop installations and the protected release canary.

### Security

- Linux refuses weak `basic_text` credential storage, Windows uses DPAPI, and
  command tools remain unavailable until the platform sandbox is ready.
- Release manifests now select an exact OS/CPU artifact and verify its checksum,
  archive layout, executable, and target-specific integrity policy.

### Fixed

- The macOS distribution verifier now selects only the macOS universal ZIP when
  Linux and Windows artifacts are present in the same Forge output tree.

### Known limitations

- Linux and Windows portable beta artifacts are unsigned.
- Updates remain manual and only one agent run can be active at a time.

## [0.1.0-beta.3] - 2026-07-26

### Fixed

- The npm installer now accepts the standard relative framework symlinks inside
  an Electron macOS bundle while rejecting absolute, ambiguous, or escaping
  symlink targets before and after extraction.
- Anonymous registry propagation waits are long enough for a newly published
  candidate to become visible before macOS install smoke tests begin.

## [0.1.0-beta.2] - 2026-07-26

### Added

- First public-beta distribution of the universal macOS desktop application.
- Credential-free ad-hoc-signed universal ZIP delivery through GitHub Releases.
- Dependency-free npm launcher installation into `~/Applications` with
  checksum, archive, bundle identity, architecture, and integrity validation.
- Dependency-free `@adrouter/agent` npm installer and launcher with embedded
  release metadata, bounded downloads, checksum validation, safe extraction,
  signing verification, and Gatekeeper assessment.
- Immutable-tag release, protected staging/signing/publishing environments,
  SBOMs, artifact manifests, and GitHub artifact attestations.

### Security

- Production dependency resolutions override `brace-expansion` to `5.0.8` and
  `protobufjs` to `7.6.5`; reviewed Pi agent package versions remain unchanged.
- npm accepts no URL/checksum environment overrides and rejects unsupported
  platforms before downloading.

### Fixed

- Hosted AdRouter requests now leave `runtime_mode` unset when automatic routing
  is selected, preserving the server default and avoiding a rejected explicit
  `auto` value.

### Known limitations

- macOS only, with one active agent run at a time.
- Updates are downloaded and installed manually.
- A reachable AdRouter server and valid bearer token are required.

[0.1.0-beta.12]: https://github.com/adrouter/adrouterAgent/releases/tag/v0.1.0-beta.12
[0.1.0-beta.11]: https://github.com/adrouter/adrouterAgent/releases/tag/v0.1.0-beta.11
[0.1.0-beta.10]: https://github.com/adrouter/adrouterAgent/releases/tag/v0.1.0-beta.10
[0.1.0-beta.9]: https://github.com/adrouter/adrouterAgent/releases/tag/v0.1.0-beta.9
[0.1.0-beta.8]: https://github.com/adrouter/adrouterAgent/releases/tag/v0.1.0-beta.8
[0.1.0-beta.7]: https://github.com/adrouter/adrouterAgent/releases/tag/v0.1.0-beta.7
[0.1.0-beta.6]: https://github.com/adrouter/adrouterAgent/releases/tag/v0.1.0-beta.6
[0.1.0-beta.5]: https://github.com/adrouter/adrouterAgent/releases/tag/v0.1.0-beta.5
[0.1.0-beta.4]: https://github.com/adrouter/adrouterAgent/releases/tag/v0.1.0-beta.4
[0.1.0-beta.3]: https://github.com/adrouter/adrouterAgent/releases/tag/v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/adrouter/adrouterAgent/releases/tag/v0.1.0-beta.2
