#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const PRIVATE_PACKAGES = ["@adrouter/agent-core", "@adrouter/ai", "@adrouter/tui"];
export const EXPECTED_ADROUTER_MODEL_IDS = [
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"mimo-v2.5",
	"mimo-v2.5-pro",
	"agnes-2.0-flash",
	"agnes-2.5-flash",
	"agnes-2.5-pro",
	"agnes-2.5-pro-alpha",
];

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

export function assertAdRouterOfflineModelList(output) {
	const modelIds = output
		.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.split(/\r?\n/)
		.map((line) => line.match(/^adrouter\s{2,}(\S+)\s{2,}/)?.[1])
		.filter(Boolean);
	assert(
		JSON.stringify(modelIds) === JSON.stringify(EXPECTED_ADROUTER_MODEL_IDS),
		`Offline AdRouter model list is ${JSON.stringify(modelIds)}, expected ${JSON.stringify(EXPECTED_ADROUTER_MODEL_IDS)}`,
	);
}

function requiredFeatureSnapshot(resourceLoader) {
	const extensionErrors = resourceLoader.getExtensions().errors;
	assert(extensionErrors.length === 0, `Extension loading failed: ${JSON.stringify(extensionErrors)}`);
	const report = resourceLoader.getBundledFeatureReport?.();
	assert(report?.mode === "required", "Bundled features are not in required mode");
	assert(report.ready === true, `Bundled feature contract failed: ${(report.failures ?? []).join(", ")}`);
	return report;
}

export async function verifyInstalledRuntime({ packageRoot, project, agentDir, expectedVersion }) {
	const cliManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	assert(cliManifest.version === expectedVersion, `Installed CLI version is ${cliManifest.version}, expected ${expectedVersion}`);

	for (const name of PRIVATE_PACKAGES) {
		const dependencyRoot = join(packageRoot, "node_modules", ...name.split("/"));
		const stat = lstatSync(dependencyRoot);
		assert(stat.isDirectory() && !stat.isSymbolicLink(), `${name} must be a real nested package directory`);
		const manifest = JSON.parse(readFileSync(join(dependencyRoot, "package.json"), "utf8"));
		assert(manifest.version === expectedVersion, `${name}@${manifest.version} does not match ${expectedVersion}`);
	}

	const fixtureText = readFileSync(
		new URL("../packages/ai/test/fixtures/platform-auth-v1.json", import.meta.url),
		"utf8",
	);
	const fixture = JSON.parse(fixtureText);
	const releaseManifest = JSON.parse(readFileSync(new URL("../release-manifest.json", import.meta.url), "utf8"));
	assert(
		fixture.fixture_version === "platform-auth-v1" &&
			createHash("sha256").update(fixtureText).digest("hex") === releaseManifest.authentication.fixtureSha256,
		"Installed platform-auth fixture checksum differs",
	);
	const installedAi = await import(
		pathToFileURL(
			join(packageRoot, "node_modules", "@adrouter", "ai", "dist", "api", "adrouter-installation-auth.js"),
		).href
	);
	const installedCatalog = await import(
		pathToFileURL(
			join(packageRoot, "node_modules", "@adrouter", "ai", "dist", "providers", "adrouter.models.js"),
		).href
	);
	assert(
		JSON.stringify(Object.keys(installedCatalog.ADROUTER_MODELS)) ===
			JSON.stringify(EXPECTED_ADROUTER_MODEL_IDS),
		"Installed AdRouter catalog does not contain the exact expected model IDs",
	);
	const fixtureBody = new TextEncoder().encode(fixture.raw_body_utf8);
	assert(installedAi.contentDigestSha256(fixtureBody) === fixture.content_digest, "Installed exact-body digest differs");
	const installedProof = installedAi.createAdRouterDpopProof({
		privateJwk: fixture.test_private_jwk,
		method: fixture.method,
		url: fixture.normalized_htu,
		body: fixtureBody,
		accessToken: fixture.non_secret_test_access_token,
		nonce: fixture.claims.nonce,
		clientVersion: fixture.claims.client_version,
		now: fixture.claims.iat * 1000,
		jti: fixture.claims.jti,
	});
	assert(installedProof === fixture.proof_jwt, "Installed platform-auth proof differs");
	assert(installedAi.verifyAdRouterDpopProofForTest(installedProof), "Installed platform-auth proof is invalid");

	const api = await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href);
	const installedAuth = await import(pathToFileURL(join(packageRoot, "dist", "core", "adrouter-auth.js")).href);
	const authStorage = api.AuthStorage.inMemory();
	const generated = installedAi.generateAdRouterKeyPair();
	const origin = "https://api-staging.adrouter.co";
	authStorage.setAdRouterInstallation({
		type: "adrouter_installation",
		version: 1,
		privateJwk: generated.privateJwk,
		refreshCredential: "adr_rt_installed_fixture",
		installationId: "00000000-0000-4000-8000-000000000001",
		origin,
		scopes: ["agent:turn", "profile:read"],
		refreshFamilyExpiresAt: Date.now() + 3_600_000,
		clientKind: "cli",
		clientVersion: expectedVersion,
		storageClass: "file_protected",
		displayName: "installed verifier",
		keyThumbprint: installedAi.adRouterJwkThumbprint(generated.publicJwk),
		createdAt: Date.now(),
	});
	const refreshRequests = [];
	const installedManager = new installedAuth.AdRouterInstallationAuth(authStorage, async (input, init) => {
		refreshRequests.push({ input: String(input), init });
		if (refreshRequests.length === 1) {
			return new Response(JSON.stringify({ error: "A fresh DPoP nonce is required.", code: "use_dpop_nonce" }), {
				status: 401,
				headers: { "DPoP-Nonce": "installed_nonce_1234567890" },
			});
		}
		return new Response(
			JSON.stringify({
				access_token: "adr_at_installed_fixture",
				token_type: "DPoP",
				expires_in: 600,
				refresh_token: "adr_rt_installed_rotated",
				refresh_expires_in: 3600,
				installation_id: "00000000-0000-4000-8000-000000000001",
				client_kind: "cli",
				scope: "agent:turn profile:read",
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	});
	const installedAccess = await installedManager.getAccess(origin);
	assert(installedAccess.accessToken === "adr_at_installed_fixture", "Installed refresh did not return access");
	assert(refreshRequests.length === 2, "Installed refresh did not perform one nonce retry");
	assert(
		Buffer.from(refreshRequests[0].init.body).equals(Buffer.from(refreshRequests[1].init.body)),
		"Installed refresh changed exact body bytes during nonce retry",
	);
	const refreshHeaders = new Headers(refreshRequests[1].init.headers);
	assert(refreshHeaders.get("authorization") === null, "Refresh unexpectedly sent an access token");
	assert(refreshHeaders.get("content-digest")?.startsWith("sha-256=:") === true, "Refresh digest is missing");
	const refreshClaims = JSON.parse(Buffer.from(refreshHeaders.get("dpop").split(".")[1], "base64url").toString());
	assert(refreshClaims.nonce === "installed_nonce_1234567890", "Refresh retry did not bind the nonce");
	assert(
		authStorage.getAdRouterInstallation().refreshCredential === "adr_rt_installed_rotated",
		"Installed refresh rotation was not persisted",
	);

	const installedTransport = await import(
		pathToFileURL(join(packageRoot, "node_modules", "@adrouter", "ai", "dist", "api", "adrouter.js")).href
	);
	const originalFetch = globalThis.fetch;
	let turnRequest;
	try {
		globalThis.fetch = async (input, init) => {
			turnRequest = { input: String(input), init };
			return new Response(JSON.stringify({ assistant: { content: "installed transport ok" }, ads: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const model = {
			id: "deepseek-v4-flash",
			name: "Installed AdRouter verifier",
			api: "adrouter",
			provider: "adrouter",
			baseUrl: origin,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		await installedTransport
			.stream(model, { messages: [] }, {
				adrouterAuth: installedManager,
				headers: {
					authorization: "Bearer attacker",
					dpop: "attacker-proof",
					"content-digest": "attacker-digest",
					"content-type": "text/plain",
					"x-adrouter-client-kind": "attacker",
					"x-adrouter-client-version": "999.0.0",
				},
			})
			.result();
	} finally {
		globalThis.fetch = originalFetch;
	}
	const turnHeaders = new Headers(turnRequest.init.headers);
	assert(turnHeaders.get("authorization") === "DPoP adr_at_installed_fixture", "Turn auth header was replaceable");
	assert(turnHeaders.get("dpop") !== "attacker-proof", "Turn proof header was replaceable");
	assert(turnHeaders.get("content-digest") !== "attacker-digest", "Turn digest header was replaceable");
	assert(turnHeaders.get("content-type") === "application/json", "Turn content type was replaceable");
	assert(turnHeaders.get("x-adrouter-client-kind") === "cli", "Turn client kind was replaceable");
	assert(turnHeaders.get("x-adrouter-client-version") === expectedVersion, "Turn version was replaceable");

	const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await api.createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: {
				includeBundledFeatures: true,
				noContextFiles: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const serviceErrors = services.diagnostics.filter(({ type }) => type === "error");
		assert(serviceErrors.length === 0, `Runtime service diagnostics failed: ${JSON.stringify(serviceErrors)}`);
		const created = await api.createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
		});
		return {
			...created,
			services,
			diagnostics: services.diagnostics,
		};
	};

	const runtime = await api.createAgentSessionRuntime(createRuntime, {
		cwd: project,
		agentDir,
		sessionManager: api.SessionManager.inMemory(project),
	});
	try {
		await runtime.session.bindExtensions({});
		requiredFeatureSnapshot(runtime.services.resourceLoader);

		await runtime.session.reload();
		requiredFeatureSnapshot(runtime.services.resourceLoader);

		const result = await runtime.newSession();
		assert(result.cancelled === false, "Bundled extensions cancelled new-session verification");
		await runtime.session.bindExtensions({});
		requiredFeatureSnapshot(runtime.services.resourceLoader);
	} finally {
		await runtime.dispose();
	}
}
