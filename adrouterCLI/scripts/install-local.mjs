#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_PACKAGE, createBundledCliTarball } from "./npm-artifact.mjs";
import { assertPackageTarball } from "./package-policy.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const temporaryRoot = mkdtempSync(join(tmpdir(), "adrouter-local-package-"));

function run(command, args) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		env: process.env,
		shell: process.platform === "win32",
		stdio: "inherit",
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
	}
}

try {
	const { packed, tarball } = createBundledCliTarball({ outputDirectory: temporaryRoot });
	assertPackageTarball(CLI_PACKAGE, packed, tarball);
	run(npm, ["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
	console.log(`Installed verified packaged ${CLI_PACKAGE.name}@${packed.version}.`);
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
