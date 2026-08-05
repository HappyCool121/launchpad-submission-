#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

function collectEntries(root, directory = root, entries = new Map()) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		const relativePath = relative(root, path).replaceAll("\\", "/");
		if (entry.isDirectory()) {
			collectEntries(root, path, entries);
			continue;
		}
		if (entry.isFile()) {
			entries.set(relativePath, { contents: readFileSync(path), type: "file" });
			continue;
		}
		if (entry.isSymbolicLink()) {
			entries.set(relativePath, { target: readlinkSync(path), type: "symlink" });
			continue;
		}
		throw new Error(`Unsupported bundled payload entry: ${path}`);
	}
	return entries;
}

export function compareBundledPayload(sourceRoot, payloadRoot) {
	const sourceEntries = collectEntries(sourceRoot);
	const payloadEntries = collectEntries(payloadRoot);
	const failures = [];

	for (const [path, sourceEntry] of sourceEntries) {
		const payloadEntry = payloadEntries.get(path);
		if (!payloadEntry) {
			failures.push(`missing: ${path}`);
			continue;
		}
		if (sourceEntry.type !== payloadEntry.type) {
			failures.push(`changed type: ${path}`);
			continue;
		}
		if (sourceEntry.type === "file") {
			if (!sourceEntry.contents.equals(payloadEntry.contents)) failures.push(`changed bytes: ${path}`);
		} else if (sourceEntry.target !== payloadEntry.target) {
			failures.push(`changed symlink: ${path}`);
		}
	}

	for (const path of payloadEntries.keys()) {
		if (!sourceEntries.has(path)) failures.push(`unexpected: ${path}`);
	}

	if (failures.length > 0) {
		throw new Error(`Bundled payload differs from source:\n${failures.sort().map((failure) => `- ${failure}`).join("\n")}`);
	}

	return sourceEntries.size;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (process.argv.length !== 4) {
		console.error("Usage: node scripts/verify-bundled-payload.mjs <source-bundled-dir> <payload-bundled-dir>");
		process.exit(2);
	}
	const [, , sourceRoot, payloadRoot] = process.argv;
	const sourceMode = lstatSync(sourceRoot);
	const payloadMode = lstatSync(payloadRoot);
	if (!sourceMode.isDirectory() || !payloadMode.isDirectory()) {
		throw new Error("Both bundled payload paths must be directories");
	}
	const count = compareBundledPayload(sourceRoot, payloadRoot);
	console.log(`Bundled payload matches source (${count} entries).`);
}
