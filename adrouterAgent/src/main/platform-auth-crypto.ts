import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign as signBytes,
} from 'node:crypto';
import { DESKTOP_CLIENT_KIND } from '../shared/constants';

export interface Ed25519PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
}

export interface Ed25519PrivateJwk extends Ed25519PublicJwk {
  d: string;
}

export interface InstallationKeyPair {
  publicJwk: Ed25519PublicJwk;
  privateJwk: Ed25519PrivateJwk;
  thumbprint: string;
}

export interface ProofInput {
  privateJwk: Ed25519PrivateJwk;
  publicJwk?: Ed25519PublicJwk;
  method: 'GET' | 'POST';
  url: string;
  body?: Uint8Array;
  clientVersion: string;
  accessToken?: string;
  nonce?: string;
  now?: number;
  jti?: string;
}

const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

export const base64Url = (value: string | Uint8Array): string =>
  Buffer.from(value).toString('base64url');

export const sha256Bytes = (value: string | Uint8Array): Buffer =>
  createHash('sha256').update(value).digest();

export const sha256Base64Url = (value: string | Uint8Array): string =>
  sha256Bytes(value).toString('base64url');

export const contentDigest = (body: Uint8Array): string =>
  `sha-256=:${sha256Bytes(body).toString('base64')}:`;

const assertEncodedCoordinate = (name: string, value: unknown): string => {
  if (typeof value !== 'string' || !base64UrlPattern.test(value)) {
    throw new Error(`The installation ${name} is malformed.`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) {
    throw new Error(`The installation ${name} is not a canonical Ed25519 value.`);
  }
  return value;
};

export const validatePublicJwk = (value: unknown): Ed25519PublicJwk => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The installation public key is malformed.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'crv,kty,x' || record.kty !== 'OKP' || record.crv !== 'Ed25519') {
    throw new Error('Only a minimal public Ed25519 JWK is accepted.');
  }
  return { kty: 'OKP', crv: 'Ed25519', x: assertEncodedCoordinate('x', record.x) };
};

export const validatePrivateJwk = (value: unknown): Ed25519PrivateJwk => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The installation private key is malformed.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'crv,d,kty,x' || record.kty !== 'OKP' || record.crv !== 'Ed25519') {
    throw new Error('Only a minimal private Ed25519 JWK is accepted.');
  }
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: assertEncodedCoordinate('x', record.x),
    d: assertEncodedCoordinate('d', record.d),
  };
};

export const publicJwkFromPrivate = (privateJwk: Ed25519PrivateJwk): Ed25519PublicJwk => ({
  kty: 'OKP',
  crv: 'Ed25519',
  x: privateJwk.x,
});

export const jwkThumbprint = (publicJwk: Ed25519PublicJwk): string =>
  sha256Base64Url(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x }));

export const generateInstallationKeyPair = (): InstallationKeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicJwk = validatePublicJwk(publicKey.export({ format: 'jwk' }));
  const privateJwk = validatePrivateJwk(privateKey.export({ format: 'jwk' }));
  return { publicJwk, privateJwk, thumbprint: jwkThumbprint(publicJwk) };
};

export const canonicalRequestUrl = (value: string): string => {
  const url = new URL(value);
  if (url.username || url.password || url.protocol !== 'https:') {
    throw new Error('Signed AdRouter requests require a credential-free HTTPS URL.');
  }
  url.search = '';
  url.hash = '';
  return `${url.origin}${url.pathname || '/'}`;
};

export const createDpopProof = (input: ProofInput): string => {
  const privateJwk = validatePrivateJwk(input.privateJwk);
  const publicJwk = input.publicJwk
    ? validatePublicJwk(input.publicJwk)
    : publicJwkFromPrivate(privateJwk);
  if (privateJwk.x !== publicJwk.x) {
    throw new Error('The installation public and private keys do not match.');
  }
  const header = {
    typ: 'dpop+jwt',
    alg: 'EdDSA',
    jwk: publicJwk,
  };
  const payload = {
    jti: input.jti ?? randomUUID(),
    htm: input.method,
    htu: canonicalRequestUrl(input.url),
    iat: Math.floor((input.now ?? Date.now()) / 1000),
    ...(input.nonce ? { nonce: input.nonce } : {}),
    ...(input.accessToken ? { ath: sha256Base64Url(input.accessToken) } : {}),
    ...(input.body ? { bht: sha256Base64Url(input.body) } : {}),
    client_kind: DESKTOP_CLIENT_KIND,
    client_version: input.clientVersion,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
  const signature = signBytes(null, Buffer.from(signingInput), key);
  return `${signingInput}.${signature.toString('base64url')}`;
};

export const exactJsonBytes = (value: unknown): Uint8Array =>
  Buffer.from(JSON.stringify(value), 'utf8');
