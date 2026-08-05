# Security Policy

## Supported versions

Security fixes are provided for the newest public beta release only. Users
should manually install the latest release before reporting a problem.

| Version | Supported |
| --- | --- |
| 0.1.0-beta.12 | Yes |
| 0.1.0-beta.11 | No |
| 0.1.0-beta.10 | No |
| 0.1.0-beta.9 | No |
| 0.1.0-beta.8 | No |
| 0.1.0-beta.7 | No |
| 0.1.0-beta.6 | No |
| 0.1.0-beta.5 | No |
| 0.1.0-beta.4 | No |
| 0.1.0-beta.3 | No |
| 0.1.0-beta.2 | No |
| Older builds | No |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include router
tokens, provider keys, private project data, or exploit details in logs.

Use the repository's **Security → Report a vulnerability** flow to create a
private GitHub security advisory. Include the affected app version, operating
system version and architecture, reproduction steps, and the smallest safe diagnostic
sample. Maintainers will acknowledge the report through the advisory.

## Security boundaries

Sponsor payloads are display-only. The renderer cannot access raw credentials,
Node.js, the filesystem, or child processes. File mutations and general
commands require a fresh one-time approval and remain constrained by the
workspace sandbox.

Local automation never listens on TCP. On macOS and Linux it uses a short deterministic socket
under `/tmp`, inside a directory that must be a real mode-0700 directory owned by the current user;
the socket must be owned by that user and mode 0600. Windows uses a current-user-DACL named pipe.
Every paired request remains scope-bound, signed, freshness-checked, nonce-protected, and bounded.

The npm launcher retains strict schema-3 compatibility for the published candidate. New release
construction uses an RFC 8785-canonicalized Ed25519 schema-4 envelope with an exact channel,
validity interval, minimum Agent version, artifact byte count, digest, layout, architecture, signer,
and healthy-start rollback policy. The launcher and app share a fail-closed public-key trust set,
use fixed-origin HTTPS update metadata, reject redirects and channel downgrade, and keep update
application disabled until signed native/physical acceptance is complete. Downloads remain bounded,
archive paths and symlinks are validated, macOS requires the declared Developer ID, Windows requires
the declared Authenticode signer, and Linux relies on the signed manifest plus exact checksum.

Managed update activation retains one prior installation until the initialized app writes the exact
owner-state healthy marker. A missing marker after the signed deadline restores the prior receipt and
application without elevation. The launcher never changes quarantine, Gatekeeper, AppArmor, Windows
security settings, or user consent.

Official hosted authentication uses a user-approved Ed25519 installation. The main process is the
only process that generates, decrypts, rotates, signs with, or revokes installation material.
`safeStorage` must use Keychain, DPAPI, or a supported Linux secret store; enrollment and reconnect
fail closed when that protection is unavailable. The renderer receives only the comparison code and
redacted state. Browser opening and clipboard writes remain in the main process, and the browser
handoff identifier is never returned to the renderer. A prepared sign-in is memory-only; only a
server-created pending approval is encrypted for restart recovery. The utility process receives only
request-scoped protected headers for allowlisted exact bytes and cannot request arbitrary signatures.

Loopback and explicit non-official custom routers may use the advanced bearer path. A bearer token
cannot override installation authentication for an official AdRouter origin.
