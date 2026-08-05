#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = join(repoRoot, "packages", "coding-agent", "bundled", "pi-web-access-0.13.0");
mkdirSync(join(bundleRoot, "dist"), { recursive: true });

await build({
	entryPoints: [join(bundleRoot, "index.ts")],
	outfile: join(bundleRoot, "dist", "index.js"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	sourcemap: false,
	legalComments: "none",
	external: [
		"@adrouter/agent-core",
		"@adrouter/ai",
		"@adrouter/ai/*",
		"@adrouter/cli",
		"@adrouter/tui",
		"typebox",
		"typebox/*",
		"canvas",
		"@napi-rs/canvas",
	],
});
