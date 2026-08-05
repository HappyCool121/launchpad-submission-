import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@adrouter/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("createAgentSession model registry boundary", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let previousApiUrl: string | undefined;

	beforeEach(() => {
		previousApiUrl = process.env.ADROUTER_API_URL;
		delete process.env.ADROUTER_API_URL;
		tempDir = mkdtempSync(join(tmpdir(), "adrouter-sdk-registry-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (previousApiUrl === undefined) delete process.env.ADROUTER_API_URL;
		else process.env.ADROUTER_API_URL = previousApiUrl;
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createOptions(registry: ModelRegistry) {
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();
		return {
			cwd,
			agentDir,
			authStorage: registry.authStorage,
			modelRegistry: registry,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		};
	}

	it("uses the active registry's canonical official model object", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory());
		const canonical = registry.getAll()[0]!;
		const { session } = await createAgentSession({ ...(await createOptions(registry)), model: { ...canonical } });
		expect(session.model).toBe(canonical);
		session.dispose();
	});

	it("rejects unknown and caller-altered models on the official endpoint", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory());
		const canonical = registry.getAll()[0]!;
		const common = await createOptions(registry);

		await expect(createAgentSession({ ...common, model: { ...canonical, id: "unknown-official" } })).rejects.toThrow(
			/not registered.*ModelRegistry\.inMemory/s,
		);
		await expect(
			createAgentSession({ ...common, model: { ...canonical, maxTokens: canonical.maxTokens + 1 } }),
		).rejects.toThrow(/alters the official AdRouter catalog/);
		await expect(
			createAgentSession({
				...common,
				model: canonical,
				scopedModels: [{ model: { ...canonical, contextWindow: canonical.contextWindow + 1 } }],
			}),
		).rejects.toThrow(/alters the official AdRouter catalog/);
	});

	it("retains unknown AdRouter IDs only for an explicit custom endpoint", async () => {
		process.env.ADROUTER_API_URL = "http://127.0.0.1:8787";
		const registry = ModelRegistry.create(AuthStorage.inMemory());
		const base = registry.getAll()[0]!;
		const custom = { ...base, id: "router-private-model", name: "Router Private Model", maxTokens: 999999 };
		const { session } = await createAgentSession({ ...(await createOptions(registry)), model: custom });

		expect(session.model).toMatchObject({
			provider: "adrouter",
			id: "router-private-model",
			name: "Router Private Model",
			contextWindow: base.contextWindow,
			maxTokens: base.maxTokens,
		});
		session.dispose();
	});

	it("accepts a model registered in an explicitly mutable SDK registry", async () => {
		const authStorage = AuthStorage.inMemory();
		const registry = ModelRegistry.inMemory(authStorage);
		const model: Model<any> = {
			id: "sdk-model",
			name: "SDK Model",
			api: "openai-completions",
			provider: "sdk-provider",
			baseUrl: "http://127.0.0.1:9999/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32000,
			maxTokens: 2048,
		};
		registry.registerProvider(model.provider, {
			api: model.api,
			apiKey: "sdk-test-key",
			baseUrl: model.baseUrl,
			models: [model],
		});
		const { session } = await createAgentSession({ ...(await createOptions(registry)), model });
		expect(session.model).toBe(registry.find(model.provider, model.id));
		session.dispose();
	});
});
