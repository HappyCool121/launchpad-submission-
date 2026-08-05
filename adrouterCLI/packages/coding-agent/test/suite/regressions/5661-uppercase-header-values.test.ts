import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { runMigrations } from "../../../src/migrations.ts";
import { createHarness } from "../harness.ts";

describe("regression #5661: retired model configuration", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	function withAgentDir(agentDir: string, fn: () => void): void {
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			fn();
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDir;
			}
		}
	}

	it("leaves legacy model configuration bytes inert during startup migrations", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		cleanups.push(harness.cleanup);

		const modelsPath = join(harness.tempDir, "models.json");
		writeFileSync(
			modelsPath,
			`${JSON.stringify(
				{
					providers: {
						"my-provider": {
							baseUrl: "https://example.com/v1",
							apiKey: "CUSTOM_API_KEY",
							api: "openai-completions",
							headers: { Authorization: "BEARER" },
							models: [{ id: "my-model" }],
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);

		const before = readFileSync(modelsPath);
		withAgentDir(harness.tempDir, () => runMigrations(harness.tempDir));
		expect(readFileSync(modelsPath)).toEqual(before);
	});
});
