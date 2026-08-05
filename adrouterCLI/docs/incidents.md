# Incident procedure

For backend risk, pause traffic and revoke affected keys independently of the CLI version. For client risk, preserve the released version, mark it withdrawn, deprecate the `@adrouter/cli` npm version, and issue a new beta version. Beta.2 was deprecated after registry verification exposed a bundled dependency conflict; beta.3 replaces it and moves both `beta` and `latest`. Never overwrite a published beta.

Record the affected versions, keys, providers, time window, artifact hashes, observed metadata, containment, and recovery. Do not copy prompts, output, tool payloads, or credentials into incident logs. Validate revocation, quota enforcement, privacy logging, and settlement reconciliation before resuming rollout.
