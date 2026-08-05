import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const isolatedAgentDir = mkdtempSync(join(tmpdir(), "adrouter-vitest-state-"));
process.env.ADROUTER_CODING_AGENT_DIR = isolatedAgentDir;
process.once("exit", () => rmSync(isolatedAgentDir, { recursive: true, force: true }));

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));
const reporters = process.env.GITHUB_ACTIONS ? (["dot", "github-actions"] as const) : (["dot"] as const);

export default defineConfig({
	test: {
		env: { ADROUTER_CODING_AGENT_DIR: isolatedAgentDir },
		projects: [
			{
				test: {
					name: "parallel",
					globals: true,
					environment: "node",
					exclude: ["**/*.process.test.ts"],
					testTimeout: 30000,
					reporters: [...reporters],
					sequence: { groupOrder: 0 },
					silent: "passed-only",
					server: {
						deps: {
							external: [/@silvia-odwyer\/photon-node/],
						},
					},
				},
			},
			{
				test: {
					name: "process",
					globals: true,
					environment: "node",
					include: ["**/*.process.test.ts"],
					fileParallelism: false,
					testTimeout: 60000,
					reporters: [...reporters],
					sequence: { groupOrder: 1 },
					silent: "passed-only",
					server: {
						deps: {
							external: [/@silvia-odwyer\/photon-node/],
						},
					},
				},
			},
		],
	},
	resolve: {
		alias: [
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});
