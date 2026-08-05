# Models

The default AdRouterCLI registry is generated from the committed Router catalog and contains only
the eight official AdRouter models. Their order, descriptions, providers, classes, thinking modes,
defaults, and limits are maintained in the
[canonical product guide](https://github.com/adrouter/adrouterCLI/blob/main/docs/about.md#official-model-catalog).

Use `/model` to select from the active registry or list the official catalog without network access:

```sh
adrouter --offline --list-models adrouter
```

The official registry is immutable. Local executable model configuration is not loaded or watched,
and project files cannot change hosted model endpoints, headers, keys, limits, or duplicate model
identity. Official unknown or altered model objects are rejected.

An explicitly configured custom or loopback AdRouter endpoint may return private AdRouter model IDs.
Those IDs inherit canonical AdRouter runtime properties and use the configured custom endpoint and
credential boundary. Non-AdRouter providers are available only to SDK applications that construct,
populate, and inject `ModelRegistry.inMemory()` as described in
[SDK-only custom providers](custom-provider.md).
