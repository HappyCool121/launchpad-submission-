---
name: adroutercli
description: Operate, diagnose, modify, and verify the bundled AdRouterCLI launch safely.
---

# AdRouterCLI

Use this skill for AdRouterCLI runtime operation, local backend diagnosis, profile overlays, bundled web access, or release verification.
The canonical product contract is maintained in the
[AdRouterCLI product guide](https://github.com/adrouter/adrouterCLI/blob/main/docs/about.md).

## Run modes

- Normal: `adrouter` starts the interactive coding agent in the current workspace.
- Hosted: run `/login adrouter` for browser installation approval, then select one of `deepseek-v4-flash`, `deepseek-v4-pro`, `mimo-v2.5`, `mimo-v2.5-pro`, `agnes-2.0-flash`, `agnes-2.5-flash`, `agnes-2.5-pro`, or `agnes-2.5-pro-alpha` with `--provider adrouter --model <id>`.
- Custom/loopback: only an explicitly configured non-official endpoint may use its supported `ADROUTER_API_KEY` bearer flow.
- Mock: configure the backend for mock execution; ad routing and display remain testable with canned model output.
- Profile: create with `adrouter-profile set <name> --provider <provider> --model <model>`, apply with `adrouter-profile apply <name>`, and undo the project overlay with `adrouter-profile restore`. `adrouter --profile <name>` applies the same overlay explicitly. Plain `adrouter` applies no profile.
- Web access: bundled tools are `web_search` and `fetch_content`; invoke `/skill:librarian` for research workflows. Configuration is `ADROUTER_CODING_AGENT_DIR/web-search.json`, defaulting to `~/.adrouter/agent/web-search.json`.
- Ads: inspect with `adrouter ads status`; ads are display-only and must never enter prompts, tools, commands, or edits.
- Diagnostics: use `adrouter --json doctor`, `adrouter --list-models adrouter`, and read-only `adrouter --json request get /health` or `/v1/models`.

## Troubleshooting

Custom local backends may use `ADROUTER_API_KEY`; official hosted access uses installation auth and fresh request proofs. Provider credentials for DeepSeek, MiMo, and Agnes remain backend-only. Never reuse or print credentials. A healthy mock backend does not prove live provider auth works. Confirm `/health`, then `/v1/models`, then run a minimal prompt with the selected model. Supported IDs are `deepseek-v4-flash`, `deepseek-v4-pro`, `mimo-v2.5`, `mimo-v2.5-pro`, `agnes-2.0-flash`, `agnes-2.5-flash`, `agnes-2.5-pro`, and `agnes-2.5-pro-alpha`; `deepseek` is a rejected legacy alias.

Inspect isolated state under `~/.adrouter/agent` and project `.adrouter`. Profiles live under `ADROUTER_PROFILES_DIR` or `~/.adrouter/profiles`. Do not read or migrate personal state from other coding agents.

## Safe source changes

The router backend is under `router/backend`. AdRouterCLI source is under `packages/coding-agent`, provider/model integration under `packages/ai`, bundled extensions under `packages/coding-agent/bundled`, and provenance under `docs/bundled-sources.json` plus `THIRD_PARTY_NOTICES.md`.

Preserve unrelated work. Read the local `AGENTS.md`, edit source rather than generated output, and never modify `packages/ai/src/models.generated.ts` directly. Change `packages/ai/scripts/generate-models.ts`, regenerate, then verify the resulting catalog. Keep exact bundle versions, integrity, licenses, and local modification records synchronized.

## Launch constraints and verification

In-app updates are frozen for this bundled launch. `adrouter update ...` only reports the freeze and must not access the network or filesystem. User-managed package install, remove, list, and config remain available.

Run focused tests, `npm run check:branding`, backend typecheck and provider verification, `./test.sh`, then `npm run release:local -- --out <temporary-directory> --force`. Smoke test Node and Bun artifacts with a temporary `HOME`. Inspect packed artifacts for bundled source, compiled web dependencies, skills, licenses, model catalog consistency, and absence of inherited profile or state paths.
