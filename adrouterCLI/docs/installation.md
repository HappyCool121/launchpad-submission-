# Installation

AdRouterCLI requires Node.js 22.19 or newer. On macOS and Linux, install Node with the official installer or a maintained version manager. On Windows, install Node for all users or ensure the per-user npm binary directory is on `PATH`.

```sh
npm install --global --ignore-scripts @adrouter/cli@beta
adrouter --version
adrouter --help
adrouter --json doctor
```

This installs one public package. Its private `@adrouter/ai`, `@adrouter/tui`,
and `@adrouter/agent-core` runtime packages are embedded in the CLI tarball and
are not fetched as separate AdRouter registry packages.

Hosted authentication is installation-bound. `/login adrouter` first opens and prints the AdRouter
sign-in page. After the user confirms that browser sign-in is complete with the native Done action, the CLI
creates an Ed25519 key, sends the installation request, and opens and prints the user-approval page.
An already-open signed-in AdRouter tab receives the same approval request as a modal. Failed, denied,
cancelled, or interrupted attempts remove that pending key and best-effort cancel server state, so
restarting and running `/login adrouter` begins cleanly. The approved private key plus rotating refresh credential are stored
with user-only file permissions. Access tokens are not persisted. This is classified as
`file_protected`, not OS-keychain encrypted; use `/logout adrouter` before disposing of a machine and
review remote installations in the WebUI if revocation could not be confirmed.

The installed AdRouter model catalog is usable offline and contains `agnes-2.0-flash`,
`agnes-2.5-flash`, `agnes-2.5-pro`, `agnes-2.5-pro-alpha`, `deepseek-v4-flash`,
`deepseek-v4-pro`, `mimo-v2.5`, and `mimo-v2.5-pro`. All eight use a 131,072-token total context
with a 4,096-token output cap.
Hosted discovery may validate that contract but must not silently expand it and delay local compaction.

The doctor result must report `"installation":{"kind":"packaged","deployable":true}`
for a supported deployment. A source-linked or incomplete installation can run
some metadata commands but is not deployment-qualified.

If the command is missing, inspect `npm prefix --global`. Add its executable directory to your shell `PATH`; on Windows this is commonly the npm prefix itself, while Unix installations commonly use its `bin` directory. Restart the terminal after changing `PATH`.

For a published native archive, download the archive, `SHA256SUMS`, and SBOM from the same prerelease. Confirm the asset is listed as eligible in `release-manifest.json`, then run `sha256sum -c SHA256SUMS` (or `shasum -a 256 -c SHA256SUMS` on macOS) and `gh attestation verify <asset> --repo adrouter/adrouterCLI`. Do not install an artifact marked blocked.

Upgrade with:

```sh
npm install --global --ignore-scripts @adrouter/cli@beta
```

Uninstall with:

```sh
npm uninstall --global @adrouter/cli
```

Uninstalling does not remove `~/.adrouter/agent`. Back it up before deleting it. Never use Gatekeeper or SmartScreen bypass instructions; a missing or invalid platform signature is a release defect.
