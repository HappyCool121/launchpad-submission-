import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ThinkingLevel } from "@adrouter/agent-core";

const PROFILE_SETTINGS_FILE = "settings.json";
const PROFILE_SYSTEM_FILE = "SYSTEM.md";
const PROJECT_CONFIG_DIR = ".adrouter";
const ACTIVE_PROFILE_FILE = ".profile-active.json";
const BACKUP_SETTINGS_FILE = ".profile-backup.settings.json";
const BACKUP_SYSTEM_FILE = ".profile-backup.SYSTEM.md";
const VALID_PROFILE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface AdRouterProfile {
	name: string;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
	path: string;
}

interface ManagedFileState {
	target: typeof PROFILE_SETTINGS_FILE | typeof PROFILE_SYSTEM_FILE;
	backup: typeof BACKUP_SETTINGS_FILE | typeof BACKUP_SYSTEM_FILE;
	existed: boolean;
}

interface ActiveProfileState {
	version: 1;
	profile: string;
	files: ManagedFileState[];
}

export interface ProfileActionResult {
	profile?: string;
	cwd: string;
	dryRun: boolean;
	actions: string[];
}

export function validateProfileName(name: string): string {
	const normalized = name.trim();
	if (!VALID_PROFILE_NAME.test(normalized) || normalized === "." || normalized === "..") {
		throw new Error(
			`Invalid profile name "${name}". Use 1-64 ASCII letters, numbers, dots, underscores, or hyphens; start and end with a letter or number.`,
		);
	}
	return normalized;
}

export function getProfilesDir(): string {
	const configured = process.env.ADROUTER_PROFILES_DIR?.trim();
	return resolve(configured || join(homedir(), ".adrouter", "profiles"));
}

function assertRegularFile(path: string): void {
	if (!existsSync(path)) return;
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Managed profile path must be a regular file: ${path}`);
}

function profileDirectory(name: string): string {
	return join(getProfilesDir(), validateProfileName(name));
}

function readProfile(name: string): AdRouterProfile {
	const normalized = validateProfileName(name);
	const path = profileDirectory(normalized);
	if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
		throw new Error(`Unknown profile "${normalized}". Create it with adrouter-profile set.`);
	}

	const settingsPath = join(path, PROFILE_SETTINGS_FILE);
	const systemPath = join(path, PROFILE_SYSTEM_FILE);
	assertRegularFile(settingsPath);
	assertRegularFile(systemPath);
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
			settings = parsed as Record<string, unknown>;
		} catch (error) {
			throw new Error(
				`Invalid profile settings for "${normalized}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const thinking = settings.defaultThinkingLevel;
	if (typeof thinking === "string" && !VALID_THINKING_LEVELS.has(thinking as ThinkingLevel)) {
		throw new Error(`Invalid thinking level in profile "${normalized}": ${thinking}`);
	}
	return {
		name: normalized,
		path,
		provider: typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined,
		model: typeof settings.defaultModel === "string" ? settings.defaultModel : undefined,
		thinking: typeof thinking === "string" ? (thinking as ThinkingLevel) : undefined,
	};
}

export function loadProfiles(): AdRouterProfile[] {
	const root = getProfilesDir();
	if (!existsSync(root)) return [];
	if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
		throw new Error(`Profiles root must be a directory: ${root}`);
	}
	return readdirSync(root, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				!entry.isSymbolicLink() &&
				VALID_PROFILE_NAME.test(entry.name) &&
				entry.name !== "." &&
				entry.name !== "..",
		)
		.map((entry) => readProfile(entry.name))
		.sort((left, right) => left.name.localeCompare(right.name));
}

export function getProfile(name: string): AdRouterProfile {
	return readProfile(name);
}

export function saveProfile(profile: Omit<AdRouterProfile, "path">): AdRouterProfile {
	const name = validateProfileName(profile.name);
	if (!profile.provider?.trim() || !profile.model?.trim()) {
		throw new Error("Profile set requires non-empty --provider and --model values.");
	}
	if (profile.thinking && !VALID_THINKING_LEVELS.has(profile.thinking)) {
		throw new Error(`Invalid thinking level: ${profile.thinking}`);
	}
	const path = profileDirectory(name);
	if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) {
		throw new Error(`Profile path must be a directory: ${path}`);
	}
	mkdirSync(path, { recursive: true });
	const settings = {
		defaultProvider: profile.provider.trim(),
		defaultModel: profile.model.trim(),
		...(profile.thinking ? { defaultThinkingLevel: profile.thinking } : {}),
	};
	writeFileAtomically(join(path, PROFILE_SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`);
	return readProfile(name);
}

function writeFileAtomically(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp-${process.pid}`;
	writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
	renameSync(temporaryPath, path);
}

function readActiveState(configDir: string): ActiveProfileState | undefined {
	const path = join(configDir, ACTIVE_PROFILE_FILE);
	if (!existsSync(path)) return undefined;
	assertRegularFile(path);
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as ActiveProfileState;
		const expectedFiles = managedFiles();
		if (
			parsed.version !== 1 ||
			typeof parsed.profile !== "string" ||
			!Array.isArray(parsed.files) ||
			parsed.files.length !== expectedFiles.length ||
			!expectedFiles.every((expected) =>
				parsed.files.some(
					(file) =>
						file.target === expected.target &&
						file.backup === expected.backup &&
						typeof file.existed === "boolean",
				),
			)
		) {
			throw new Error("unsupported marker format");
		}
		return parsed;
	} catch (error) {
		throw new Error(
			`Cannot use invalid profile marker ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function managedFiles(): ManagedFileState[] {
	return [
		{ target: PROFILE_SETTINGS_FILE, backup: BACKUP_SETTINGS_FILE, existed: false },
		{ target: PROFILE_SYSTEM_FILE, backup: BACKUP_SYSTEM_FILE, existed: false },
	];
}

function projectConfigDir(cwd: string): { cwd: string; configDir: string } {
	const resolvedCwd = resolve(cwd);
	if (!existsSync(resolvedCwd) || !lstatSync(resolvedCwd).isDirectory()) {
		throw new Error(`Working directory does not exist or is not a directory: ${resolvedCwd}`);
	}
	const configDir = join(resolvedCwd, PROJECT_CONFIG_DIR);
	if (existsSync(configDir) && (!lstatSync(configDir).isDirectory() || lstatSync(configDir).isSymbolicLink())) {
		throw new Error(`Project profile directory must be a real directory: ${configDir}`);
	}
	return { cwd: resolvedCwd, configDir };
}

export function applyProfile(name: string, cwd: string, options: { dryRun?: boolean } = {}): ProfileActionResult {
	const profile = readProfile(name);
	const project = projectConfigDir(cwd);
	const dryRun = options.dryRun === true;
	const actions: string[] = [];
	const existingState = readActiveState(project.configDir);
	const files = existingState?.files ?? managedFiles();

	for (const file of files) {
		const target = join(project.configDir, file.target);
		const backup = join(project.configDir, file.backup);
		const source = join(profile.path, file.target);
		assertRegularFile(source);
		assertRegularFile(target);
		assertRegularFile(backup);
		if (!existingState) {
			file.existed = existsSync(target);
			if (file.existed) actions.push(`backup ${file.target} -> ${file.backup}`);
		}
		actions.push(existsSync(source) ? `apply ${profile.name}/${file.target}` : `remove ${file.target}`);
	}
	if (dryRun) return { profile: profile.name, cwd: project.cwd, dryRun, actions };

	mkdirSync(project.configDir, { recursive: true });
	if (!existingState) {
		for (const file of files) {
			const target = join(project.configDir, file.target);
			const backup = join(project.configDir, file.backup);
			if (file.existed) copyFileSync(target, backup);
			else rmSync(backup, { force: true });
		}
		const state: ActiveProfileState = { version: 1, profile: profile.name, files };
		writeFileAtomically(join(project.configDir, ACTIVE_PROFILE_FILE), `${JSON.stringify(state, null, 2)}\n`);
	}
	for (const file of files) {
		const target = join(project.configDir, file.target);
		const source = join(profile.path, file.target);
		rmSync(target, { force: true });
		if (existsSync(source)) copyFileSync(source, target);
	}
	if (existingState) {
		const state: ActiveProfileState = { version: 1, profile: profile.name, files };
		writeFileAtomically(join(project.configDir, ACTIVE_PROFILE_FILE), `${JSON.stringify(state, null, 2)}\n`);
	}
	return { profile: profile.name, cwd: project.cwd, dryRun, actions };
}

export function restoreProfile(cwd: string, options: { dryRun?: boolean } = {}): ProfileActionResult {
	const project = projectConfigDir(cwd);
	const dryRun = options.dryRun === true;
	const state = readActiveState(project.configDir);
	if (!state) return { cwd: project.cwd, dryRun, actions: [] };
	const actions = state.files.map((file) => (file.existed ? `restore ${file.target}` : `remove ${file.target}`));
	if (dryRun) return { profile: state.profile, cwd: project.cwd, dryRun, actions };
	for (const file of state.files) {
		const target = join(project.configDir, file.target);
		const backup = join(project.configDir, file.backup);
		assertRegularFile(target);
		assertRegularFile(backup);
		if (file.existed && !existsSync(backup)) throw new Error(`Cannot restore missing profile backup: ${backup}`);
	}

	for (const file of state.files) {
		const target = join(project.configDir, file.target);
		const backup = join(project.configDir, file.backup);
		rmSync(target, { force: true });
		if (file.existed) {
			renameSync(backup, target);
		} else {
			rmSync(backup, { force: true });
		}
	}
	rmSync(join(project.configDir, ACTIVE_PROFILE_FILE), { force: true });
	return { profile: state.profile, cwd: project.cwd, dryRun, actions };
}
