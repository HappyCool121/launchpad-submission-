# Contributing to AdRouter Agent

Thank you for helping improve AdRouter Agent. By participating, you agree to
keep credentials, private project data, and vulnerability details out of
issues, pull requests, fixtures, screenshots, and logs.

## Development setup

AdRouter Agent currently targets macOS. Install Node.js `25.9.0`, then:

```bash
npm ci
npm run check
npm run test:e2e
```

The E2E suite uses a local fixture router and does not require live
credentials. A live router smoke test is separately protected and documented
in `RELEASE.md`.

## Pull requests

- Open an issue first for significant behavior or contract changes.
- Keep changes focused and preserve the renderer/runtime security boundaries.
- Add or update tests for observable behavior.
- Run `npm run check`, `npm run test:e2e`, and
  `npm audit --omit=dev --audit-level=moderate`.
- Do not commit generated `out/`, `.vite/`, npm tarballs, environment files,
  tokens, certificates, or notarization keys.
- Do not change release versions or Pi agent dependency versions in an
  unrelated pull request.

Security reports belong in a private vulnerability report, not a pull request.
See `SECURITY.md`.
