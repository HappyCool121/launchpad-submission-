#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const failures = [];
const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { encoding: "buffer" });
if (listed.status !== 0) throw new Error("Unable to enumerate the public Git boundary");
const files = listed.stdout
	.toString("utf8")
	.split("\0")
	.filter(Boolean)
	.filter((file) => existsSync(file));

const historicalAttribution = (file) =>
	file.endsWith("/docs/CHANGELOG.md") ||
	file === "UPSTREAM.md" ||
	file === "THIRD_PARTY_NOTICES.md" ||
	file.endsWith("/THIRD_PARTY_NOTICES.md") ||
	file.includes("/bundled/");

function readableText(file) {
	const buffer = readFileSync(file);
	if (buffer.includes(0)) return undefined;
	const text = buffer.toString("utf8");
	return text.includes("\uFFFD") ? undefined : text;
}

for (const file of files) {
	const text = readableText(file);
	if (text === undefined) continue;
	const checks = [
		["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
		["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
		["npm token", /\bnpm_[A-Za-z0-9]{30,}\b/],
		[
			"credential assignment",
			/(?:ADROUTER|DEEPSEEK|OPENAI|ANTHROPIC|NPM)_API_KEY\s*=\s*["'](?!your_|replace_|example|test-|adrouter-token|runtime-secret|original)[^"']{12,}["']/,
		],
		["local provenance URL", /\blocal:\//i],
		["private orchestrator", /@adrouter\/orchestrator|packages\/orchestrator/],
		["Discord support route", /discord(?:\.com|\.gg)\//],
		["stale security route", /github\.com\/badlogic\/pi-mono\/blob\/[^)\s]+\/SECURITY\.md/],
	];
	for (const [label, expression] of checks) {
		if (expression.test(text)) failures.push(`${file}: ${label}`);
	}
	if (file.startsWith(".github/workflows/")) {
		if (/ADROUTER_(?:STAGING_)?API_KEY|staging-canary/.test(text)) {
			failures.push(`${file}: hosted inference credential dependency`);
		}
		if (/\/v1\/(?:agent\/turn|turn|profile)/.test(text)) {
			failures.push(`${file}: authenticated inference/profile call`);
		}
	}
	if (
		/"privateJwk"\s*:\s*\{[\s\S]{0,500}?"d"\s*:\s*"[A-Za-z0-9_-]{32,}"/.test(text) &&
		file !== "packages/ai/test/fixtures/platform-auth-v1.json"
	) {
		failures.push(`${file}: private JWK fixture outside the approved conformance vector`);
	}

	for (const match of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)\//g)) {
		if (!["alice", "bob", "developer", "foo", "runner", "test", "testuser", "user"].includes(match[1])) {
			failures.push(`${file}: developer path`);
		}
	}
	if (
		/@earendil-works(?:\\?\/|\\\/)pi-/.test(text) &&
		!historicalAttribution(file) &&
		file !== "scripts/check-release-readiness.mjs"
	) {
		failures.push(`${file}: legacy package scope outside explicit attribution`);
	}
	if (/github\.com\/earendil-works\/pi(?:-mono)?/.test(text)) {
		failures.push(`${file}: stale product repository`);
	}
}

const adrouterModels = readFileSync("packages/ai/src/providers/adrouter.models.ts", "utf8");
const runtimeAdRouterModels = adrouterModels.split("export const ADROUTER_MODELS =", 2)[1] ?? "";
if (/provider:\s*["'`]deepseek["'`]/.test(runtimeAdRouterModels)) {
	failures.push("AdRouter provider exposes the retired deepseek alias");
}

const privacy = readFileSync("docs/privacy.md", "utf8");
for (const commitment of [
	"AdRouter does not persist prompts, model output, or tool payloads in application logs or its usage ledger.",
	"Submitted conversation and tool context transit the hosted gateway and selected model provider to produce the response.",
	"Local sessions remain under the tester’s AdRouter state directory unless explicitly exported.",
	"must be deleted within 30 days after access ends.",
	"privacy@adrouter.co",
]) {
	if (!privacy.includes(commitment)) failures.push(`docs/privacy.md: missing required commitment: ${commitment}`);
}

const releaseManifest = JSON.parse(readFileSync("release-manifest.json", "utf8"));
const expectedAssets = [
	"adrouter-darwin-arm64.tar.gz",
	"adrouter-darwin-x64.tar.gz",
	"adrouter-linux-arm64.tar.gz",
	"adrouter-linux-x64.tar.gz",
	"adrouter-windows-arm64.zip",
	"adrouter-windows-x64.zip",
];
if (JSON.stringify(releaseManifest.nativeArtifacts.map((entry) => entry.name)) !== JSON.stringify(expectedAssets)) {
	failures.push("release-manifest.json: native asset inventory differs from the public contract");
}
for (const artifact of releaseManifest.nativeArtifacts) {
	if (artifact.status !== "blocked") failures.push(`${artifact.name}: standalone native archive must remain blocked`);
	if (readFileSync("README.md", "utf8").includes(`](${artifact.name})`)) {
		failures.push(`README.md: blocked artifact ${artifact.name} is advertised as a download`);
	}
}

if (failures.length) {
	console.error("Public boundary check failed:");
	for (const failure of [...new Set(failures)].sort()) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`Public boundary check passed (${files.length} tracked and candidate files scanned).`);
