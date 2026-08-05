import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

export type TestClientKind = 'cli' | 'desktop' | 'opencode';
export type TestInstallationKey = { privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']; publicJwk: JWK };

export async function createTestInstallationKey(): Promise<TestInstallationKey> {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  return { privateKey: pair.privateKey, publicJwk: await exportJWK(pair.publicKey) };
}

function digest(value: string): Buffer { return createHash('sha256').update(value).digest(); }

export async function buildProof(input: {
  url: string;
  method: string;
  body?: string;
  accessToken?: string;
  nonce?: string;
  key: TestInstallationKey;
  clientKind?: TestClientKind;
  clientVersion?: string;
  jti?: string;
}): Promise<string> {
  const claims: Record<string, string | number> = {
    jti: input.jti ?? randomBytes(16).toString('base64url'),
    htm: input.method.toUpperCase(),
    htu: new URL(input.url).origin + new URL(input.url).pathname,
    iat: Math.floor(Date.now() / 1000),
    client_kind: input.clientKind ?? 'cli',
    client_version: input.clientVersion ?? '0.82.0',
  };
  if (input.nonce) claims.nonce = input.nonce;
  if (input.accessToken) claims.ath = digest(input.accessToken).toString('base64url');
  if (input.body !== undefined) claims.bht = digest(input.body).toString('base64url');
  return new SignJWT(claims).setProtectedHeader({ typ: 'dpop+jwt', alg: 'EdDSA', jwk: input.key.publicJwk }).sign(input.key.privateKey);
}

export async function signedFetch(input: {
  url: string;
  method?: string;
  body?: string;
  accessToken?: string;
  nonce?: string;
  key: TestInstallationKey;
  clientKind?: TestClientKind;
  clientVersion?: string;
  jti?: string;
  proofBody?: string;
  headers?: Record<string, string>;
}): Promise<{ response: Response; proof: string }> {
  const method = input.method ?? 'GET';
  const proof = await buildProof({ ...input, method, body: input.proofBody ?? input.body });
  const headers = new Headers(input.headers);
  headers.set('dpop', proof);
  if (input.accessToken) headers.set('authorization', `DPoP ${input.accessToken}`);
  if (input.body !== undefined) {
    headers.set('content-type', 'application/json');
    headers.set('content-digest', `sha-256=:${digest(input.body).toString('base64')}:`);
  }
  return { response: await fetch(input.url, { method, headers, body: input.body }), proof };
}

export async function nonceRetry(input: Parameters<typeof signedFetch>[0]): Promise<{ response: Response; proof: string }> {
  const challenged = await signedFetch(input);
  if (challenged.response.status !== 401 || !challenged.response.headers.get('dpop-nonce')) return challenged;
  return signedFetch({ ...input, nonce: challenged.response.headers.get('dpop-nonce')! });
}
