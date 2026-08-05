# Contributing

Search existing issues before filing a reproducible bug. Use GitHub Discussions for usage questions and the feature form for scoped proposals. Security reports must use GitHub private vulnerability reporting, not a public issue.

Fork the repository, create a focused branch, install with `npm ci --ignore-scripts`, and run the required checks documented in `docs/development.md`. Pull requests must explain behavior and risk, add tests when behavior changes, avoid secrets or personal data, and update public documentation when interfaces change.

Maintainers require a pull request, one approval, resolved conversations, and passing CI before merging to `main`. Force pushes to `main`, force pushes to protected `v*` tags, and tag deletion are prohibited.
