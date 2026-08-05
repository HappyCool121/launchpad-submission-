import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels } from "../src/cli/list-models.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

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

describe("offline model listing", () => {
	afterEach(() => vi.restoreAllMocks());

	it("lists the complete locked catalog in Router order before login", async () => {
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line = "") => output.push(String(line)));
		await listModels(ModelRegistry.create(AuthStorage.inMemory()));

		const ids = output
			.slice(1)
			.map((line) => line.match(/^adrouter\s{2,}(\S+)/)?.[1])
			.filter((id): id is string => Boolean(id));
		expect(ids).toEqual(expectedIds);
	});

	it("keeps mutable registries filtered by configured authentication", async () => {
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line = "") => output.push(String(line)));
		await listModels(ModelRegistry.inMemory(AuthStorage.inMemory()));
		expect(output.join("\n")).toContain("No models available");
	});
});
