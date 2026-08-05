/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import { randomUUID } from "node:crypto";
import { type AdRouterPrivateJwk, type AdRouterStorageClass, DEFAULT_ADROUTER_API_URL } from "@adrouter/ai";
import { validateAdRouterPrivateJwk } from "@adrouter/ai/api/adrouter-installation-auth";
import {
	findEnvKeys,
	getEnvApiKey,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "@adrouter/ai/compat";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@adrouter/ai/oauth";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
	env?: Record<string, string>;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AdRouterInstallationRecord = {
	type: "adrouter_installation";
	version: 1;
	privateJwk: AdRouterPrivateJwk;
	refreshCredential: string;
	installationId: string;
	origin: string;
	scopes: string[];
	refreshFamilyExpiresAt: number;
	clientKind: "cli";
	clientVersion: string;
	storageClass: AdRouterStorageClass;
	displayName: string;
	keyThumbprint: string;
	createdAt: number;
};

export type AdRouterPendingEnrollmentRecord = {
	type: "adrouter_pending_enrollment";
	version: 1;
	privateJwk: AdRouterPrivateJwk;
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	intervalSeconds: number;
	expiresAt: number;
	installationId?: string;
	origin: string;
	scopes: string[];
	clientVersion: string;
	displayName: string;
	createdAt: number;
};

export type AuthStorageRecord = AuthCredential | AdRouterInstallationRecord | AdRouterPendingEnrollmentRecord;

export type AdRouterAuthState = {
	installation?: AdRouterInstallationRecord;
	pending?: AdRouterPendingEnrollmentRecord;
};

export type AuthStorageData = Record<string, AuthStorageRecord>;

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback";
	label?: string;
};

export interface GetApiKeyOptions {
	includeFallback?: boolean;
}

type LockResult<T> = {
	result: T;
	next?: string;
};

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;
const INSTALLATION_KEY = "adrouter_installation";
const PENDING_ENROLLMENT_KEY = "adrouter_pending_enrollment";

function isProviderCredential(value: AuthStorageRecord | undefined): value is AuthCredential {
	return value?.type === "api_key" || value?.type === "oauth";
}

function storedOrigin(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value ? value : undefined;
	} catch {
		return undefined;
	}
}

function isSafeStoredVerificationUrl(value: unknown, origin: string): boolean {
	if (typeof value !== "string" || !value) return false;
	try {
		const url = new URL(value);
		if (url.username || url.password) return false;
		if (url.protocol === "https:") return true;
		const host = new URL(origin).hostname;
		return url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "::1");
	} catch {
		return false;
	}
}

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		const stat = lstatSync(dir);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error("Authentication directory is not a safe directory");
		}
		if (process.platform !== "win32") chmodSync(dir, 0o700);
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);
			chmodSync(this.authPath, 0o600);
		}
		const stat = lstatSync(this.authPath);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			throw new Error("Authentication file is not a safe regular file");
		}
		if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
			chmodSync(this.authPath, 0o600);
		}
	}

	private writeAtomically(content: string): void {
		const temporaryPath = `${this.authPath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporaryPath, content, { ...AUTH_FILE_WRITE_OPTIONS, flag: "wx" });
			if (process.platform !== "win32") chmodSync(temporaryPath, 0o600);
			renameSync(temporaryPath, this.authPath);
			if (process.platform !== "win32") chmodSync(this.authPath, 0o600);
		} catch (error) {
			try {
				if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
			} catch {
				// Preserve the original storage error.
			}
			throw error;
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				this.writeAtomically(next);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				this.writeAtomically(next);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private loadError: Error | null = null;
	private errors: Error[] = [];
	private storage: AuthStorageBackend;

	private constructor(storage: AuthStorageBackend) {
		this.storage = storage;
		this.reload();
	}

	static create(authPath?: string): AuthStorage {
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")));
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		const parsed = JSON.parse(content) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("Authentication file has an invalid top-level format");
		}
		const data = parsed as AuthStorageData;
		if (data[INSTALLATION_KEY] !== undefined) {
			data[INSTALLATION_KEY] = this.validateInstallationRecord(data[INSTALLATION_KEY]);
		}
		if (data[PENDING_ENROLLMENT_KEY] !== undefined) {
			data[PENDING_ENROLLMENT_KEY] = this.validatePendingEnrollmentRecord(data[PENDING_ENROLLMENT_KEY]);
		}
		return data;
	}

	private validateInstallationRecord(value: unknown): AdRouterInstallationRecord {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Invalid AdRouter installation record");
		const record = value as Record<string, unknown>;
		if (record.type !== "adrouter_installation" || record.version !== 1) {
			throw new Error("Unsupported AdRouter installation record version; re-enrollment is required");
		}
		const origin = storedOrigin(record.origin);
		if (
			typeof record.refreshCredential !== "string" ||
			!record.refreshCredential ||
			typeof record.installationId !== "string" ||
			!record.installationId ||
			!origin ||
			!Array.isArray(record.scopes) ||
			!record.scopes.every((scope) => typeof scope === "string") ||
			typeof record.refreshFamilyExpiresAt !== "number" ||
			!Number.isFinite(record.refreshFamilyExpiresAt) ||
			record.clientKind !== "cli" ||
			typeof record.clientVersion !== "string" ||
			record.storageClass !== "file_protected" ||
			typeof record.displayName !== "string" ||
			typeof record.keyThumbprint !== "string" ||
			typeof record.createdAt !== "number" ||
			!Number.isFinite(record.createdAt)
		) {
			throw new Error("Invalid AdRouter installation record; re-enrollment is required");
		}
		return { ...(record as AdRouterInstallationRecord), privateJwk: validateAdRouterPrivateJwk(record.privateJwk) };
	}

	private validatePendingEnrollmentRecord(value: unknown): AdRouterPendingEnrollmentRecord {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Invalid AdRouter enrollment record");
		const record = value as Record<string, unknown>;
		if (record.type !== "adrouter_pending_enrollment" || record.version !== 1) {
			throw new Error("Unsupported AdRouter enrollment record version; restart enrollment");
		}
		const origin = storedOrigin(record.origin);
		if (
			typeof record.deviceCode !== "string" ||
			!record.deviceCode ||
			typeof record.userCode !== "string" ||
			!record.userCode ||
			!origin ||
			!isSafeStoredVerificationUrl(record.verificationUri, origin) ||
			(record.verificationUriComplete !== undefined &&
				!isSafeStoredVerificationUrl(record.verificationUriComplete, origin)) ||
			typeof record.intervalSeconds !== "number" ||
			!Number.isFinite(record.intervalSeconds) ||
			record.intervalSeconds < 1 ||
			typeof record.expiresAt !== "number" ||
			!Number.isFinite(record.expiresAt) ||
			!Array.isArray(record.scopes) ||
			!record.scopes.every((scope) => typeof scope === "string") ||
			typeof record.clientVersion !== "string" ||
			typeof record.displayName !== "string" ||
			typeof record.createdAt !== "number" ||
			!Number.isFinite(record.createdAt)
		) {
			throw new Error("Invalid AdRouter enrollment record; restart enrollment");
		}
		return {
			...(record as AdRouterPendingEnrollmentRecord),
			privateJwk: validateAdRouterPrivateJwk(record.privateJwk),
		};
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			this.data = this.parseStorageData(content);
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	private persistProviderChange(provider: string, credential: AuthCredential | undefined): AuthStorageData {
		if (this.loadError) {
			this.reload();
		}

		if (this.loadError) {
			const error = new Error(
				`Cannot update auth storage because it could not be loaded: ${this.loadError.message}`,
			);
			this.recordError(error);
			throw error;
		}

		try {
			let persistedData: AuthStorageData = {};
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				persistedData = merged;
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
			this.loadError = null;
			return persistedData;
		} catch (error) {
			this.recordError(error);
			throw error;
		}
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		const credential = this.data[provider];
		return isProviderCredential(credential) ? credential : undefined;
	}

	/**
	 * Get provider-scoped environment values for an API key credential.
	 */
	getProviderEnv(provider: string): Record<string, string> | undefined {
		const candidate = this.data[provider];
		const cred = isProviderCredential(candidate) ? candidate : undefined;
		const stored = cred?.type === "api_key" && cred.env ? { ...cred.env } : undefined;
		if (provider !== "adrouter") return stored;
		return {
			...stored,
			ADROUTER_API_URL: process.env.ADROUTER_API_URL || stored?.ADROUTER_API_URL || DEFAULT_ADROUTER_API_URL,
		};
	}

	/**
	 * Set credential for a provider.
	 */
	set(provider: string, credential: AuthCredential): void {
		this.data = this.persistProviderChange(provider, credential);
	}

	/**
	 * Remove credential for a provider.
	 */
	remove(provider: string): void {
		this.data = this.persistProviderChange(provider, undefined);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.entries(this.data).flatMap(([provider, credential]) =>
			isProviderCredential(credential) ? [provider] : [],
		);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return isProviderCredential(this.data[provider]);
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (isProviderCredential(this.data[provider])) return true;
		if (provider === "adrouter" && this.getAdRouterInstallation()) return true;
		if (getEnvApiKey(provider)) return true;
		return false;
	}

	/**
	 * Return auth status without exposing credential values or refreshing tokens.
	 */
	getAuthStatus(provider: string): AuthStatus {
		if (this.runtimeOverrides.has(provider)) {
			return { configured: true, source: "runtime", label: "--api-key" };
		}

		if (isProviderCredential(this.data[provider])) {
			return { configured: true, source: "stored" };
		}

		if (provider === "adrouter" && this.getAdRouterInstallation()) {
			return { configured: true, source: "stored", label: "approved installation" };
		}

		const envKeys = findEnvKeys(provider);
		if (envKeys?.[0]) {
			return { configured: true, source: "environment", label: envKeys[0] };
		}

		return { configured: false };
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 */
	getAll(): Record<string, AuthCredential> {
		return Object.fromEntries(
			Object.entries(this.data).filter((entry): entry is [string, AuthCredential] => isProviderCredential(entry[1])),
		);
	}

	getAdRouterInstallation(): AdRouterInstallationRecord | undefined {
		const record = this.data[INSTALLATION_KEY];
		return record?.type === "adrouter_installation" ? { ...record, scopes: [...record.scopes] } : undefined;
	}

	getAdRouterPendingEnrollment(): AdRouterPendingEnrollmentRecord | undefined {
		const record = this.data[PENDING_ENROLLMENT_KEY];
		return record?.type === "adrouter_pending_enrollment" ? { ...record, scopes: [...record.scopes] } : undefined;
	}

	setAdRouterPendingEnrollment(record: AdRouterPendingEnrollmentRecord): void {
		this.persistAdRouterState({ installation: this.getAdRouterInstallation(), pending: record });
	}

	clearAdRouterPendingEnrollment(): void {
		this.persistAdRouterState({ installation: this.getAdRouterInstallation() });
	}

	setAdRouterInstallation(record: AdRouterInstallationRecord): void {
		this.persistAdRouterState({ installation: record });
	}

	clearAdRouterAuth(): void {
		this.persistAdRouterState({});
	}

	private persistAdRouterState(state: AdRouterAuthState): void {
		try {
			let persistedData: AuthStorageData = {};
			this.storage.withLock((current) => {
				const merged = { ...this.parseStorageData(current) };
				if (state.installation) merged[INSTALLATION_KEY] = this.validateInstallationRecord(state.installation);
				else delete merged[INSTALLATION_KEY];
				if (state.pending) merged[PENDING_ENROLLMENT_KEY] = this.validatePendingEnrollmentRecord(state.pending);
				else delete merged[PENDING_ENROLLMENT_KEY];
				persistedData = merged;
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
			this.data = persistedData;
			this.loadError = null;
		} catch (error) {
			this.recordError(error);
			throw error;
		}
	}

	async withAdRouterAuthLock<T>(
		fn: (state: AdRouterAuthState) => Promise<{ result: T; next?: AdRouterAuthState }>,
	): Promise<T> {
		try {
			return await this.storage.withLockAsync(async (current) => {
				const currentData = this.parseStorageData(current);
				const installation = currentData[INSTALLATION_KEY];
				const pending = currentData[PENDING_ENROLLMENT_KEY];
				const state: AdRouterAuthState = {
					installation: installation?.type === "adrouter_installation" ? installation : undefined,
					pending: pending?.type === "adrouter_pending_enrollment" ? pending : undefined,
				};
				const update = await fn(state);
				if (!update.next) {
					this.data = currentData;
					this.loadError = null;
					return { result: update.result };
				}
				const merged = { ...currentData };
				if (update.next.installation) {
					merged[INSTALLATION_KEY] = this.validateInstallationRecord(update.next.installation);
				} else {
					delete merged[INSTALLATION_KEY];
				}
				if (update.next.pending) {
					merged[PENDING_ENROLLMENT_KEY] = this.validatePendingEnrollmentRecord(update.next.pending);
				} else {
					delete merged[PENDING_ENROLLMENT_KEY];
				}
				this.data = merged;
				this.loadError = null;
				return { result: update.result, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
			throw error;
		}
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		this.set(providerId, { type: "oauth", ...credentials });
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		this.remove(provider);
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		const result = await this.storage.withLockAsync(async (current) => {
			const currentData = this.parseStorageData(current);
			this.data = currentData;
			this.loadError = null;

			const cred = currentData[providerId];
			if (cred?.type !== "oauth") {
				return { result: null };
			}

			if (Date.now() < cred.expires) {
				return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
			}

			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(currentData)) {
				if (value.type === "oauth") {
					oauthCreds[key] = value;
				}
			}

			const refreshed = await getOAuthApiKey(providerId, oauthCreds);
			if (!refreshed) {
				return { result: null };
			}

			const merged: AuthStorageData = {
				...currentData,
				[providerId]: { type: "oauth", ...refreshed.newCredentials },
			};
			this.data = merged;
			this.loadError = null;
			return { result: refreshed, next: JSON.stringify(merged, null, 2) };
		});

		return result;
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. API key from auth.json
	 * 3. OAuth token from auth.json (auto-refreshed with locking)
	 * 4. Environment variable
	 */
	async getApiKey(providerId: string, options: GetApiKeyOptions = {}): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			return runtimeKey;
		}

		const cred = this.data[providerId];

		if (cred?.type === "api_key") {
			return resolveConfigValue(cred.key, cred.env);
		}

		if (cred?.type === "oauth") {
			const provider = getOAuthProvider(providerId);
			if (!provider) {
				// Unknown OAuth provider, can't get API key
				return undefined;
			}

			// Check if token needs refresh
			const needsRefresh = Date.now() >= cred.expires;

			if (needsRefresh) {
				// Use locked refresh to prevent race conditions
				try {
					const result = await this.refreshOAuthTokenWithLock(providerId);
					if (result) {
						return result.apiKey;
					}
				} catch (error) {
					this.recordError(error);
					// Refresh failed - re-read file to check if another instance succeeded
					this.reload();
					const updatedCred = this.data[providerId];

					if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
						// Another instance refreshed successfully, use those credentials
						return provider.getApiKey(updatedCred);
					}

					// Refresh truly failed - return undefined so model discovery skips this provider
					// User can /login to re-authenticate (credentials preserved for retry)
					return undefined;
				}
			} else {
				// Token not expired, use current access token
				return provider.getApiKey(cred);
			}
		}

		if (options.includeFallback === false) return undefined;

		// Fall back to environment variable
		const envKey = getEnvApiKey(providerId);
		if (envKey) return envKey;

		return undefined;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}
}
