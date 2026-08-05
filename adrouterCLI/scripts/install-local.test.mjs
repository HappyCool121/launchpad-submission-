import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const expectedVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

function executable(prefix, name) {
	return process.platform === "win32" ? join(prefix, `${name}.cmd`) : join(prefix, "bin", name);
}

function run(command, args, env, timeout = 120_000) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		env,
		timeout,
	});
	assert.equal(
		result.status,
		0,
		`${command} ${args.join(" ")} failed (status ${result.status}, signal ${result.signal ?? "none"}, error ${
			result.error?.message ?? "none"
		})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
	);
	return result.stdout;
}

test("install:local exposes both commands from a temporary global prefix", () => {
	const root = mkdtempSync(join(tmpdir(), "adrouter-local-install-"));
	const prefix = join(root, "prefix");
	const isolatedHome = join(root, "home");
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const binDirectory = process.platform === "win32" ? prefix : join(prefix, "bin");
	const env = {
		...process.env,
		ADROUTER_CODING_AGENT_DIR: join(root, "state"),
		HOME: isolatedHome,
		NPM_CONFIG_PREFIX: prefix,
		npm_config_prefix: prefix,
		PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
		PI_NO_LOCAL_LLM: "1",
		USERPROFILE: isolatedHome,
	};

	try {
		run(npm, ["run", "install:local"], env);
		const adrouter = executable(prefix, "adrouter");
		const profile = executable(prefix, "adrouter-profile");
		assert.ok(existsSync(adrouter), `${adrouter} was not installed`);
		assert.ok(existsSync(profile), `${profile} was not installed`);
		assert.equal(run(adrouter, ["--version"], env, 45_000).trim(), expectedVersion);
		assert.match(run(adrouter, ["--help"], env, 45_000), /Usage:/);
		run(profile, ["list"], env, 45_000);
		const doctor = JSON.parse(run(adrouter, ["--json", "doctor"], env, 45_000));
		assert.deepEqual(
			{ kind: doctor.installation?.kind, deployable: doctor.installation?.deployable },
			{ kind: "packaged", deployable: true },
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
