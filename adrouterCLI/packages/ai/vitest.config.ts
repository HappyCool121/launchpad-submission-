import { defineConfig } from "vitest/config";

const reporters = process.env.GITHUB_ACTIONS ? (["dot", "github-actions"] as const) : (["dot"] as const);

export default defineConfig({
	test: {
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
				},
			},
		],
	},
});
