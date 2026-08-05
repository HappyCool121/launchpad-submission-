#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ADROUTER_CATALOG_PATH,
	parseAdRouterCatalog,
	renderAdRouterModelsModule,
} from "../packages/ai/scripts/adrouter-catalog.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedPath = resolve(root, "packages/ai/src/providers/adrouter.models.ts");
const defaultSource = resolve(root, "../../router/backend/catalog/model-catalog.v1.json");

function parseArgs(args) {
	let check = false;
	let source;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--check") {
			check = true;
			continue;
		}
		if (argument === "--source" && args[index + 1]) {
			source = resolve(args[++index]);
			continue;
		}
		throw new Error("Usage: node scripts/sync-adrouter-catalog.mjs [--check] [--source <path>]");
	}
	return { check, source };
}

function assertSameBytes(left, right, message) {
	if (!left.equals(right)) throw new Error(message);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const vendorBytes = options.check ? readFileSync(ADROUTER_CATALOG_PATH) : undefined;
	const sourcePath = options.source ?? (options.check ? undefined : defaultSource);
	const sourceBytes = sourcePath ? readFileSync(sourcePath) : undefined;
	const catalog = parseAdRouterCatalog(sourceBytes ?? vendorBytes);
	const expectedGenerated = Buffer.from(renderAdRouterModelsModule(catalog));

	if (options.check) {
		if (sourceBytes) assertSameBytes(sourceBytes, vendorBytes, "Router source and vendored catalog differ byte-for-byte");
		assertSameBytes(
			readFileSync(generatedPath),
			expectedGenerated,
			"Generated AdRouter catalog is stale; run npm run catalog:generate",
		);
		console.log(`OK: AdRouter catalog ${catalog.catalog_digest} is valid and generated output is current.`);
		return;
	}

	mkdirSync(dirname(ADROUTER_CATALOG_PATH), { recursive: true });
	writeFileSync(ADROUTER_CATALOG_PATH, sourceBytes);
	const generated = spawnSync(
		process.execPath,
		[resolve(root, "packages/ai/scripts/generate-models.ts"), "--provider", "adrouter"],
		{ cwd: root, stdio: "inherit" },
	);
	if (generated.status !== 0) throw new Error(`AdRouter catalog generation failed with status ${generated.status}`);
	console.log(`Synchronized ${sourcePath} to ${ADROUTER_CATALOG_PATH}.`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
