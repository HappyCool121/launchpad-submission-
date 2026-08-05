# First run and usage

Start `adrouter` in the intended project. The first-project prompt controls whether repository-owned `.adrouter/` resources can load. Trust only reviewed workspaces.

Run `/login adrouter`, sign in at the opened AdRouter website, and choose the native Done action after the website confirms sign-in. The CLI then creates a fresh installation key and opens the matching WebUI approval page; an already-open signed-in tab also shows the approval modal. Use Open or Copy if the browser does not launch, or Quit to cancel. Failed attempts remove the pending key and best-effort cancel server state, so a later `/login adrouter` starts cleanly. The device code, private key, and credentials are never displayed. Then select `deepseek-v4-flash`, `deepseek-v4-pro`, `mimo-v2.5`, `mimo-v2.5-pro`, `agnes-2.0-flash`, `agnes-2.5-flash`, `agnes-2.5-pro`, or `agnes-2.5-pro-alpha`. For non-interactive work after enrollment:

```sh
adrouter --provider adrouter --model deepseek-v4-flash --print "Explain this project"
```

Use `/ads` to view sponsorship status or opt out immediately. Sponsor payloads are display-only. Commands proposed by the agent remain subject to user approval.

`/logout adrouter` attempts signed remote revocation and removes the local installation even when offline; when remote confirmation is unavailable, review installations in the WebUI. `adrouter-profile` creates and selects isolated profiles. Sessions, file-protected credentials, trust decisions, extensions, and settings live under `~/.adrouter/agent`; project resources live under `.adrouter/`.

Bundled features include web access, subagents, and the BTW side panel. To diagnose startup or extension behavior, disable bundled features individually in settings or start with project resources untrusted. Re-enable them one at a time after the fault is isolated.
