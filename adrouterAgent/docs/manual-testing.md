# Manual acceptance test

This checklist validates the custom/local compatibility path and the exact packaged hosted
installation path. Hosted acceptance must use the immutable candidate from the draft release, not a
local build.

## Preconditions

- A supported desktop OS (macOS 12+, Ubuntu 24.04 x64, or Windows 11 x64) and Node.js 25.9.0.
  Windows release evidence must be physical.
- The sibling `router/backend` dependencies and this repository's dependencies
  are installed.
- `router/backend/.env.local` contains distinct `ADROUTER_API_KEY` and
  `DEEPSEEK_API_KEY` values.
- No unrelated process is using router port 8787; the local backend should own
  that port during the test.
- The test project contains no secrets and can safely receive a small edit.

Never paste either credential into terminal output, screenshots, chat prompts,
or issue reports.

## 1. Verify the router

From `router/backend`, install dependencies if needed and start the service:

```bash
npm install
npm run dev
```

In another terminal, verify health and authenticated CLI diagnostics:

```bash
curl -fsS http://localhost:8787/health
../../adrouterCLI/run-adrouter-live.sh --json doctor
```

Confirm that health reports `status: "ok"`. Confirm that authenticated diagnostics report a
reachable live router and available authentication. Health alone does not validate authentication
or provider readiness.

The standalone smoke utility is reserved for an exact packaged installation that has already been
approved through the WebUI. It rejects bearer-token environment variables.

## 2. Launch and onboard

From `adrouterAgent`:

```bash
nvm install 25.9.0
nvm use 25.9.0
npm ci
npm run dev
```

Confirm Node reports `v25.9.0`. This is the Electron desktop app; it does not
start the `adrouter` CLI executable or the backend automatically. On first
launch:

1. Enter `http://localhost:8787` as the server URL and open **Advanced: connect a custom or local
   router**.
2. Enter the router's `ADROUTER_API_KEY` as the custom-router access token.
3. Choose whether sponsored compute is enabled.
4. Select **Test connection** and confirm health, authentication, and model
   discovery succeed.
5. Select **Save custom router**.

Restart the app once and confirm onboarding remains complete. The token should
never be visible again in the renderer or written to application events.
If the app is pointed at a remote router, verify the URL uses HTTPS. HTTP is
accepted only for loopback development URLs.

For official staging acceptance, install the exact candidate artifact, keep the prefilled HTTPS
origin, and select **Connect this Agent**. Confirm the browser opens the Agent-specific sign-in page,
the renderer never displays its handoff identifier, and key generation does not begin yet. Sign in,
return to the Agent, select **Continue**, compare the displayed code in the authenticated WebUI, and
approve explicitly. Restart before **Continue** to confirm the memory-only preparation is discarded;
restart once while the code is pending to confirm the encrypted approval resumes. Cancel another
pending attempt and confirm the WebUI cannot later approve it. Verify the renderer never displays a
device code, token, key, nonce, proof, protected header, or direct handoff link.

## 3. Open a project

Select **Choose folder** and open a disposable project. Confirm the header
shows the correct folder. Test both kinds of workspace when practical:

- A Git worktree: branch and dirty-state metadata are available.
- A normal non-Git folder: chat and file tools remain usable without Git data.

If the project has `AGENTS.md` or `.agent/instructions.md`, confirm its
instructions affect agent behavior. In **Settings**, save a short project
instruction, reopen the project, and confirm it persists separately from the
repository-owned instructions. Confirm **Settings** reports which repository
instruction files were loaded and that project instructions are not written to
the repository automatically.

## 4. Validate read-only work

Before sending, switch models and thinking levels in the composer. Confirm only
levels supported by the selected model are offered. Verify **Enter** sends and
**Shift+Enter** inserts a newline. Open **Settings** and confirm router
connection, live/mock mode, last check time, and current models are displayed.

Ask the agent to summarize a harmless text file without changing anything.
Confirm:

- Thinking and coding activity streams into the chat.
- File listing, reading, literal search, Git status, and Git diff do not create
  approval cards.
- Protected files such as `.env`, `.npmrc`, SSH keys, AWS credentials, and
  files reached through an escaping symlink cannot be read.
- No change appears in the **Changes** drawer.
- In **Settings**, refresh Agent status and confirm the router mode, server URL,
  last check time, and model catalog are shown. Temporarily make the router
  unavailable and confirm the last known catalog is marked stale rather than
  treated as a fresh authentication result.

## 5. Validate mutation approval

Ask for a small, unambiguous text edit. When the approval card appears:

1. Verify it names the exact relative path and shows a bounded mutation
   preview.
2. Select **Deny** and confirm the file is byte-for-byte unchanged.
3. Ask for the edit again, select **Allow once**, and confirm only the requested
   file changes.
4. Request another edit and confirm a new approval is required; the earlier
   choice must not be remembered.

Open **Changes** and confirm the approved agent edit appears against the exact task-start Git
baseline. Pre-existing user changes should not be attributed to the agent. Exercise branch/switch,
path stage, commit, and explicit remote/refspec push only in a disposable repository: the first click
must create an exact expiring operation, the second must require a fresh **Allow once**, and any
changed HEAD/index/path hash or replay must fail. The Agent must never invoke these actions itself.

## 6. Validate command approval and sandboxing

Ask the agent to run a harmless project check such as `npm run typecheck` or
`pwd`. Confirm the card displays the exact argv and working directory. Select
**Allow once** and verify live output, exit status, and duration are recorded.
Request the identical command again and confirm a new approval is required.

Then verify hard policy boundaries with disposable requests:

- A network command such as `curl https://example.com` is denied.
- Dependency installation through a generic command such as `npm install` is denied; the structured
  dependency adapter must preview in a temporary mirror with lifecycle scripts disabled and require
  a separate high-risk approval before an explicitly supported lifecycle run.
- A privileged command such as `sudo ...` is denied.
- An absolute or parent-relative path outside the workspace is denied.
- A destructive/force/ref-deleting Git operation is denied; supported structured Git writes remain
  bound to their separately reviewed hashes, OIDs, remote, and refspec.
- Shell operators, command interpolation, and in-place `sed -i` edits are
  denied; commands must use a plain argv and file changes must use
  `apply_patch`.

These operations must remain blocked without presenting approval as a policy
bypass. If the OS sandbox cannot initialize, all commands must fail closed.

Verify that a read-only project can still be inspected but cannot accept file
mutations. If the project is in `workspace-write` mode, confirm the exact same
mutation requires a new approval each time; there is no persistent allowlist.

## 7. Validate stop and recovery

Start a task that produces a longer stream or command, then select **Stop**.
Confirm the UI returns to an idle state, the command process group ends, queued
messages are cleared, pending approvals are denied, and the turn is recorded as
cancelled.

For crash recovery, start a disposable task and force-quit the app. Relaunch it and confirm the
active turn is marked interrupted and requires explicit **Continue** from the last safe checkpoint;
the interrupted request, unresolved mutation, or partial paid output must not replay.

Fork an immutable safe checkpoint, label and search both branches, then change only the fork and
confirm its descendant is independent. Export/import the session and confirm sponsor fields,
secrets, developer paths, and billing are absent by default, optional billing is display-only, and
the import creates no turn or automatic execution.

Enable delegation only for a disposable project. Confirm each child requires the high-risk parent
approval, inherits the exact project/model/policy but no parent conversation, is visible and
cancellable, cannot delegate again, and that no parent starts more than three children. The normal
desktop runtime executes one task at a time; workspace/Git leases must still serialize writers if
the internal scheduler is exercised directly in tests.

Pair the CLI with the running app and compare the GUI code. Confirm its private key remains in
Electron `safeStorage`; the short `/tmp` Unix endpoint has a current-user-owned mode-0700 parent and
mode-0600 socket (or a current-user-DACL Windows pipe); replayed nonces, bad signatures, and
oversized frames fail; and headless mutations produce the same approval card. Revoke the client and
confirm later RPC calls fail.

Finally run `adrouter-agent update check --channel beta --json` against a signed fixture. Redirects,
wrong channels, expired/unknown keys, and changed artifact metadata must fail. Public update apply is
expected to report disabled until exact signed acceptance enables it.

## 8. Validate sponsor isolation and settlement

With sponsored compute enabled, complete a task and confirm the appropriate
tier presentation:

- A sponsor similarity score greater than `0.85` produces Tier A; greater than
  `0.60` produces Tier B; lower scores produce Tier C.
- Tier B and Tier C appear immediately in both the active thinking/coding
  stream and above the composer when their ad payload arrives.
- Confirm the top Tier B/C banner disappears when generation ends while the
  bottom banner remains attached above the composer until it is closed or the
  next prompt is submitted. Confirm its expand/retract animation and close
  button.
- Trigger a command approval and confirm its approval card shares the composer
  dock, expands into view, and retracts after Allow once or Deny.
- Tier A appears as a hideable inline sponsor surface inside the completed
  answer and records a 100% subsidy.
- Tier B appears as a hideable sponsor panel below the completed answer and
  records a 40% subsidy.
- Tier `NONE` appears as the privacy/guardrail notice and records no subsidy.
  Exercise a sensitive prompt, disable sponsored compute, and use a prompt
  with no available inventory when validating this path.

In **Settings**, confirm cost, subsidy, paid amount, token/cache usage, daily
totals, and sponsor tier are displayed after settlement. Inspect router logs or
deterministic test captures when needed and confirm sponsor copy never appears
inside model messages, tool arguments, command argv, patches, project
instructions, or final evidence.

If the turn performs multiple agent/router rounds, confirm the completed answer
shows a collapsible sponsorship summary with the number of rounds and the
aggregated cost, subsidy, and paid amount.

## 9. Completion criteria

Open **History**, delete a terminal disposable chat, cancel the first
confirmation, then confirm deletion. The chat and its stored events must be
removed while every project file remains unchanged. Running and
approval-waiting chats must not be deletable.

The build passes manual acceptance when all of the following hold:

- Official onboarding requires explicit approval and persists only OS-encrypted installation
  material; sign-in happens before authorization creation, cancelled authorizations receive signed
  cleanup, a previous installation remains usable until replacement, and the custom bearer path
  remains isolated to a non-official origin.
- Signed profile and turn requests pass. Expiry refreshes once, concurrent requests share the same
  rotation, and a nonce challenge retries only before response bytes are consumed.
- Replayed proofs, altered bodies/methods/paths/nonces, copied tokens without the private key,
  authenticated redirects, revoked installations, and below-minimum versions fail safely.
- Sign out attempts signed remote revocation and always clears installation, pending, access, nonce,
  and refresh state locally without removing project/task data.
- Git and non-Git projects open successfully.
- A live model streams thinking, tool activity, and a final response.
- Reads are silent; every mutation and general command asks exactly once.
- Denial leaves the workspace unchanged; approval performs only the displayed
  action.
- The sandbox blocks network, credentials, privilege escalation, and
  out-of-workspace access.
- Changes and completion evidence accurately reflect journaled execution.
- Stop and restart produce deterministic cancelled/interrupted states.
- Sponsor display and economics work without entering agent context.

Record only the fields accepted by `scripts/authentication-acceptance.schema.json` for the primary
operator device and a distinct second OS cohort. Validate the result with
`node scripts/validate-authentication-acceptance.mjs authentication-acceptance.json --manifest
artifact-manifest.json` before attaching it to the matching draft release. Never record request or
response content, codes, account IDs, tokens, proofs, keys, nonces, or full fingerprints. Do not
attach the application's SQLite database or configuration file.
