# AdRouter Agent operator guide

This guide describes the current AdRouter Agent desktop application in this
repository. It is written for someone running, evaluating, or integrating the
cross-platform desktop app with an AdRouter backend.

The desktop app is a local-first coding workbench. It opens a local project
folder, sends model inference to an independently running AdRouter backend,
executes a deliberately small set of workspace tools, pauses risky operations
for user approval, and records the work as reviewable evidence.

## Quick start for a source checkout

Use two terminals. The desktop process does not start the backend for you.

In the backend terminal:

```bash
cd /path/to/router/backend
npm install
npm run dev
```

In the desktop terminal:

```bash
cd /path/to/adrouterAgent
nvm install 25.9.0
nvm use 25.9.0
npm ci
npm run dev
```

Verify the backend before opening the desktop onboarding screen:

```bash
curl -fsS http://localhost:8787/health
```

On first launch, enter the local server URL, open the advanced custom-router section, enter the
backend's `ADROUTER_API_KEY`, select **Test connection**, then **Save custom router**. Select
**Choose folder** to open the project you want the agent to inspect. The
complete credential setup and health-response interpretation are described in
[Live backend setup](#6-live-backend-setup).

The current desktop runtime is launched with `npm run dev`. Do not use the
`adrouter` CLI command as a substitute: the desktop embeds its own agent loop
and does not spawn the CLI executable.

## 1. What the desktop app is—and is not

AdRouter Agent is an Electron desktop application with a React renderer, an
Electron main process, and an isolated agent utility process. It uses the
Pi-derived agent packages as its reasoning and tool-loop foundation, but it has
its own desktop runtime, tools, approval protocol, persistence, review UI, and
sandbox integration.

It does **not** start the `adrouterCLI` executable in the background. The two
clients are separate applications that can connect to the same AdRouter
backend:

```text
AdRouterCLI ───────┐
                   ├── AdRouter backend ─── provider model
AdRouter Agent ────┘
```

The desktop application intentionally does not inherit the CLI's complete
extension and shell surface. It favors bounded, inspectable work over general
local-account automation.

## 2. Capability summary

The desktop can work on both existing and new local projects.

| Capability | Desktop behavior |
| --- | --- |
| Open a project | Select any readable local directory, including an empty directory. The app records its canonical path and refreshes Git metadata when applicable. |
| Inspect a project | List safe files, read safe text files, search literal text, inspect Git status, and inspect a non-staged Git diff. |
| Create files | Yes. `apply_patch` can create a file with exact content after one-time approval. |
| Modify files | Yes. `apply_patch` performs hash-guarded exact replacements after one-time approval. |
| Delete files | Yes, when the project is writable and the deletion is explicitly approved. |
| Run checks | Yes. Local tests, lint, typecheck, version checks, and conservative inspection commands are allowed by policy where applicable. |
| Scaffold a project | Partly. The agent can create project files and run allowed commands, but dependency installation and network-based scaffolding are disabled by the desktop command policy. |
| Review work | Yes. The Changes drawer shows agent-authored diffs against a pre-agent baseline. |
| Commit or push Git changes | No. The desktop does not stage, commit, push, pull, or perform other remote/destructive Git operations. |
| Use extensions or skills | Not in the current desktop runtime. The embedded runtime disables Pi extensions, skills, prompt templates, themes, and context-file discovery beyond the desktop's explicit project/repository instructions. |

### Creating a project with the desktop app

The supported workflow is:

1. Create or select a local directory yourself.
2. Choose **Choose folder** in the desktop app.
3. Start a new chat and describe the desired structure and files.
4. Review each proposed `apply_patch` operation.
5. Select **Allow once** for the exact file mutation you want.
6. Ask the agent to inspect the resulting files and run an available local
   check.

The created files are written into the selected directory. The app does not
copy the project to a hidden worktree, stage changes, or create a Git commit.
If the project needs dependencies, install them outside the agent according to
your normal development process; the desktop intentionally blocks package
installation commands such as `npm install`, `npm ci`, `pnpm add`, and
equivalent operations.

## 3. AdRouterCLI versus AdRouter Agent

Both clients use the Pi-derived agent foundation and can route turns through
the same backend, but their capabilities are different.

| Area | AdRouterCLI | AdRouter Agent |
| --- | --- | --- |
| Interface | Terminal TUI, JSON mode, RPC mode, and scripting | Electron desktop GUI |
| Agent surface | Full Pi coding-agent distribution | Desktop-specific Pi agent loop |
| Built-in tools | `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` | `read_file`, `run_command`, `apply_patch`, `search_text`, `list_files`, `git_status`, and `git_diff` |
| Extensibility | Extensions, skills, prompt templates, themes, and custom tool selection | Fixed tool list; current runtime disables those Pi discovery features |
| Sessions | Resume, fork, clone, branch session tree, import/export, and session directories | Durable chats and threads in the desktop SQLite journal |
| Model/provider breadth | Broad Pi provider infrastructure plus the AdRouter route | Models discovered from the connected AdRouter backend |
| File changes | Direct Pi `edit`/`write` tools and shell commands | Hash-guarded `apply_patch` with explicit approval |
| Shell authority | Operates within the local user's normal trust boundary; Pi itself does not provide an OS sandbox | Exact argv, command classification, workspace restrictions, sanitized environment, and OS sandbox |
| Safety interaction | Terminal-oriented trust and tool controls | Per-operation approval cards and fail-closed policy denials |
| Review | TUI tool output and diffs | Persistent baselines, Changes drawer, completion evidence, and guarded review actions |
| Economics | Ad controls such as `/ads status`, `/ads on`, and `/ads off` | Integrated sponsor surfaces and settlement/cost display in Settings and the timeline |
| State location | `~/.adrouter/agent/` and project `.adrouter/` state | Electron user data: `adrouter.sqlite` and encrypted `configuration.json` |

Use the CLI when you want maximum Pi flexibility, terminal automation, custom
extensions, or broad shell access. Use the desktop when you want a visual,
approval-driven, workspace-confined coding workflow with durable review data.

Their session stores are separate. The desktop does not import CLI session
files, and the CLI does not read the desktop SQLite journal.

## 4. Runtime architecture

```text
React renderer
  │ sandboxed window; no Node integration; validated preload bridge
  ▼
Electron main process
  ├─ OS-encrypted installation key, pending enrollment, refresh rotation, and access-token memory
  ├─ narrow exact-byte signing broker for allowlisted utility requests
  ├─ SQLite projects, threads, turns, events, approvals, and baselines
  ├─ repository metadata and native folder dialogs
  ├─ review and diff service
  └─ runtime supervisor
       │ validated process messages
       ▼
Isolated agent utility process
  ├─ Pi Agent loop
  ├─ AdRouter provider adapter
  ├─ fixed desktop tool set
  ├─ approval wait/resume handling
  └─ command sandbox and policy
       │ request-scoped protected headers; authenticated HTTP with NDJSON streaming
       ▼
Independent AdRouter backend
  ├─ installation-bound authentication and profile
  ├─ model discovery
  ├─ provider inference
  ├─ sponsor routing
  └─ usage and settlement
```

The renderer receives only redacted installation state and the approval comparison code. The main
process owns the browser handoff, clipboard writes, key generation, encrypted persistence, polling,
signed cancellation, refresh, signing, revocation, database, and runtime lifecycle. The handoff
identifier never enters the renderer. The utility owns streaming but can request protected headers only for bounded
exact bytes on the profile and agent-turn allowlist; it never receives a private key or refresh
credential.

## 5. What happens during a turn

For each user message, the application performs this sequence:

1. **Validate configuration.** The selected model and thinking level must exist
   in the cached router catalog and be supported by that model.
2. **Load project context.** The runtime receives the selected project path,
   repository instructions, user-authored project instructions, permission
   mode, current model, and current thread history.
3. **Create a journaled turn.** The main process records the user message and
   lifecycle state in SQLite before starting the utility process.
4. **Build the agent session.** The runtime reconstructs model messages from
   non-economic events and adds the desktop safety instructions and project
   instructions.
5. **Send the model request.** The AdRouter client sends an authenticated
   `POST /v1/agent/turn` containing the model, thinking level, runtime mode,
   system prompt, messages, tools, and non-sensitive client metadata.
6. **Stream the response.** The backend may stream thinking deltas, text
   deltas, tool calls, sponsor events, settlement data, completion, or errors.
7. **Execute tools.** A safe read or Git inspection can run immediately. A
   file mutation or command may create an approval request, which pauses the
   agent until the user responds.
8. **Continue after tool results.** Approved or denied tool results are sent
   back into the agent loop. The model can inspect the result and decide what
   to do next.
9. **Finish and record evidence.** The runtime records the terminal outcome,
   files, command records, usage, settlement, errors, and known limitations.

Only one agent run can be active application-wide. Other threads remain stored
and can be opened after the active run finishes.

## 6. Live backend setup

The normal development setup uses two terminals. The backend and desktop are
separate processes; starting the desktop does not start the backend.

### Backend requirements

- Backend Node.js: 22.13 or newer.
- Desktop Node.js: `25.9.0`, pinned by the repository's `.nvmrc`.
- A local bearer token in `ADROUTER_API_KEY`.
- A separate DeepSeek Platform key in `DEEPSEEK_API_KEY` for live inference.
- Port `8787`, unless you intentionally configure another port.

Never reuse the DeepSeek provider key as the local AdRouter bearer token.
Never print either credential or commit a `.env.local` file.

From the sibling backend directory:

```bash
cd ../router/backend
npm install
cp .env.example .env.local
```

Generate the local bearer token with a password generator such as:

```bash
openssl rand -hex 32
```

Keep the generated value private and use the same value only in the backend
`.env.local` and the desktop onboarding form. Do not put it in a committed
file, a shell transcript, or a browser-exposed `VITE_*` variable.

At minimum, configure these values in `router/backend/.env.local`:

```dotenv
ADROUTER_PROFILE_ID=local-demo
ADROUTER_PROFILE_NAME=AdRouter Local Demo
ADROUTER_API_KEY=your_generated_local_bearer_token
DEEPSEEK_API_KEY=your_deepseek_platform_key
PORT=8787
```

Start the backend:

```bash
npm run dev
```

Verify its unauthenticated health endpoint:

```bash
curl -fsS http://localhost:8787/health
```

The public response confirms only `status: "ok"`; it does not report provider mode or validate
authentication.

The desktop validates a custom router through profile plus public model discovery during **Test
connection** and **Save custom router**. Official onboarding verifies a signed profile after WebUI
approval. A successful health request therefore does not replace authentication.

### Desktop requirements and launch

From this repository:

```bash
node --version       # must be v25.x
npm ci               # first setup, or after dependency changes
npm run dev
```

`npm ci` is needed on the first checkout and after dependency or lockfile
changes. It can rebuild Electron's native dependencies for the active Node
version, so switch to Node `25.9.0` before running it.

For the local/custom compatibility path, enter:

1. Server URL: `http://localhost:8787`.
2. Open **Advanced: connect a custom or local router** and enter the exact `ADROUTER_API_KEY` from
   the backend's `.env.local`.
3. Sponsored compute preference.
4. Select **Test connection**, then **Save custom router**.

Official origins instead show **Connect this Agent**. Main creates a memory-only browser handoff and
opens the WebUI sign-in page. After the user returns and selects **Continue**, Main generates an
Ed25519 key, binds the device authorization to the handoff, shows a comparison code through the
renderer, polls at the server interval, encrypts the approved key/refresh family with `safeStorage`,
and verifies a signed profile. Access tokens remain memory-only. Restart discards pre-Continue
preparation but resumes an unexpired encrypted pending approval. Cancellation and terminal failure
attempt signed server cleanup, and a prior installation is replaced only after validation succeeds.

For a remote backend, use HTTPS. Plain HTTP is accepted only for
`localhost`, `127.0.0.1`, and `::1`; URLs with embedded credentials or URL
fragments are rejected.

The app stores the server URL, model catalog, selected model, thinking level, and sponsored-compute
preference locally. Its configuration contains only encrypted installation/pending records or
custom-router ciphertext. Unsafe or unavailable OS storage blocks official enrollment and reconnect.

### Live versus mock mode

The backend controls provider runtime mode. If `DEEPSEEK_API_KEY` is absent or
invalid, health may report `mode: "mock"`; the app can still exercise the
router contract and sponsor UI, but responses are not live DeepSeek inference.
Restart the backend after changing `.env.local`.

The desktop's runtime mode is selected internally for the task. Do not confuse
the backend's provider mode with sponsor display: sponsor events are a separate
display/economics channel.

### Normal operating workflow

1. Open or return to a project with **Choose folder**. The app canonicalizes the
   directory, refreshes Git metadata, and loads root-level `AGENTS.md` and
   `.agent/instructions.md` when present.
2. Review **Settings** before a sensitive task. The Agent status panel shows
   connection state, router mode, server URL, last check time, available
   models, supported thinking levels, and whether the model catalog is stale.
3. Select a model and thinking level in the composer. The app only offers
   levels reported by the selected model (`none`, `medium`, or `high`).
4. Describe the task in a new chat. Enter sends the request; Shift+Enter adds a
   newline. The timeline streams thinking, text, tool activity, command
   output, approvals, sponsor surfaces, settlements, and final evidence.
   When a project has no active thread, starter suggestions can fill the
   composer for common explain, fix, and review tasks without sending them.
   Sponsor banners and pending approvals are attached to the composer dock;
   routed banners animate into view and can be dismissed from their close
   control.
5. Resolve each approval from the exact preview. Use **Allow once** only when
   the path, command argv, working directory, and reason are correct. Use
   **Deny** to leave the workspace unchanged and return a denial to the agent.
6. Review the **Changes** drawer after mutations. It contains read-only
   agent-authored diffs compared with baselines captured before the mutation.
7. Use **History** to switch between chats. Use **Stop** to cancel an active
   task; use the delete action only for a terminal chat after confirming that
   its messages and review records should be removed.

History, Changes, and Settings are side drawers. They animate from the right
edge and remain available while the composer and timeline stay in place.

Project-specific instructions are stored separately from repository instruction
files. Edit them in **Settings** and select **Save instructions**. These user
instructions are sent to the agent for that project but are not written into
the repository unless the agent explicitly proposes a file change and you
approve it.

## 7. Workspace tools and approvals

The desktop exposes a fixed, intentionally small tool surface:

| Tool | Approval | Boundary |
| --- | --- | --- |
| `list_files` | None | Safe files beneath the workspace; at most 5,000 results. |
| `read_file` | None | Safe text files only; bounded size; protected paths rejected. |
| `search_text` | None | Literal search in safe text files; at most 200 matches. |
| `git_status` | None | Read-only Git status. |
| `git_diff` | None | Read-only, non-staged Git diff. |
| `apply_patch` | Every call | Exact create/modify/delete operation, expected-hash guarded, atomically applied. |
| `run_command` | Usually | Exact argv, selected workspace as cwd, bounded timeout, sandboxed environment. |

The project permission mode can be `workspace-write` or `read-only`. Newly
opened projects default to `workspace-write`. In read-only mode, `apply_patch`
refuses file mutations and command execution cannot write into the workspace.

### Approval behavior

- Each file mutation gets a bounded preview and a new one-time approval.
- Each approved command is tied to the exact argv and working directory shown
  in the approval card.
- **Allow once** applies only to that request; it does not create a permanent
  allowlist.
- **Deny** returns a denied tool result to the model, which can explain the
  result or choose another action.
- A policy denial cannot be overridden by clicking approval.
- **Stop** cancels router work, clears queued messages, denies pending
  approvals, terminates active command process groups, and records a cancelled
  turn.

### Command policy

The command tool uses argv arrays rather than an implicit shell command string.
The policy denies or restricts:

- Network clients and network-capable commands.
- Dependency installation and package mutations such as `npm install`.
- Privilege escalation such as `sudo`, `su`, and `doas`.
- Destructive filesystem commands such as `rm`, `mv`, `cp`, and `chmod`.
- Destructive or remote Git operations such as reset, clean, checkout, commit,
  push, and pull.
- Credential paths and protected files.
- Paths outside the selected workspace, including escaping symlinks and parent
  traversal.
- In-place `sed` edits; file changes should use `apply_patch`.

Read-only Git inspection, conservative workspace inspection, local tests, lint,
and typecheck commands may run without an approval when they match the policy.
Unknown commands and interpreted code require approval. If the OS sandbox
cannot initialize, commands fail closed.

## 8. Sponsor and economics isolation

Sponsored compute is optional. The router chooses a sponsor outcome from the
latest user prompt and emits the sponsor event before model output, followed by
settlement and usage data after the stream.

The desktop may display sponsor content, tier, subsidy, cost, amount paid, and
token/cache usage in the timeline and Settings. These events are stored for
economics and completion reporting, but they are not agent context.

Before model inference and tool execution, sponsor/economics fields are
removed and checked. Sponsor content is never placed in:

- Model messages or system prompts.
- Tool definitions or tool arguments.
- Command argv or environment data.
- File patches or project instructions.
- Compacted conversation context.
- Completion evidence.

Tier `NONE` is a normal privacy/guardrail outcome. It can appear for sensitive
prompts, unavailable inventory, routing failure, or sponsor opt-out.

## 9. Persistence, review, and recovery

The desktop stores application state under the platform's Electron user-data
directory, normally:

```text
~/Library/Application Support/AdRouter Agent/
```

Important state includes:

- `adrouter.sqlite`: projects, threads, turns, append-only events, approvals,
  file baselines, command records, router outcomes, and settlement data.
- `configuration.json`: server URL, sponsored-compute preference, cached model
  metadata, and only the encrypted router-token ciphertext.

The selected project remains in its original location. The app does not create
a separate worktree or copy the repository.

The Changes drawer compares current bytes with the baseline captured for
agent-authored mutations. Pre-existing user changes are not attributed to the
agent. The drawer is for review and does not stage, commit, push, or silently
rewrite files.

If the application exits unexpectedly, active work is recovered as
`interrupted`; it is not silently resumed. A normal Stop records `cancelled`.
Only terminal chats can be deleted from History, and deleting a chat removes
application history and review metadata—not project files.

## 10. Troubleshooting

### The app says the router is unreachable

Confirm that the backend process is running on the configured port and check:

```bash
curl -fsS http://localhost:8787/health
```

If the backend uses another port, enter that URL during onboarding. Remote
endpoints must use HTTPS.

### Health works, but authentication fails

Health is public. For official service access, reconnect the installation and confirm the approval
code in the WebUI. For a local/custom router, confirm that its token exactly matches the backend's
`ADROUTER_API_KEY`, then restart the backend after editing `.env.local`.
The sibling CLI can perform a credential-safe diagnostic without printing the
token:

```bash
../adrouterCLI/run-adrouter-live.sh --json doctor
```

### The router reports mock mode

Set a valid `DEEPSEEK_API_KEY` in `router/backend/.env.local`, confirm the
provider model is configured, and restart the backend. Mock mode is still
useful for testing the desktop protocol and sponsor presentation.

### No models appear

The desktop discovers models through public `GET /v1/models` and validates access separately with
signed `/v1/profile`. Check that the backend is healthy, authentication is connected, and the configured
provider exposes at least one model. The app may show a cached catalog while a
temporary router check is unavailable.

### A task returns HTTP 400, 409, or 502

- **400:** usually an unsupported model, malformed context, or desktop/backend
  contract mismatch.
- **409:** the requested live model/provider is not configured.
- **502:** the provider failed or became unavailable; inspect backend logs and
  provider availability.

The desktop performs bounded retries for retryable 409 and 502 responses, then
records the failure if the router remains unavailable.

### A command is blocked

Check whether it uses a network client, installs dependencies, accesses a
protected or out-of-workspace path, performs destructive Git/filesystem work,
or relies on shell operators. Those are policy denials, not missing approval.
Run the operation manually outside the agent if it is intentionally required.

### Commands are all disabled

The host OS sandbox may have failed to initialize. Review the timeline
diagnostic and confirm the app is running on a supported OS and its prerequisites from
`docs/platform-setup.md` are installed. The
desktop intentionally fails closed when the sandbox cannot be established.

### Node or packaging errors appear

Use Node 25 for desktop development and packaging:

```bash
node --version
```

Node 24 is not supported for packaging in this repository. The backend has a
separate Node 22.13-or-newer requirement.

## 11. Development and validation

From the desktop repository, the main checks are:

```bash
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run check
```

The optional manual smoke asks an exact packaged, already-approved Agent for a redacted installation
diagnostic. It does not accept a router credential:

```bash
ADROUTER_AGENT_EXECUTABLE=/absolute/path/to/the/candidate npm run smoke:live
```

Do not run this in CI. Exact hosted authentication is a manual acceptance gate because user-approved
installation credentials never belong in workflow secrets.

The packaged end-to-end suite uses a deterministic fixture router and does not
require live provider credentials:

```bash
npm run test:e2e
```

Backend checks run separately:

```bash
cd ../router/backend
npm run typecheck
npm test
```

The detailed live acceptance checklist is in
[`docs/manual-testing.md`](manual-testing.md).

## 12. Implementation map

The main code paths are:

- `src/main/index.ts` — Electron window and application initialization.
- `src/main/ipc.ts` — validated renderer-to-main operations.
- `src/main/configuration-store.ts` — versioned encrypted installation, pending, and custom-router
  storage.
- `src/main/installation-auth.ts` and `platform-auth-crypto.ts` — enrollment, refresh, proof,
  revocation, diagnostics, and exact-byte signing.
- `src/main/database.ts` — SQLite persistence and interrupted-run recovery.
- `src/main/runtime-supervisor.ts` — utility-process lifecycle, approvals, and
  event journaling.
- `src/runtime/agent-session.ts` — Pi agent loop, context reconstruction,
  compaction, and tool/session setup.
- `src/runtime/router-client.ts` — authenticated AdRouter HTTP/NDJSON adapter.
- `src/runtime/tools.ts` — desktop tool definitions and approval handoff.
- `src/runtime/command-policy.ts` and `src/runtime/sandbox.ts` — command
  classification and OS sandbox configuration.
- `src/main/review-service.ts` — agent-only baselines and review diffs.
- `src/renderer/App.tsx` — onboarding, timeline, settings, approvals, and
  changes UI.

This map describes the current implementation, not a promise that the desktop
and CLI will remain feature-identical. New capabilities should preserve the
desktop's separate economics channel, approval semantics, and workspace
boundaries.
