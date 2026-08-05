import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADROUTER_MODELS } from "@adrouter/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry, ModelRegistryLockedError, type ProviderConfig } from "../src/core/model-registry.ts";

const expectedIds = [
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"mimo-v2.5",
	"mimo-v2.5-pro",
	"agnes-2.0-flash",
	"agnes-2.5-flash",
	"agnes-2.5-pro",
	"agnes-2.5-pro-alpha",
];

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "adrouter-registry-test-"));
	tempDirs.push(directory);
	return directory;
}

function createProviderConfig(): ProviderConfig {
	return {
		name: "Capture Provider",
		baseUrl: "https://capture.example.test/v1",
		apiKey: "test-key",
		api: "openai-completions",
		headers: { "x-provider": "capture" },
		models: [
			{
				id: "capture-model",
				name: "Capture Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16_384,
				maxTokens: 2_048,
				headers: { "x-model": "capture-model" },
			},
		],
	};
}

describe("locked official model registry", () => {
	it("contains exactly the generated AdRouter catalog in canonical order", () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory());
		const models = registry.getAll();

		expect(registry.isLocked()).toBe(true);
		expect(models.map(({ provider }) => provider)).toEqual(Array(8).fill("adrouter"));
		expect(models.map(({ id }) => id)).toEqual(expectedIds);
		expect(models).toEqual(Object.values(ADROUTER_MODELS));

		models.splice(0);
		expect(registry.getAll().map(({ id }) => id)).toEqual(expectedIds);
		expect(Object.isFrozen(registry.getAll()[0])).toBe(true);
	});

	it("throws the stable typed error for every mutation attempt", () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory());
		for (const mutate of [
			() => registry.registerProvider("capture", createProviderConfig()),
			() => registry.unregisterProvider("capture"),
		]) {
			expect(mutate).toThrowError(ModelRegistryLockedError);
			try {
				mutate();
			} catch (error) {
				expect(error).toMatchObject({ code: "model_registry_locked" });
			}
		}
	});

	it("treats refresh as a no-op", () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory());
		const before = registry.getAll();
		registry.refresh();
		expect(registry.getAll()).toEqual(before);
	});

	it.each([
		[
			"malicious",
			JSON.stringify({
				providers: {
					adrouter: {
						baseUrl: "https://attacker.invalid",
						apiKey: "secret",
						headers: { authorization: "Bearer attacker" },
						models: [
							{ id: "deepseek-v4-flash", contextWindow: 9_999_999, maxTokens: 9_999_999 },
							{ id: "deepseek-v4-flash", baseUrl: "https://duplicate.invalid" },
						],
					},
				},
			}),
		],
		["invalid", "{not json"],
	])("leaves %s models.json bytes untouched and behaviorally inert", (_name, contents) => {
		const directory = createTempDir();
		const modelsPath = join(directory, "models.json");
		writeFileSync(modelsPath, contents);
		const before = readFileSync(modelsPath);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const registry = ModelRegistry.create(AuthStorage.create(join(directory, "auth.json")));

		expect(registry.getAll().map(({ id }) => id)).toEqual(expectedIds);
		expect(registry.getAll()[0]).toEqual(ADROUTER_MODELS["deepseek-v4-flash"]);
		expect(readFileSync(modelsPath)).toEqual(before);
		expect(warning).not.toHaveBeenCalled();
		warning.mockRestore();
	});
});

describe("explicit mutable model registry", () => {
	it("preserves built-in providers and programmatic registration", async () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		expect(registry.isLocked()).toBe(false);
		expect(registry.find("anthropic", "claude-opus-4-8")).toBeDefined();

		registry.registerProvider("capture", createProviderConfig());
		const model = registry.find("capture", "capture-model");
		expect(model).toMatchObject({ provider: "capture", baseUrl: "https://capture.example.test/v1" });
		expect(await registry.getApiKeyAndHeaders(model!)).toEqual({
			ok: true,
			apiKey: "test-key",
			headers: { "x-provider": "capture", "x-model": "capture-model" },
		});
		expect(registry.getProviderAuthStatus("capture")).toEqual({
			configured: true,
			source: "runtime",
			label: "in-memory registry",
		});

		registry.unregisterProvider("capture");
		expect(registry.find("capture", "capture-model")).toBeUndefined();
	});
});
