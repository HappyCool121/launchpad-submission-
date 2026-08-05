import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const localEnvPath = resolve(root, ".env.local");
const environment = { ...process.env, LAUNCHPAD_SUBMISSION: "true" };

if (existsSync(localEnvPath)) {
	for (const line of readFileSync(localEnvPath, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf("=");
		if (separator < 1) continue;
		const key = trimmed.slice(0, separator).trim();
		let value = trimmed.slice(separator + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (environment[key] === undefined) environment[key] = value;
	}
}

environment.ADROUTER_API_URL ||= "http://127.0.0.1:8787";
environment.ADROUTER_RUNTIME_MODE = "live";
environment.ADROUTER_MODEL_ROUTE ||= "agnes-2.5-flash";

if (!environment.ADROUTER_API_KEY?.trim()) {
	console.error("ADROUTER_API_KEY is required. Copy .env.example to .env.local and use the Router bearer.");
	process.exit(1);
}
if (environment.AGNES_API_KEY) {
	console.error("AGNES_API_KEY must not be supplied to AdRouterCLI; keep it in Router only.");
	process.exit(1);
}

const child = spawn(process.execPath, [resolve(root, "packages/coding-agent/dist/cli.js"), ...process.argv.slice(2)], {
	cwd: process.cwd(),
	env: environment,
	stdio: "inherit",
});
child.once("error", (error) => {
	console.error(`Unable to start AdRouterCLI: ${error.message}`);
	process.exitCode = 1;
});
child.once("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exitCode = code ?? 1;
});
