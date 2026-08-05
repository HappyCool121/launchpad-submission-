# Platform setup and staging authentication

The published beta.12 candidate supports macOS 12+ on Apple Silicon and Intel, Ubuntu Desktop
24.04 LTS x64, and Windows 11 x64. Install Node.js 22.19 or newer before using the dependency-free
npm launcher.

## Install the launcher

```bash
npm install --global @adrouter/agent@beta
adrouter-agent doctor --json
adrouter-agent install
adrouter-agent launch
```

The application is installed per user:

- macOS: `~/Applications/AdRouter Agent.app`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/adrouter-agent/app`
- Windows: `%LOCALAPPDATA%\Programs\AdRouter Agent`

Published beta.12 macOS artifacts are ad-hoc signed and its Linux/Windows artifacts are unsigned.
Future schema-4 candidates require Developer ID signing/notarization and stapling on macOS,
Authenticode through the protected Windows signing provider, and an Ed25519-signed exact manifest
for every platform. The launcher downloads only canonical GitHub release URLs and verifies size,
SHA-256, archive layout, architecture, and required platform signer before activation.

`adrouter-agent update check --channel beta --json` performs a bounded no-redirect check against the
fixed signed-metadata origin. Update application remains disabled. Once acceptance enables it, an
explicit `update apply --confirm` keeps the prior managed app until the new app reports a healthy
initialized start, otherwise the next launcher reconciliation restores the prior version.

## Ubuntu 24.04 prerequisites

Install the sandbox and desktop secret-store packages:

```bash
sudo apt-get update
sudo apt-get install bubblewrap socat ripgrep libsecret-1-0 gnome-keyring
```

Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor. Keep that
protection enabled and add a profile only for Bubblewrap. Create
`/etc/apparmor.d/adrouter-agent-bwrap` with:

```text
abi <abi/4.0>,
include <tunables/global>

profile adrouter-agent-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
```

Then load the profile:

```bash
sudo apparmor_parser -r /etc/apparmor.d/adrouter-agent-bwrap
```

Do not disable AppArmor or change the global
`kernel.apparmor_restrict_unprivileged_userns` setting. Log in to a normal GNOME
or KDE desktop session and unlock its keyring. The app refuses to persist a
installation or custom-router token if Electron reports the weak Linux `basic_text` storage backend.

## Windows 11 prerequisite

Open PowerShell as your normal user and run this once:

```powershell
npx @anthropic-ai/sandbox-runtime@0.0.65 windows-install
```

The command requests one UAC approval and provisions the dedicated
`srt-sandbox` account plus its Windows Filtering Platform rules. It is
idempotent. AdRouter Agent never runs this command or elevates itself. Until it
has succeeded, file tools remain available but command and Git tools are not
offered. Installation material is encrypted with Windows DPAPI.

## Staging authentication

Fresh installations are prefilled with:

```text
https://api-staging.adrouter.co
```

The URL is public configuration. Official hosted access does not use a copied bearer token. Selecting
**Connect this Agent** opens a memory-only sign-in handoff. The Agent creates a unique Ed25519 key only
after you return from the authenticated WebUI and select **Continue**.

In the app:

1. Leave the staging URL selected and choose the sponsored-compute preference.
2. Select **Connect this Agent**.
3. Sign in in the browser, return to the Agent, and select **Continue**.
4. Compare the code displayed by the Agent with the code in the AdRouter WebUI. Approval is never
   implicit, even when the app opens the complete link.
5. Explicitly approve. The main process redeems the approval, stores the installation, and verifies
   a signed profile before onboarding completes.

Closing the app before **Continue** discards only the memory-only sign-in preparation. Once the code
is displayed, the encrypted pending approval resumes after restart. Cancel and terminal failures
remove the local pending key and attempt signed server-side cancellation. A previous working
installation remains active until its replacement passes signed profile validation and is stored.

The private key and rotating refresh credential are encrypted by Electron `safeStorage`; access
tokens remain memory-only. They are not exposed to the renderer, logs, release files, or event
journal. `/health` and `/v1/models` are public and do not validate the installation; signed
`/v1/profile` does.

CI and release workflows never receive an inference credential. After approving an exact installed
candidate, an operator may request its redacted manual diagnostic without exporting a token:

```bash
ADROUTER_AGENT_EXECUTABLE=/absolute/path/to/the/candidate npm run smoke:live
```

Local development may instead enter `http://localhost:8787`, open **Advanced: connect a custom or
local router**, and use that backend's separate `ADROUTER_API_KEY`. The advanced bearer path cannot
be selected for an official origin.
