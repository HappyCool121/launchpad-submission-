import { describe, expect, it } from "vitest";
import { getPiSpawnCommand } from "../bundled/pi-subagents-0.30.0/src/runs/shared/pi-spawn.ts";

describe("bundled subagent launcher", () => {
	it("uses AdRouterCLI when the active script does not need a Windows wrapper", () => {
		expect(getPiSpawnCommand(["--mode", "json"], { platform: "linux" })).toEqual({
			command: "adrouter",
			args: ["--mode", "json"],
		});
	});

	it("falls back to AdRouterCLI when Windows script resolution is unavailable", () => {
		expect(
			getPiSpawnCommand(["--mode", "json"], {
				platform: "win32",
				argv1: "missing-cli.js",
				existsSync: () => false,
				resolvePackageJson: () => {
					throw new Error("package metadata unavailable");
				},
			}),
		).toEqual({
			command: "adrouter",
			args: ["--mode", "json"],
		});
	});
});
