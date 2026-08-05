# @adrouter/cli

`@adrouter/cli` provides the `adrouter` terminal coding agent and the
`adrouter-profile` profile manager.

The [canonical product guide](https://github.com/adrouter/adrouterCLI/blob/main/docs/about.md)
defines the official catalog, authentication boundary, streaming lifecycle, and sponsor behavior.

Install the public beta with Node.js 22.19 or newer:

```sh
npm install --global --ignore-scripts @adrouter/cli@beta
adrouter --version
adrouter --json doctor
```

Start `adrouter` in a trusted project, then use `/login adrouter` with an
approved browser installation. Sponsor content is display-only and is never inserted into
model messages, tool payloads, commands, or edits.

Profiles use the implemented `set`, `list`, `apply`, and `restore` interface:

```sh
adrouter-profile set work --provider adrouter --model deepseek-v4-flash
adrouter-profile list
adrouter-profile apply work --dry-run --no-launch
adrouter-profile restore --dry-run
```

Optional unsigned native keyboard helpers are deliberately omitted from this
beta. On macOS, modifier-key detection is limited to terminal input events. On
Windows, Shift+Tab may depend on the terminal's escape-sequence support. The
JavaScript terminal path remains available on every supported npm platform.

Complete installation, trust, privacy, configuration, diagnostics, update,
uninstallation, troubleshooting, support, and security-reporting guidance is in
the [repository README](https://github.com/adrouter/adrouterCLI#readme).

AdRouterCLI is derived from Pi by Mario Zechner. The upstream MIT license,
attribution, third-party notices, and bundled-source inventory are preserved in
the published package and source repository.
