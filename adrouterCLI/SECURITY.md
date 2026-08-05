# Security policy

Report vulnerabilities through GitHub private vulnerability reporting for `adrouter/adrouterCLI`. Do not open a public issue, include a live credential, or test against accounts you do not own.

Include the affected version, impact, minimal reproduction, and suggested mitigation. Remove prompts, model output, tool payloads, local paths, private/public JWK material, access/refresh credentials, device/user codes, nonces, proofs, authorization headers, and full fingerprints. Maintainers will acknowledge the report, coordinate a fix and disclosure window, and revoke affected installations or legacy beta credentials when containment requires it.

Official hosted access uses a user-approved Ed25519 installation stored with user-only file permissions (`file_protected`, not OS-keychain encrypted). Access tokens are memory-only. Custom/loopback bearer compatibility is deliberately isolated and cannot override official hosted installation authentication.

The public beta supports only the current `beta` version. Coding agents can read files and execute user-approved commands; workspace trust and command approval are security boundaries. Sponsorship must remain display-only and outside model, tool, command, and edit context.
