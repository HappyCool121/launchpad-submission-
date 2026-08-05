import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyProfile,
	getProfile,
	getProfilesDir,
	loadProfiles,
	restoreProfile,
	saveProfile,
	validateProfileName,
} from "../src/core/profiles.ts";

const originalProfilesDir = process.env.ADROUTER_PROFILES_DIR;
const originalPiProfilesDir = process.env.PI_PROFILES_DIR;
let root: string;
let profilesDir: string;
let projectDir: string;

beforeEach(() => {
	root = join(tmpdir(), `adrouter-profiles-${process.pid}-${Math.random().toString(36).slice(2)}`);
	profilesDir = join(root, "profiles");
	projectDir = join(root, "project");
	mkdirSync(projectDir, { recursive: true });
	process.env.ADROUTER_PROFILES_DIR = profilesDir;
	process.env.PI_PROFILES_DIR = join(root, "forbidden-pi-profiles");
});

afterEach(() => {
	if (originalProfilesDir === undefined) delete process.env.ADROUTER_PROFILES_DIR;
	else process.env.ADROUTER_PROFILES_DIR = originalProfilesDir;
	if (originalPiProfilesDir === undefined) delete process.env.PI_PROFILES_DIR;
	else process.env.PI_PROFILES_DIR = originalPiProfilesDir;
	rmSync(root, { recursive: true, force: true });
});

describe("AdRouterCLI profiles", () => {
	it("keeps a clean home empty and honors only ADROUTER_PROFILES_DIR", () => {
		mkdirSync(process.env.PI_PROFILES_DIR!, { recursive: true });
		mkdirSync(join(process.env.PI_PROFILES_DIR!, "inherited"));
		expect(getProfilesDir()).toBe(profilesDir);
		expect(loadProfiles()).toEqual([]);
	});

	it("creates and lists isolated directory profiles", () => {
		saveProfile({ name: "router", provider: "adrouter", model: "deepseek-v4-flash", thinking: "medium" });
		expect(loadProfiles()).toEqual([
			{
				name: "router",
				path: join(profilesDir, "router"),
				provider: "adrouter",
				model: "deepseek-v4-flash",
				thinking: "medium",
			},
		]);
		expect(JSON.parse(readFileSync(join(profilesDir, "router", "settings.json"), "utf8"))).toEqual({
			defaultProvider: "adrouter",
			defaultModel: "deepseek-v4-flash",
			defaultThinkingLevel: "medium",
		});
	});

	it("applies, switches, and restores project files without replacing the original backup", () => {
		saveProfile({ name: "flash", provider: "adrouter", model: "deepseek-v4-flash" });
		saveProfile({ name: "pro", provider: "adrouter", model: "deepseek-v4-pro", thinking: "high" });
		writeFileSync(join(profilesDir, "flash", "SYSTEM.md"), "flash system\n");
		writeFileSync(join(profilesDir, "pro", "SYSTEM.md"), "pro system\n");
		const configDir = join(projectDir, ".adrouter");
		mkdirSync(configDir);
		writeFileSync(join(configDir, "settings.json"), '{"original":true}\n');
		writeFileSync(join(configDir, "SYSTEM.md"), "original system\n");

		applyProfile("flash", projectDir);
		expect(readFileSync(join(configDir, "SYSTEM.md"), "utf8")).toBe("flash system\n");
		applyProfile("pro", projectDir);
		expect(readFileSync(join(configDir, "SYSTEM.md"), "utf8")).toBe("pro system\n");
		expect(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"))).toMatchObject({
			defaultModel: "deepseek-v4-pro",
		});

		restoreProfile(projectDir);
		expect(readFileSync(join(configDir, "settings.json"), "utf8")).toBe('{"original":true}\n');
		expect(readFileSync(join(configDir, "SYSTEM.md"), "utf8")).toBe("original system\n");
		expect(existsSync(join(configDir, ".profile-active.json"))).toBe(false);
		expect(existsSync(join(configDir, ".profile-backup.settings.json"))).toBe(false);
	});

	it("restores absence and supports dry runs without writes", () => {
		saveProfile({ name: "router", provider: "adrouter", model: "deepseek-v4-flash" });
		const preview = applyProfile("router", projectDir, { dryRun: true });
		expect(preview.actions).toContain("apply router/settings.json");
		expect(existsSync(join(projectDir, ".adrouter"))).toBe(false);
		applyProfile("router", projectDir);
		restoreProfile(projectDir);
		expect(existsSync(join(projectDir, ".adrouter", "settings.json"))).toBe(false);
	});

	it("rejects traversal, malformed profile settings, and unsafe project symlinks", () => {
		for (const invalid of ["../escape", "two words", ".", "name/child", "-leading"]) {
			expect(() => validateProfileName(invalid)).toThrow("Invalid profile name");
		}
		mkdirSync(join(profilesDir, "broken"), { recursive: true });
		writeFileSync(join(profilesDir, "broken", "settings.json"), "not json");
		expect(() => getProfile("broken")).toThrow("Invalid profile settings");
	});
});
