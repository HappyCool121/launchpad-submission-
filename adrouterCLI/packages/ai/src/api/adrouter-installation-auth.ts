import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomUUID,
	sign,
	verify,
} from "node:crypto";
import {
	ADROUTER_CLIENT_KIND,
	type AdRouterClientKind,
	type AdRouterPrivateJwk,
	type AdRouterPublicJwk,
} from "./adrouter-installation-auth-types.ts";

export * from "./adrouter-installation-auth-types.ts";

export interface AdRouterProofClaims {
	jti: string;
	htm: string;
	htu: string;
	iat: number;
	bht?: string;
	client_kind: AdRouterClientKind;
	client_version: string;
	ath?: string;
	nonce?: string;
}

function assertBase64Url(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new Error(`Invalid ${label}`);
	}
}

export function validateAdRouterPrivateJwk(value: unknown): AdRouterPrivateJwk {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid installation key");
	const jwk = value as Record<string, unknown>;
	if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") throw new Error("Unsupported installation key");
	assertBase64Url(jwk.x, "installation public key");
	assertBase64Url(jwk.d, "installation private key");
	const normalized: AdRouterPrivateJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d };
	try {
		const derived = createPublicKey(createPrivateKey({ key: normalized, format: "jwk" })).export({ format: "jwk" });
		if (derived.kty !== "OKP" || derived.crv !== "Ed25519" || derived.x !== normalized.x) {
			throw new Error("mismatch");
		}
	} catch {
		throw new Error("Invalid installation key");
	}
	return normalized;
}

export function publicJwkFromPrivate(value: AdRouterPrivateJwk): AdRouterPublicJwk {
	const jwk = validateAdRouterPrivateJwk(value);
	return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

export function generateAdRouterKeyPair(): {
	privateJwk: AdRouterPrivateJwk;
	publicJwk: AdRouterPublicJwk;
} {
	const { privateKey } = generateKeyPairSync("ed25519");
	const privateJwk = validateAdRouterPrivateJwk(privateKey.export({ format: "jwk" }));
	return { privateJwk, publicJwk: publicJwkFromPrivate(privateJwk) };
}

export function base64UrlSha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("base64url");
}

export function contentDigestSha256(body: Uint8Array): string {
	return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
}

export function adRouterJwkThumbprint(jwk: AdRouterPublicJwk): string {
	assertBase64Url(jwk.x, "installation public key");
	return base64UrlSha256(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: jwk.x }));
}

/** Canonical proof target: normalized origin and path, without query or fragment. */
export function canonicalAdRouterProofUrl(input: string): string {
	const url = new URL(input);
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unsupported AdRouter URL");
	return `${url.origin}${url.pathname || "/"}`;
}

function encodeJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createAdRouterDpopProof(input: {
	privateJwk: AdRouterPrivateJwk;
	method: string;
	url: string;
	body?: Uint8Array;
	clientVersion: string;
	accessToken?: string;
	nonce?: string;
	now?: number;
	jti?: string;
}): string {
	const privateJwk = validateAdRouterPrivateJwk(input.privateJwk);
	const publicJwk = publicJwkFromPrivate(privateJwk);
	const header = {
		typ: "dpop+jwt",
		alg: "EdDSA",
		jwk: { crv: publicJwk.crv, x: publicJwk.x, kty: publicJwk.kty },
	};
	const claims: AdRouterProofClaims = {
		jti: input.jti ?? randomUUID(),
		htm: input.method.toUpperCase(),
		htu: canonicalAdRouterProofUrl(input.url),
		iat: Math.floor((input.now ?? Date.now()) / 1000),
		...(input.accessToken ? { ath: base64UrlSha256(input.accessToken) } : {}),
		...(input.nonce ? { nonce: input.nonce } : {}),
		...(input.body ? { bht: base64UrlSha256(input.body) } : {}),
		client_kind: ADROUTER_CLIENT_KIND,
		client_version: input.clientVersion,
	};
	const encodedHeader = encodeJson(header);
	const encodedClaims = encodeJson(claims);
	const signingInput = `${encodedHeader}.${encodedClaims}`;
	const key = createPrivateKey({ key: privateJwk, format: "jwk" });
	const signature = sign(null, Buffer.from(signingInput, "ascii"), key).toString("base64url");
	return `${signingInput}.${signature}`;
}

export function verifyAdRouterDpopProofForTest(proof: string): boolean {
	const [encodedHeader, encodedClaims, encodedSignature, extra] = proof.split(".");
	if (!encodedHeader || !encodedClaims || !encodedSignature || extra) return false;
	try {
		const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as {
			alg?: unknown;
			jwk?: unknown;
		};
		if (header.alg !== "EdDSA" || !header.jwk || typeof header.jwk !== "object") return false;
		const jwk = header.jwk as Record<string, unknown>;
		if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || "d" in jwk) return false;
		const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
		return verify(
			null,
			Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"),
			key,
			Buffer.from(encodedSignature, "base64url"),
		);
	} catch {
		return false;
	}
}
