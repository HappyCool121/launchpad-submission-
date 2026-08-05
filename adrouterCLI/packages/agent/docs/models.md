# Models architecture

`@adrouter/agent-core` receives a `Models` collection from its host. The harness does not discover
providers, read credentials, or mutate model metadata. It streams the selected canonical model
through that collection for normal turns, compaction, and branch summaries.

## Ownership

- `@adrouter/ai` owns provider factories, model metadata, auth resolution, and streaming APIs.
- `@adrouter/agent-core` owns the provider-independent agent loop, tool lifecycle, and context
  transformations.
- `@adrouter/cli` owns installation credentials, the active registry, session model selection, and
  the official Router boundary.

The official CLI injects a locked registry generated from Router’s eight-model AdRouter catalog.
SDK applications that deliberately need other providers construct and populate
`ModelRegistry.inMemory()` before creating a session. Extensions do not mutate provider catalogs.

## Harness contract

`AgentHarnessOptions.models` is required. The harness keeps the provided collection and calls its
`streamSimple()` path with the selected model and current context. Request authentication remains
inside the collection. Compaction and branch summarization receive the same collection, so they do
not create an alternate credential or provider path.

Model objects are serializable metadata. Hosts should resolve them through their active registry
before a session starts or changes model. The official CLI rejects unknown or altered hosted model
objects. A mutable SDK registry accepts only models registered in that registry.

## Provider-independent context

The harness context contains system instructions, user and assistant messages, and tool results.
Application-only display/accounting entries are not converted into model messages. In particular,
AdRouter sponsorship and settlement state may be retained by the CLI session manager but is never
included in harness turns or compacted context.

For the generated hosted catalog, limits, custom-endpoint exception, authentication, and streaming
lifecycle, see the
[canonical product guide](https://github.com/adrouter/adrouterCLI/blob/main/docs/about.md).
