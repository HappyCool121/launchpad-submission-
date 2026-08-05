/**
 * API Keys and OAuth
 *
 * Configure API key resolution via AuthStorage and ModelRegistry.
 */

import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@adrouter/cli";

// Default: AuthStorage uses the configured AdRouter agent directory.
// ModelRegistry.create returns the locked official AdRouter catalog.
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session: defaultAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
console.log("Session with default auth storage and model registry");
defaultAuthSession.dispose();

// Custom auth storage location
const customAuthStorage = AuthStorage.create("/tmp/my-app/auth.json");
const customModelRegistry = ModelRegistry.create(customAuthStorage);

const { session: customAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage: customAuthStorage,
	modelRegistry: customModelRegistry,
});
console.log("Session with custom auth storage location");
customAuthSession.dispose();

// Explicit mutable registry for SDK-only non-AdRouter provider use.
const simpleRegistry = ModelRegistry.inMemory(authStorage);
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");
const { session: runtimeKeySession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry: simpleRegistry,
});
console.log("Session with SDK-only mutable registry and runtime API key override");
runtimeKeySession.dispose();

const { session: builtInModelsSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry: simpleRegistry,
});
console.log("Session with mutable built-in model catalog");
builtInModelsSession.dispose();
