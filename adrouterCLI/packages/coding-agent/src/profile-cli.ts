#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import type { ThinkingLevel } from "@adrouter/agent-core";
import { applyProfile, loadProfiles, restoreProfile, saveProfile } from "./core/profiles.ts";

const USAGE = `Usage:
  adrouter-profile list
  adrouter-profile set <name> --provider <provider> --model <model> [--thinking <level>]
  adrouter-profile apply <name> [--cwd <path>] [--dry-run] [--no-launch] [-- ...args]
  adrouter-profile restore [--cwd <path>] [--dry-run]`;

function optionValue(args: string[], option: string): string | undefined {
	const index = args.indexOf(option);
	if (index < 0) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.\n${USAGE}`);
	return value;
}

function validateOptions(args: string[], valueOptions: Set<string>, flagOptions: Set<string>): void {
	for (let index = 0; index < args.length; index++) {
		const option = args[index];
		if (valueOptions.has(option)) {
			optionValue(args, option);
			index++;
		} else if (!flagOptions.has(option)) {
			throw new Error(`Unknown profile option: ${option}\n${USAGE}`);
		}
	}
}

function printResult(result: { actions: string[]; dryRun: boolean }): void {
	for (const action of result.actions) console.log(`${result.dryRun ? "would " : ""}${action}`);
}

function main(args: string[]): void {
	const [command, name] = args;
	if (command === "list") {
		for (const profile of loadProfiles()) {
			const fields = [profile.provider, profile.model, profile.thinking].filter(Boolean).join(" / ");
			console.log(`${profile.name}${fields ? `  ${fields}` : ""}`);
		}
		return;
	}
	if (command === "set" && name) {
		validateOptions(args.slice(2), new Set(["--provider", "--model", "--thinking"]), new Set());
		saveProfile({
			name,
			provider: optionValue(args, "--provider"),
			model: optionValue(args, "--model"),
			thinking: optionValue(args, "--thinking") as ThinkingLevel | undefined,
		});
		return;
	}
	if (command === "apply" && name) {
		const separator = args.indexOf("--");
		const options = separator >= 0 ? args.slice(2, separator) : args.slice(2);
		const launchArgs = separator >= 0 ? args.slice(separator + 1) : [];
		validateOptions(options, new Set(["--cwd"]), new Set(["--dry-run", "--no-launch"]));
		const cwd = optionValue(options, "--cwd") ?? process.cwd();
		const dryRun = options.includes("--dry-run");
		const noLaunch = options.includes("--no-launch") || dryRun;
		const result = applyProfile(name, cwd, { dryRun });
		printResult(result);
		if (!noLaunch) {
			const child = spawnSync("adrouter", launchArgs, { cwd: result.cwd, stdio: "inherit" });
			if (child.error) throw child.error;
			process.exitCode = child.status ?? 1;
		}
		return;
	}
	if (command === "restore") {
		validateOptions(args.slice(1), new Set(["--cwd"]), new Set(["--dry-run"]));
		const cwd = optionValue(args, "--cwd") ?? process.cwd();
		const result = restoreProfile(cwd, { dryRun: args.includes("--dry-run") });
		printResult(result);
		return;
	}
	throw new Error(USAGE);
}

try {
	main(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
