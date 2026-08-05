# Security and privacy notes

## Credentials

- Create new submission-only values. Do not reuse current product/development credentials.
- Router `.env.local`: local `ADROUTER_API_KEY` plus backend-only `AGNES_API_KEY`.
- CLI `.env.local`: local `ADROUTER_API_KEY` only. Its launch helper rejects `AGNES_API_KEY`.
- Agent: enter the local bearer in onboarding; Electron encrypts it using `safeStorage`.
- `.env.local`, local databases, sessions, logs, and build output are ignored and must never be
  committed.

## Network boundary

LaunchPad Router binds to `127.0.0.1`. Plain HTTP is accepted by clients only for loopback; custom
remote endpoints require HTTPS. Authenticated redirects are rejected by the Agent transport.

## Sponsor boundary

Sponsor metadata is display/accounting data only. Selection uses the latest request; provider
messages and tools are assembled independently. Client source removes sponsor-shaped fields before
constructing model context. Tests and review paths in the root README cover this invariant.

## Demo safety

Use a disposable project, inspect every command/edit approval, avoid personal/production data, and
stop Router before copying its local SQLite store. A public repository review is not a security
audit or a production-readiness claim.
