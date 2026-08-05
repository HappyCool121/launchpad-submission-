export const ADROUTER_CLIENT_KIND = "cli" as const;
export const ADROUTER_STORAGE_CLASS = "file_protected" as const;
export const ADROUTER_INSTALLATION_SCOPES = ["agent:turn", "profile:read"] as const;

export type AdRouterClientKind = typeof ADROUTER_CLIENT_KIND;
export type AdRouterStorageClass = typeof ADROUTER_STORAGE_CLASS;

export type AdRouterPrivateJwk = {
	kty: "OKP";
	crv: "Ed25519";
	x: string;
	d: string;
};

export type AdRouterPublicJwk = {
	kty: "OKP";
	crv: "Ed25519";
	x: string;
};

export interface AdRouterInstallationAccess {
	accessToken: string;
	expiresAt: number;
	installationId: string;
	clientKind: AdRouterClientKind;
	clientVersion: string;
}

export interface AdRouterProofInput {
	method: string;
	url: string;
	body: Uint8Array;
	accessToken?: string;
	nonce?: string;
}

export interface AdRouterSignedProof {
	proof: string;
	contentDigest: string;
}

/**
 * App-owned installation authentication. The reusable transport receives only
 * short-lived access material and a proof operation; it never receives the
 * persisted private key or refresh credential.
 */
export interface InstallationAuthProvider {
	canAuthenticate(origin: string): boolean;
	getAccess(origin: string, signal?: AbortSignal): Promise<AdRouterInstallationAccess>;
	signProof(origin: string, input: AdRouterProofInput): Promise<AdRouterSignedProof>;
	rememberNonce(origin: string, nonce: string): void;
}

export function isValidAdRouterNonce(value: string | null | undefined): value is string {
	return typeof value === "string" && value.length >= 16 && value.length <= 512 && /^[A-Za-z0-9._~-]+$/.test(value);
}
