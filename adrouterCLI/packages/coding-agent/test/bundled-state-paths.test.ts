import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("bundled feature state paths", () => {
	it("uses AdRouterCLI's configurable agent directory", () => {
		const source = readFileSync(
			new URL("../bundled/pi-subagents-0.30.0/src/shared/utils.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("process.env.ADROUTER_CODING_AGENT_DIR");
		expect(source).toContain('path.join(os.homedir(), ".adrouter", "agent")');
		const loaderSource = readFileSync(new URL("../src/core/extensions/loader.ts", import.meta.url), "utf8");
		expect(loaderSource).toContain('fsCache: path.join(getAgentDir(), "cache", "jiti")');
	});

	it("does not retain literal Pi state paths in active bundled sources", () => {
		const sourceRoot = new URL("../bundled/", import.meta.url);
		const activeSources = [
			"pi-subagents-0.30.0/install.mjs",
			"pi-subagents-0.30.0/src/agents/agent-management.ts",
			"pi-subagents-0.30.0/src/agents/agents.ts",
			"pi-subagents-0.30.0/src/agents/skills.ts",
			"pi-subagents-0.30.0/src/intercom/intercom-bridge.ts",
			"pi-subagents-0.30.0/src/runs/shared/mcp-direct-tool-allowlist.ts",
			"pi-subagents-0.30.0/src/shared/utils.ts",
		];

		for (const relativePath of activeSources) {
			const source = readFileSync(new URL(relativePath, sourceRoot), "utf8");
			expect(source, relativePath).not.toContain('".pi"');
		}
	});
});
