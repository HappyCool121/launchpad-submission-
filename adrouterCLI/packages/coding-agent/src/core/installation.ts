import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir, isBunBinary, VERSION } from "../config.ts";

export const BUNDLED_PRIVATE_DEPENDENCIES = ["@adrouter/agent-core", "@adrouter/ai", "@adrouter/tui"] as const;

export type InstallationKind = "packaged" | "source-linked" | "binary" | "unknown";

export interface BundledDependencyStatus {
	version?: string;
	ready: boolean;
}

export interface InstallationStatus {
	kind: InstallationKind;
	deployable: boolean;
	bundledDependencies: Record<string, BundledDependencyStatus>;
	bundledFeatures: {
		mode: "required" | "disabled";
	};
}

function readManifestVersion(path: string): string | undefined {
	try {
		const manifest = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
		return typeof manifest.version === "string" ? manifest.version : undefined;
	} catch {
		return undefined;
	}
}

function isRealDirectory(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

export function inspectInstallation(): InstallationStatus {
	const packageDir = getPackageDir();
	const sourceCheckout = existsSync(join(packageDir, "src"));
	const bundledDependencies: Record<string, BundledDependencyStatus> = {};

	for (const name of BUNDLED_PRIVATE_DEPENDENCIES) {
		const dependencyRoot = join(packageDir, "node_modules", ...name.split("/"));
		const version = readManifestVersion(join(dependencyRoot, "package.json"));
		bundledDependencies[name] = {
			version,
			ready:
				isRealDirectory(dependencyRoot) &&
				version === VERSION &&
				existsSync(join(dependencyRoot, "dist", "index.js")),
		};
	}

	const dependenciesReady = Object.values(bundledDependencies).every(({ ready }) => ready);
	let kind: InstallationKind;
	if (isBunBinary) {
		kind = "binary";
	} else if (sourceCheckout) {
		kind = "source-linked";
	} else if (dependenciesReady) {
		kind = "packaged";
	} else {
		kind = "unknown";
	}

	return {
		kind,
		deployable: kind === "packaged" && dependenciesReady,
		bundledDependencies,
		bundledFeatures: {
			mode: process.env.ADROUTER_BUNDLED_FEATURES === "off" ? "disabled" : "required",
		},
	};
}

export function packagedInstallationRequiresBundledFeatures(): boolean {
	const { kind, bundledFeatures } = inspectInstallation();
	return bundledFeatures.mode === "required" && (kind === "packaged" || kind === "unknown");
}
