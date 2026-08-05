import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
	ADROUTER_CLIENT_KIND,
	ADROUTER_INSTALLATION_SCOPES,
	ADROUTER_PROVIDER_ID,
	ADROUTER_STORAGE_CLASS,
	type AdRouterInstallationAccess,
	type AdRouterPrivateJwk,
	type AdRouterProfile,
	DEFAULT_ADROUTER_API_URL,
	type InstallationAuthProvider,
	isOfficialAdRouterApiUrl,
	isValidAdRouterNonce,
	resolveAdRouterApiUrl as resolveSharedAdRouterApiUrl,
	validateAdRouterApiKey,
} from "@adrouter/ai";
import {
	adRouterJwkThumbprint,
	contentDigestSha256,
	createAdRouterDpopProof,
	generateAdRouterKeyPair,
	publicJwkFromPrivate,
} from "@adrouter/ai/api/adrouter-installation-auth";
import { gte, valid } from "semver";
import { VERSION } from "../config.ts";
import type { AdRouterInstallationRecord, AdRouterPendingEnrollmentRecord, AuthStorage } from "./auth-storage.ts";

export { ADROUTER_PROVIDER_ID, DEFAULT_ADROUTER_API_URL };

const DEVICE_AUTHORIZATION_PATH = "/v1/device/authorizations";
const DEVICE_AUTHORIZATION_CANCEL_PATH = "/v1/device/authorizations/cancel";
const TOKEN_PATH = "/v1/oauth/token";
const PROFILE_PATH = "/v1/profile";
const REVOKE_PATH = "/v1/installation/revoke";
const DEFAULT_POLL_SECONDS = 5;
const MAX_POLL_SECONDS = 30;
const ACCESS_REFRESH_SKEW_MS = 60_000;

type JsonRecord = Record<string, unknown>;

export type AdRouterCredentialSource = "runtime" | "stored" | "environment" | "installation" | "missing";

export interface AdRouterEnrollmentCallbacks {
	signal?: AbortSignal;
	confirm(info: { signInUrl: string }): Promise<boolean>;
	onDeviceCode(info: {
		userCode: string;
		verificationUri: string;
		verificationUriComplete?: string;
		expiresAt: number;
	}): void;
	onProgress?(message: string): void;
}

const OFFICIAL_WEB_APP_ORIGINS: Readonly<Record<string, string>> = {
	"https://api-staging.adrouter.co": "https://app-staging.adrouter.co",
	"https://api.adrouter.co": "https://app.adrouter.co",
};

export interface AdRouterAuthDiagnostics {
	state: "unconfigured" | "pending" | "ready" | "expired" | "invalid";
	clientKind: "cli";
	storage: "file_protected";
	originClass: "official" | "loopback" | "custom";
	scopes: string[];
	refreshHealth: "missing" | "valid" | "expired";
	signedRequests: boolean;
	pendingEnrollment: boolean;
	serverPolicyMode: "unknown" | "observe" | "warn" | "enforce";
	minimumVersionCompatible: boolean | null;
	reenrollmentRequired: boolean;
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

async function responseJson(response: Response): Promise<JsonRecord> {
	try {
		return asRecord(await response.json());
	} catch {
		return {};
	}
}

function stringField(record: JsonRecord, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = record[name];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function numberField(record: JsonRecord, ...names: string[]): number | undefined {
	for (const name of names) {
		const value = record[name];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

class AdRouterProtocolError extends Error {
	readonly code?: string;
	readonly status: number;
	readonly retryable: boolean;
	readonly serverTime?: number;

	constructor(message: string, input: { code?: string; status: number; retryable?: boolean; serverTime?: number }) {
		super(message);
		this.name = "AdRouterProtocolError";
		this.code = input.code;
		this.status = input.status;
		this.retryable = input.retryable ?? false;
		this.serverTime = input.serverTime;
	}
}

function safeProtocolError(response: Response, body: JsonRecord, fallback: string): Error {
	const code = stringField(body, "code", "error");
	const serverDate = response.headers.get("date");
	const parsedServerTime = serverDate ? Date.parse(serverDate) : Number.NaN;
	const serverTime = Number.isFinite(parsedServerTime) ? parsedServerTime : undefined;
	if (response.status === 426 || code === "client_upgrade_required") {
		return new AdRouterProtocolError(
			"This AdRouter installation requires a newer AdRouterCLI version. Update the package and try again.",
			{ code, status: response.status, serverTime },
		);
	}
	if (code === "invalid_dpop_proof") {
		const drift = serverTime === undefined ? undefined : Math.abs(serverTime - Date.now());
		const clockHint =
			drift !== undefined && drift > 30_000
				? " Your computer clock differs from the AdRouter server; enable automatic date and time sync, then retry."
				: " Check that your computer date and time are set automatically, then retry.";
		return new AdRouterProtocolError(`AdRouter rejected the signed installation proof.${clockHint}`, {
			code,
			status: response.status,
			serverTime,
		});
	}
	const safeMessages: Readonly<Record<string, string>> = {
		client_not_allowed: "This AdRouter client is not currently allowed.",
		developer_required: "This AdRouter account does not have developer access.",
		installation_not_allowed: "This AdRouter installation is no longer allowed. Run /login adrouter again.",
		invalid_access_token: "This AdRouter installation credential is no longer valid. Run /login adrouter again.",
		rate_limited: "AdRouter received too many login attempts. Wait a moment, then retry.",
	};
	const message = code ? safeMessages[code] : undefined;
	return new AdRouterProtocolError(message ?? `${fallback} (HTTP ${response.status}${code ? `, ${code}` : ""})`, {
		code,
		status: response.status,
		retryable: response.status === 429 || response.status >= 500,
		serverTime,
	});
}

function originClass(origin: string): AdRouterAuthDiagnostics["originClass"] {
	if (isOfficialAdRouterApiUrl(origin)) return "official";
	const host = new URL(origin).hostname;
	return host === "localhost" || host === "127.0.0.1" || host === "::1" ? "loopback" : "custom";
}

function signInUrlFor(origin: string, browserHandoffId: string): string {
	const webAppOrigin = OFFICIAL_WEB_APP_ORIGINS[origin];
	if (!webAppOrigin) throw new Error("AdRouter does not have a sign-in page configured for this hosted endpoint");
	return `${webAppOrigin}/developers?connect=cli#handoff=${encodeURIComponent(browserHandoffId)}`;
}

function validateBrowserUrl(value: string, apiOrigin: string): string {
	const url = new URL(value);
	if (url.username || url.password) throw new Error("AdRouter returned an unsafe verification URL");
	const local = originClass(apiOrigin) === "loopback";
	if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
		throw new Error("AdRouter returned an unsafe verification URL");
	}
	return url.toString();
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("Login cancelled"));
	return new Promise((resolve, reject) => {
		const finish = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(new Error("Login cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function encodeBody(value: JsonRecord): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

function createProtocolHeaders(input: {
	privateJwk: AdRouterPrivateJwk;
	method: string;
	url: string;
	body?: Uint8Array;
	nonce?: string;
	accessToken?: string;
	clientVersion: string;
}): Headers {
	const headers = new Headers({
		accept: "application/json",
		"x-adrouter-client-kind": ADROUTER_CLIENT_KIND,
		"x-adrouter-client-version": input.clientVersion,
	});
	if (input.body) {
		headers.set("content-digest", contentDigestSha256(input.body));
		headers.set("content-type", "application/json");
	}
	if (input.accessToken) headers.set("authorization", `DPoP ${input.accessToken}`);
	headers.set("dpop", createAdRouterDpopProof(input));
	return headers;
}

async function signedProtocolRequest(input: {
	fetchImpl: typeof fetch;
	privateJwk: AdRouterPrivateJwk;
	clientVersion: string;
	method: string;
	url: string;
	body?: Uint8Array;
	accessToken?: string;
	nonce?: string;
	signal?: AbortSignal;
	onNonce?: (nonce: string) => void;
}): Promise<Response> {
	const send = async (nonce?: string): Promise<Response> => {
		const response = await input.fetchImpl(input.url, {
			method: input.method,
			headers: createProtocolHeaders({ ...input, nonce }),
			body: input.body,
			signal: input.signal,
			redirect: "error",
		});
		if (response.redirected) throw new Error("Authenticated redirects are not allowed");
		return response;
	};
	let response = await send(input.nonce);
	let nonce = response.headers.get("dpop-nonce");
	if (response.status === 401 && isValidAdRouterNonce(nonce)) {
		await response.body?.cancel();
		input.onNonce?.(nonce);
		response = await send(nonce);
		nonce = response.headers.get("dpop-nonce");
	}
	if (isValidAdRouterNonce(nonce)) input.onNonce?.(nonce);
	return response;
}

function parseTokenResponse(
	body: JsonRecord,
	now = Date.now(),
): {
	access: AdRouterInstallationAccess;
	refreshCredential: string;
	refreshFamilyExpiresAt: number;
} {
	const accessToken = stringField(body, "access_token", "accessToken");
	const refreshCredential = stringField(body, "refresh_token", "refreshCredential", "refreshToken");
	const installationId = stringField(body, "installation_id", "installationId");
	const expiresIn = numberField(body, "expires_in", "expiresIn") ?? 600;
	const familyExpiresIn = numberField(
		body,
		"refresh_expires_in",
		"refreshExpiresIn",
		"refresh_family_expires_in",
		"refreshFamilyExpiresIn",
	);
	const familyExpiresAt = numberField(body, "refresh_family_expires_at", "refreshFamilyExpiresAt");
	if (!accessToken || !refreshCredential || !installationId || expiresIn <= 0) {
		throw new Error("AdRouter returned an invalid credential response; re-enrollment is required");
	}
	return {
		access: {
			accessToken,
			expiresAt: now + expiresIn * 1000,
			installationId,
			clientKind: ADROUTER_CLIENT_KIND,
			clientVersion: VERSION,
		},
		refreshCredential,
		refreshFamilyExpiresAt: familyExpiresAt ?? now + (familyExpiresIn ?? 2_592_000) * 1000,
	};
}

export function resolveAdRouterApiUrl(authStorage: AuthStorage): string {
	const stored = authStorage.getProviderEnv(ADROUTER_PROVIDER_ID)?.ADROUTER_API_URL;
	return resolveSharedAdRouterApiUrl({
		environmentUrl: process.env.ADROUTER_API_URL,
		credentialUrl: stored,
	});
}

export async function validateAndStoreAdRouterApiKey(
	authStorage: AuthStorage,
	apiKey: string,
	signal?: AbortSignal,
): Promise<AdRouterProfile> {
	const apiUrl = resolveAdRouterApiUrl(authStorage);
	if (isOfficialAdRouterApiUrl(apiUrl)) {
		throw new Error(
			"Official AdRouter endpoints use an approved installation. Use /login adrouter to connect this CLI.",
		);
	}
	const profile = await validateAdRouterApiKey({ apiKey, apiUrl, signal });
	authStorage.set(ADROUTER_PROVIDER_ID, {
		type: "api_key",
		key: apiKey.trim(),
		env: { ADROUTER_API_URL: apiUrl },
	});
	return profile;
}

async function createPendingEnrollment(
	authStorage: AuthStorage,
	origin: string,
	browserHandoffId: string,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<AdRouterPendingEnrollmentRecord> {
	const { privateJwk, publicJwk } = generateAdRouterKeyPair();
	const displayName = `AdRouterCLI on ${hostname().slice(0, 64) || "this computer"}`;
	const body = encodeBody({
		client_kind: ADROUTER_CLIENT_KIND,
		client_version: VERSION,
		display_name: displayName,
		public_key_jwk: publicJwk,
		requested_scopes: [...ADROUTER_INSTALLATION_SCOPES],
		storage_class: ADROUTER_STORAGE_CLASS,
		browser_handoff_id: browserHandoffId,
	});
	const url = `${origin}${DEVICE_AUTHORIZATION_PATH}`;
	const response = await signedProtocolRequest({
		fetchImpl,
		privateJwk,
		clientVersion: VERSION,
		method: "POST",
		url,
		body,
		signal,
	});
	const result = await responseJson(response);
	if (!response.ok) throw safeProtocolError(response, result, "Could not start AdRouter enrollment");
	const deviceCode = stringField(result, "device_code", "deviceCode");
	const userCode = stringField(result, "user_code", "userCode");
	const rawVerificationUri = stringField(result, "verification_uri", "verificationUri");
	const rawCompleteUri = stringField(result, "verification_uri_complete", "verificationUriComplete");
	const expiresIn = numberField(result, "expires_in", "expiresIn") ?? 600;
	const intervalSeconds = Math.max(DEFAULT_POLL_SECONDS, numberField(result, "interval") ?? DEFAULT_POLL_SECONDS);
	if (!deviceCode || !userCode || !rawVerificationUri || expiresIn <= 0) {
		throw new Error("AdRouter returned an invalid enrollment response");
	}
	const pending: AdRouterPendingEnrollmentRecord = {
		type: "adrouter_pending_enrollment",
		version: 1,
		privateJwk,
		deviceCode,
		userCode,
		verificationUri: validateBrowserUrl(rawVerificationUri, origin),
		verificationUriComplete: rawCompleteUri ? validateBrowserUrl(rawCompleteUri, origin) : undefined,
		intervalSeconds: Math.min(MAX_POLL_SECONDS, intervalSeconds),
		expiresAt: Date.now() + expiresIn * 1000,
		installationId: stringField(result, "installation_id", "installationId"),
		origin,
		scopes: [...ADROUTER_INSTALLATION_SCOPES],
		clientVersion: VERSION,
		displayName,
		createdAt: Date.now(),
	};
	authStorage.setAdRouterPendingEnrollment(pending);
	return pending;
}

async function redeemPendingEnrollment(
	pending: AdRouterPendingEnrollmentRecord,
	fetchImpl: typeof fetch,
	signal: AbortSignal | undefined,
	onProgress?: (message: string) => void,
): Promise<ReturnType<typeof parseTokenResponse>> {
	let intervalSeconds = Math.max(DEFAULT_POLL_SECONDS, pending.intervalSeconds);
	let networkFailures = 0;
	let nonce: string | undefined;
	while (Date.now() < pending.expiresAt) {
		await wait(intervalSeconds * 1000, signal);
		const body = encodeBody({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: pending.deviceCode,
			client_kind: ADROUTER_CLIENT_KIND,
		});
		let response: Response;
		try {
			response = await signedProtocolRequest({
				fetchImpl,
				privateJwk: pending.privateJwk,
				clientVersion: pending.clientVersion,
				method: "POST",
				url: `${pending.origin}${TOKEN_PATH}`,
				body,
				nonce,
				onNonce: (value) => {
					nonce = value;
				},
				signal,
			});
			networkFailures = 0;
		} catch {
			if (signal?.aborted) throw new Error("Login cancelled");
			networkFailures++;
			intervalSeconds = Math.min(MAX_POLL_SECONDS, Math.max(intervalSeconds, 2 ** networkFailures));
			onProgress?.("AdRouter is temporarily unreachable; enrollment polling will continue.");
			continue;
		}
		const result = await responseJson(response);
		if (response.ok) return parseTokenResponse(result);
		const errorCode = stringField(result, "code", "error");
		if (errorCode === "authorization_pending") continue;
		if (errorCode === "slow_down") {
			intervalSeconds = Math.min(MAX_POLL_SECONDS, intervalSeconds + 5);
			continue;
		}
		if (errorCode === "access_denied") throw new Error("AdRouter installation approval was denied");
		if (errorCode === "expired_token") throw new Error("AdRouter installation approval expired; start again");
		throw safeProtocolError(response, result, "AdRouter enrollment failed");
	}
	throw new Error("AdRouter installation approval expired; start again");
}

async function validateEnrollmentProfile(
	pending: AdRouterPendingEnrollmentRecord,
	access: AdRouterInstallationAccess,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<void> {
	let nonce: string | undefined;
	const response = await signedProtocolRequest({
		fetchImpl,
		privateJwk: pending.privateJwk,
		clientVersion: pending.clientVersion,
		method: "GET",
		url: `${pending.origin}${PROFILE_PATH}`,
		accessToken: access.accessToken,
		nonce,
		onNonce: (value) => {
			nonce = value;
		},
		signal,
	});
	const result = await responseJson(response);
	if (!response.ok) throw safeProtocolError(response, result, "AdRouter profile validation failed");
}

async function cancelPendingEnrollment(
	pending: AdRouterPendingEnrollmentRecord,
	fetchImpl: typeof fetch,
): Promise<boolean> {
	const signal = AbortSignal.timeout(5_000);
	const body = encodeBody({
		device_code: pending.deviceCode,
		client_kind: ADROUTER_CLIENT_KIND,
	});
	try {
		const response = await signedProtocolRequest({
			fetchImpl,
			privateJwk: pending.privateJwk,
			clientVersion: pending.clientVersion,
			method: "POST",
			url: `${pending.origin}${DEVICE_AUTHORIZATION_CANCEL_PATH}`,
			body,
			signal,
		});
		await response.body?.cancel();
		return response.ok;
	} catch {
		return false;
	}
}

export async function enrollAdRouterInstallation(
	authStorage: AuthStorage,
	callbacks: AdRouterEnrollmentCallbacks,
	fetchImpl: typeof fetch = fetch,
): Promise<AdRouterInstallationRecord> {
	const apiUrl = resolveAdRouterApiUrl(authStorage);
	if (!isOfficialAdRouterApiUrl(apiUrl)) {
		throw new Error("Installation enrollment is only used for official hosted AdRouter endpoints");
	}
	const origin = new URL(apiUrl).origin;
	// A new explicit login is the recovery boundary after a crash or hard quit.
	// Remove any abandoned key before waiting for user confirmation.
	await authStorage.withAdRouterAuthLock(async (state) => ({
		result: undefined,
		next: { installation: state.installation },
	}));
	const browserHandoffId = randomUUID();
	if (!(await callbacks.confirm({ signInUrl: signInUrlFor(origin, browserHandoffId) })))
		throw new Error("Login cancelled");
	let pending: AdRouterPendingEnrollmentRecord | undefined;
	try {
		pending = await createPendingEnrollment(authStorage, origin, browserHandoffId, fetchImpl, callbacks.signal);
		callbacks.onDeviceCode({
			userCode: pending.userCode,
			verificationUri: pending.verificationUri,
			verificationUriComplete: pending.verificationUriComplete,
			expiresAt: pending.expiresAt,
		});
		const tokens = await redeemPendingEnrollment(pending, fetchImpl, callbacks.signal, callbacks.onProgress);
		const installation: AdRouterInstallationRecord = {
			type: "adrouter_installation",
			version: 1,
			privateJwk: pending.privateJwk,
			refreshCredential: tokens.refreshCredential,
			installationId: tokens.access.installationId,
			origin,
			scopes: [...ADROUTER_INSTALLATION_SCOPES],
			refreshFamilyExpiresAt: tokens.refreshFamilyExpiresAt,
			clientKind: ADROUTER_CLIENT_KIND,
			clientVersion: VERSION,
			storageClass: ADROUTER_STORAGE_CLASS,
			displayName: pending.displayName,
			keyThumbprint: adRouterJwkThumbprint(publicJwkFromPrivate(pending.privateJwk)),
			createdAt: Date.now(),
		};
		// Validate the candidate entirely in memory. A rejected candidate never
		// replaces a previously working installation on disk.
		await validateEnrollmentProfile(pending, tokens.access, fetchImpl, callbacks.signal);
		const pendingDeviceCode = pending.deviceCode;
		await authStorage.withAdRouterAuthLock(async (state) => {
			if (state.pending?.deviceCode !== pendingDeviceCode) {
				throw new Error("Enrollment state changed in another process; run /login adrouter again");
			}
			return { result: undefined, next: { installation } };
		});
		const manager = new AdRouterInstallationAuth(authStorage, fetchImpl);
		manager.seedAccess(tokens.access);
		return installation;
	} catch (error) {
		try {
			await authStorage.withAdRouterAuthLock(async (state) => ({
				result: undefined,
				next: {
					installation: state.installation,
					pending: pending && state.pending?.deviceCode === pending.deviceCode ? undefined : state.pending,
				},
			}));
		} catch {
			// Preserve the original enrollment error when cleanup storage is unavailable.
		}
		if (pending) {
			const cancelled = await cancelPendingEnrollment(pending, fetchImpl);
			callbacks.onProgress?.(
				cancelled
					? "Removed the failed AdRouter authorization; the next login will start cleanly."
					: "Removed the local login key. The next login will start cleanly.",
			);
		}
		throw error;
	}
}

export class AdRouterInstallationAuth implements InstallationAuthProvider {
	private readonly access = new Map<string, AdRouterInstallationAccess>();
	private readonly nonces = new Map<string, string>();
	private readonly refreshes = new Map<string, Promise<AdRouterInstallationAccess>>();
	private readonly authStorage: AuthStorage;
	private readonly fetchImpl: typeof fetch;

	constructor(authStorage: AuthStorage, fetchImpl: typeof fetch = fetch) {
		this.authStorage = authStorage;
		this.fetchImpl = fetchImpl;
	}

	seedAccess(value: AdRouterInstallationAccess): void {
		const installation = this.authStorage.getAdRouterInstallation();
		if (installation) this.access.set(installation.origin, value);
	}

	canAuthenticate(origin: string): boolean {
		const installation = this.authStorage.getAdRouterInstallation();
		return !!installation && installation.origin === origin && installation.refreshFamilyExpiresAt > Date.now();
	}

	async getAccess(origin: string, signal?: AbortSignal): Promise<AdRouterInstallationAccess> {
		const cached = this.access.get(origin);
		if (cached && cached.expiresAt - ACCESS_REFRESH_SKEW_MS > Date.now()) return cached;
		const existing = this.refreshes.get(origin);
		if (existing) return existing;
		const refresh = this.refreshAccess(origin, signal);
		this.refreshes.set(origin, refresh);
		try {
			return await refresh;
		} finally {
			if (this.refreshes.get(origin) === refresh) this.refreshes.delete(origin);
		}
	}

	private async refreshAccess(origin: string, signal?: AbortSignal): Promise<AdRouterInstallationAccess> {
		let rotated = false;
		try {
			const access = await this.authStorage.withAdRouterAuthLock(async (state) => {
				const installation = state.installation;
				if (!installation || installation.origin !== origin || installation.refreshFamilyExpiresAt <= Date.now()) {
					throw new Error("AdRouter installation is missing or expired; run /login adrouter");
				}
				const body = encodeBody({
					grant_type: "refresh_token",
					refresh_token: installation.refreshCredential,
					installation_id: installation.installationId,
				});
				const response = await signedProtocolRequest({
					fetchImpl: this.fetchImpl,
					privateJwk: installation.privateJwk,
					clientVersion: installation.clientVersion,
					method: "POST",
					url: `${origin}${TOKEN_PATH}`,
					body,
					nonce: this.nonces.get(origin),
					onNonce: (nonce) => this.rememberNonce(origin, nonce),
					signal,
				});
				const result = await responseJson(response);
				if (!response.ok) throw safeProtocolError(response, result, "AdRouter credential refresh failed");
				const tokens = parseTokenResponse(result);
				rotated = true;
				return {
					result: tokens.access,
					next: {
						installation: {
							...installation,
							refreshCredential: tokens.refreshCredential,
							refreshFamilyExpiresAt: tokens.refreshFamilyExpiresAt,
						},
					},
				};
			});
			this.access.set(origin, access);
			return access;
		} catch (error) {
			this.access.delete(origin);
			if (rotated) {
				try {
					this.authStorage.clearAdRouterAuth();
				} catch {
					// The original persistence failure remains authoritative.
				}
				throw new Error("AdRouter refresh rotation could not be saved safely; re-enrollment is required");
			}
			throw error;
		}
	}

	async signProof(origin: string, input: Parameters<InstallationAuthProvider["signProof"]>[1]) {
		const installation = this.authStorage.getAdRouterInstallation();
		if (!installation || installation.origin !== origin) throw new Error("AdRouter installation is unavailable");
		return {
			proof: createAdRouterDpopProof({
				privateJwk: installation.privateJwk,
				method: input.method,
				url: input.url,
				body: input.body,
				accessToken: input.accessToken,
				nonce: input.nonce ?? this.nonces.get(origin),
				clientVersion: installation.clientVersion,
			}),
			contentDigest: contentDigestSha256(input.body),
		};
	}

	rememberNonce(origin: string, nonce: string): void {
		if (isValidAdRouterNonce(nonce)) this.nonces.set(origin, nonce);
	}

	private async authenticatedRequest(
		origin: string,
		method: string,
		path: string,
		bodyValue: JsonRecord | undefined,
		signal?: AbortSignal,
	): Promise<Response> {
		const access = await this.getAccess(origin, signal);
		const body = bodyValue ? encodeBody(bodyValue) : undefined;
		const installation = this.authStorage.getAdRouterInstallation();
		if (!installation) throw new Error("AdRouter installation is unavailable");
		const response = await signedProtocolRequest({
			fetchImpl: this.fetchImpl,
			privateJwk: installation.privateJwk,
			clientVersion: installation.clientVersion,
			method,
			url: `${origin}${path}`,
			body,
			accessToken: access.accessToken,
			nonce: this.nonces.get(origin),
			onNonce: (nonce) => this.rememberNonce(origin, nonce),
			signal,
		});
		const nonce = response.headers.get("dpop-nonce");
		if (isValidAdRouterNonce(nonce)) this.rememberNonce(origin, nonce);
		return response;
	}

	async getProfile(origin: string, signal?: AbortSignal): Promise<JsonRecord> {
		const response = await this.authenticatedRequest(origin, "GET", PROFILE_PATH, undefined, signal);
		const result = await responseJson(response);
		if (!response.ok) throw safeProtocolError(response, result, "AdRouter profile validation failed");
		return result;
	}

	async signOut(signal?: AbortSignal): Promise<{ remoteRevocationConfirmed: boolean }> {
		const installation = this.authStorage.getAdRouterInstallation();
		let remoteRevocationConfirmed = false;
		try {
			if (installation) {
				const response = await this.authenticatedRequest(
					installation.origin,
					"POST",
					REVOKE_PATH,
					{ installation_id: installation.installationId },
					signal,
				);
				remoteRevocationConfirmed = response.ok;
			}
		} catch {
			remoteRevocationConfirmed = false;
		} finally {
			this.access.clear();
			this.nonces.clear();
			this.authStorage.clearAdRouterAuth();
		}
		return { remoteRevocationConfirmed };
	}

	diagnostics(): AdRouterAuthDiagnostics {
		const installation = this.authStorage.getAdRouterInstallation();
		const pending = this.authStorage.getAdRouterPendingEnrollment();
		const now = Date.now();
		const pendingActive = !!pending && pending.expiresAt > now;
		const refreshValid = !!installation && installation.refreshFamilyExpiresAt > now;
		const origin = installation?.origin ?? pending?.origin ?? resolveAdRouterApiUrl(this.authStorage);
		const blockedLegacyBearer = isOfficialAdRouterApiUrl(origin) && !!this.authStorage.get(ADROUTER_PROVIDER_ID);
		return {
			state: refreshValid
				? "ready"
				: installation
					? "expired"
					: pendingActive
						? "pending"
						: blockedLegacyBearer
							? "invalid"
							: "unconfigured",
			clientKind: ADROUTER_CLIENT_KIND,
			storage: ADROUTER_STORAGE_CLASS,
			originClass: originClass(origin),
			scopes: installation?.scopes ?? pending?.scopes ?? [],
			refreshHealth: refreshValid ? "valid" : installation ? "expired" : "missing",
			signedRequests: refreshValid,
			pendingEnrollment: pendingActive,
			serverPolicyMode: "unknown",
			minimumVersionCompatible: null,
			reenrollmentRequired: (!!installation && !refreshValid) || blockedLegacyBearer,
		};
	}

	async diagnosticsWithServer(signal?: AbortSignal): Promise<AdRouterAuthDiagnostics> {
		const local = this.diagnostics();
		const installation = this.authStorage.getAdRouterInstallation();
		if (!installation || !local.signedRequests) return local;
		try {
			const profile = await this.getProfile(installation.origin, signal);
			const installationProfile = asRecord(profile.installation);
			const policy = stringField(installationProfile, "policy_mode", "client_policy_mode");
			const minimumVersion = stringField(installationProfile, "minimum_version");
			return {
				...local,
				serverPolicyMode: policy === "observe" || policy === "warn" || policy === "enforce" ? policy : "unknown",
				minimumVersionCompatible:
					minimumVersion && valid(minimumVersion) && valid(VERSION) ? gte(VERSION, minimumVersion) : null,
			};
		} catch {
			return local;
		}
	}
}

export async function resolveAdRouterCredentials(
	authStorage: AuthStorage,
): Promise<{ apiKey?: string; apiUrl: string; source: AdRouterCredentialSource }> {
	const apiUrl = resolveAdRouterApiUrl(authStorage);
	const installation = authStorage.getAdRouterInstallation();
	if (isOfficialAdRouterApiUrl(apiUrl) && installation?.origin === new URL(apiUrl).origin) {
		return { apiUrl, source: "installation" };
	}
	const status = authStorage.getAuthStatus(ADROUTER_PROVIDER_ID);
	const apiKey = isOfficialAdRouterApiUrl(apiUrl) ? undefined : await authStorage.getApiKey(ADROUTER_PROVIDER_ID);
	const source =
		status.source === "runtime" || status.source === "stored" || status.source === "environment"
			? status.source
			: apiKey
				? "environment"
				: "missing";
	return { apiKey, apiUrl, source };
}
