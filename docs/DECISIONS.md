# Decision record

## One repository, source snapshots

Judges can inspect one public repository without navigating three independent histories. Exact base
SHAs and the Agent working-tree exception are recorded in `SOURCE_SNAPSHOT.md`; nested Git metadata
is excluded.

## Live Agnes at runtime, offline verification

A real run demonstrates the intended provider integration. CI proves request shaping and runtime
boundaries with local fixtures so credentials are never required in automation and external service
availability cannot make the repository red.

## Two credentials, two trust boundaries

`AGNES_API_KEY` stays in Router. `ADROUTER_API_KEY` is a newly generated loopback bearer shared by
the local clients. The client launch checks explicitly reject an Agnes key in the CLI environment.

## Four-model catalog

The judge path is limited to four Agnes models and defaults to `agnes-2.5-flash`. The source snapshot
retains upstream catalog machinery for provenance, but LaunchPad filtering is enforced at the
Router API and turn validator.

## CLI-first, Agent included

CLI provides the lowest-friction demonstration of tools, sponsorship display, opt-out, and
settlement. Agent source remains runnable and reviewable, including its current parity work, without
making unverified native-release claims.

## Preserve licenses

CLI remains MIT and Agent remains Apache-2.0. Router had no standalone license in its source
snapshot, so the root notice does not invent one.
