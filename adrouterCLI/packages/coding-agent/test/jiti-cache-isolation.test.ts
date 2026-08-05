import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Jiti cache isolation", () => {
	it("never treats compiled cache artifacts as extension discovery inputs", async () => {
		const root = join(tmpdir(), `adrouter-jiti-discovery-${process.pid}-${Math.random().toString(36).slice(2)}`);
		temporaryDirectories.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const cacheDir = join(agentDir, "cache", "jiti");
		mkdirSync(cacheDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		for (const name of [
			"extensions-user",
			"extensions-e0",
			"extensions-e1",
			"extension-config",
			"extensions-a-first",
			"extensions-foo",
			"extensions-with-flag",
			"extensions-with-tool",
			"extensions-with-handlers",
			"extensions-tool-b",
			"extensions-cmd-b",
			"extensions-tool-result-2",
			"extensions-rebinding",
			"extensions-decided",
		]) {
			writeFileSync(join(cacheDir, `${name}.mjs`), "export default function cachedTestArtifact() {}\n");
		}

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			includeBundledFeatures: false,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();

		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getExtensions().errors).toEqual([]);
	});

	it("points direct Vitest state away from the real AdRouter directory", () => {
		const testAgentDir = resolve(getAgentDir());
		const realAgentDir = resolve(join(homedir(), ".adrouter", "agent"));

		expect(testAgentDir).not.toBe(realAgentDir);
		expect(testAgentDir.startsWith(resolve(tmpdir()))).toBe(true);
	});
});
