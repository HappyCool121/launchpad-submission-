# SDK-only custom providers

The default AdRouterCLI registry is locked to the generated eight-model AdRouter catalog.
Extensions cannot add, replace, or remove providers. This keeps official model identity, limits,
authentication, and request construction synchronized with Router.

Applications embedding `@adrouter/cli` may opt into a mutable registry explicitly:

```typescript
import { AuthStorage, createAgentSession, ModelRegistry } from "@adrouter/cli";

const authStorage = AuthStorage.inMemory();
const registry = ModelRegistry.inMemory(authStorage);

registry.registerProvider("local-openai", {
  baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "$LOCAL_OPENAI_KEY",
  api: "openai-completions",
  models: [
    {
      id: "local-coder",
      name: "Local Coder",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 4096,
    },
  ],
});

const model = registry.find("local-openai", "local-coder");
if (!model) throw new Error("Registered model is unavailable");

const { session } = await createAgentSession({
  authStorage,
  modelRegistry: registry,
  model,
});
```

The mutable registry and selected model must be passed to the same session. Models not registered
in that registry are rejected. `apiKey` and custom header values retain the SDK configuration-value
syntax: a leading `!command` supplies the complete value, `$ENV_VAR` and `${ENV_VAR}` interpolate
environment variables, `$$` emits `$`, and `$!` emits `!`. Treat commands and inline credentials as
sensitive application configuration.

Use `registry.unregisterProvider(name)` only in SDK/test lifecycle code. The two source examples at
`examples/extensions/custom-provider-anthropic` and
`examples/extensions/custom-provider-gitlab-duo` retain their workspace names for dependency and
lockfile stability, but are programmatic registration helpers rather than loadable extensions.

For the official product contract and custom AdRouter endpoint boundary, see the
[canonical product guide](https://github.com/adrouter/adrouterCLI/blob/main/docs/about.md).
