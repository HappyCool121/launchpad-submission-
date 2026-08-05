# Privacy

- AdRouter does not persist prompts, model output, or tool payloads in application logs or its usage ledger.
- Submitted conversation and tool context transit the hosted gateway and selected model provider to produce the response.
- Local sessions remain under the tester’s AdRouter state directory unless explicitly exported.
- Account, quota, usage, cost, sponsorship, settlement, and audit metadata may be retained while beta access is active and must be deleted within 30 days after access ends.
- `privacy@adrouter.co` is the private deletion-request channel and must be provisioned before testers are invited.

Installation private keys and refresh credentials are local file-protected secrets; short-lived access tokens remain memory-only. Sanitized bug reports must remove prompts, output, tool payloads, filesystem paths, account identifiers, keys, tokens, codes, nonces, proofs, authorization headers, and full fingerprints unless the reporter deliberately includes the minimum necessary material through a private security channel.
