# AdRouterCLI coding agent

Read the [canonical product guide](https://github.com/adrouter/adrouterCLI/blob/main/docs/about.md)
for the generated model table and official runtime contract.

This package provides the `adrouter` and `adrouter-profile` executables. AdRouterCLI is derived from [Pi](https://github.com/badlogic/pi-mono) by Mario Zechner and preserves Pi's original MIT license and copyright.

The public `0.81.0-beta.11` source and single bundled npm package are MIT licensed. Access to the hosted gateway remains invite-only.

```sh
npm install --global --ignore-scripts @adrouter/cli@beta
adrouter
```

At first launch, review the workspace trust prompt and run `/login adrouter`. Sign in at the opened AdRouter website, choose the native Done action, and approve the matching installation code in the WebUI; Open, Copy, and Quit remain available as recovery actions. The CLI keeps its approved Ed25519 key and rotating refresh credential in user-only file-protected storage, removes pending keys after failed attempts, and keeps access tokens in memory. The hosted beta supports `deepseek-v4-flash`, `deepseek-v4-pro`, `mimo-v2.5`, `mimo-v2.5-pro`, `agnes-2.0-flash`, `agnes-2.5-flash`, `agnes-2.5-pro`, and `agnes-2.5-pro-alpha`. Run `/ads` to inspect or immediately disable display-only sponsorship, and `/logout adrouter` to revoke and remove the installation.

Global state is stored under `~/.adrouter/agent`; project configuration is stored under `.adrouter/`. AdRouterCLI preserves user-approved command execution.

Full installation, usage, configuration, privacy, security, troubleshooting, and release documentation is maintained in the [public repository](https://github.com/adrouter/adrouterCLI#readme).

## Detailed reference

- [Usage](usage.md)
- [Providers](providers.md)
- [Settings](settings.md)
- [Sessions](sessions.md)
- [Security](security.md)
- [Extensions](extensions.md)
- [Skills](skills.md)
- [SDK](sdk.md)
- [RPC](rpc.md)
- [JSON mode](json.md)
- [Windows](windows.md)
- [Terminal setup](terminal-setup.md)

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and [BUNDLED_SOURCES.json](../BUNDLED_SOURCES.json) for bundled-source provenance.
