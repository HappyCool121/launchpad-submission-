import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { getRuntimeConfig } from './config.js';

export const CLIENT_KINDS = ['cli', 'desktop', 'opencode'] as const;
export type ClientKind = typeof CLIENT_KINDS[number];
export const ACTIVE_CLIENT_KINDS = ['cli', 'desktop'] as const;
export type ActiveClientKind = typeof ACTIVE_CLIENT_KINDS[number];
export const MACHINE_SCOPES = ['agent:turn', 'profile:read'] as const;
export type MachineScope = typeof MACHINE_SCOPES[number];
export const STORAGE_CLASSES = ['hardware_backed', 'os_encrypted', 'user_encrypted', 'file_protected', 'unavailable'] as const;
export type StorageClass = typeof STORAGE_CLASSES[number];

export interface PublicEd25519Jwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
}

export class PlatformAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly nonce?: string,
    public readonly headers: Record<string, string> = {},
  ) { super(message); }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validatePublicEd25519Jwk(value: unknown): PublicEd25519Jwk {
  if (!plainRecord(value)) throw new PlatformAuthError('invalid_request', 400, 'A public Ed25519 JWK is required.');
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'crv' || keys[1] !== 'kty' || keys[2] !== 'x'
    || value.kty !== 'OKP' || value.crv !== 'Ed25519' || typeof value.x !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(value.x)) {
    throw new PlatformAuthError('invalid_request', 400, 'The public key must be a canonical public Ed25519 JWK.');
  }
  const decoded = Buffer.from(value.x, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== value.x) {
    throw new PlatformAuthError('invalid_request', 400, 'The public key encoding is invalid.');
  }
  return { kty: 'OKP', crv: 'Ed25519', x: value.x };
}

export function jwkThumbprint(jwk: PublicEd25519Jwk): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash('sha256').update(canonical).digest('base64url');
}

export function sha256(value: string | Buffer): Buffer { return createHash('sha256').update(value).digest(); }
export function sha256Base64Url(value: string | Buffer): string { return sha256(value).toString('base64url'); }
export function contentDigestValue(digest: Buffer): string { return `sha-256=:${digest.toString('base64')}:`; }

export function parseContentDigest(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const match = /^sha-256=:([A-Za-z0-9+/]{43}=):$/.exec(value.trim());
  if (!match) return undefined;
  const digest = Buffer.from(match[1], 'base64');
  return digest.length === 32 ? digest : undefined;
}

export function digestSecret(domain: string, value: string | Buffer): Buffer {
  return createHmac('sha256', getRuntimeConfig().apiKeyHmacPepper!).update(`platform-auth-v1:${domain}\0`).update(value).digest();
}

export function constantTimeEqual(left: string | Buffer, right: string | Buffer): boolean {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function opaqueSecret(prefix: 'adr_at_' | 'adr_rt_' | 'adr_dc_' | 'adr_nonce_'): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

const USER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function createUserCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (let index = 0; index < 8; index += 1) code += USER_CODE_ALPHABET[bytes[index] % USER_CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const BROWSER_HANDOFF_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isBrowserHandoffId(value: string): boolean {
  return BROWSER_HANDOFF_ID.test(value);
}

export function userCodeFromBrowserHandoffId(value: string): string {
  if (!isBrowserHandoffId(value)) throw new Error('A UUIDv4 browser handoff identifier is required.');
  const bytes = Buffer.from(value.replaceAll('-', ''), 'hex');
  let code = '';
  for (let index = 0; index < 8; index += 1) code += USER_CODE_ALPHABET[bytes[index] % USER_CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizeUserCode(value: string): string | undefined {
  const normalized = value.trim().toUpperCase().replace(/[-\s]/g, '');
  return /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/.test(normalized) ? normalized : undefined;
}

export function canonicalHtu(req: Request): string {
  const path = req.originalUrl.split(/[?#]/, 1)[0] || '/';
  return `${getRuntimeConfig().apiOrigin}${path.startsWith('/') ? path : `/${path}`}`;
}

type ParsedSemVer = { major: number; minor: number; patch: number; prerelease: (number | string)[] };
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemVer(value: string): ParsedSemVer | undefined {
  const match = SEMVER.exec(value);
  if (!match) return undefined;
  const prerelease = match[4]?.split('.').map((part) => {
    if (/^\d+$/.test(part)) {
      if (part.length > 1 && part.startsWith('0')) return Number.NaN;
      return Number(part);
    }
    return part;
  }) ?? [];
  if (prerelease.some((part) => typeof part === 'number' && !Number.isSafeInteger(part))) return undefined;
  const values = [match[1], match[2], match[3]].map(Number);
  if (values.some((part) => !Number.isSafeInteger(part))) return undefined;
  return { major: values[0], minor: values[1], patch: values[2], prerelease };
}

export function compareSemVer(left: string, right: string): number | undefined {
  const a = parseSemVer(left); const b = parseSemVer(right);
  if (!a || !b) return undefined;
  for (const key of ['major', 'minor', 'patch'] as const) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index]; const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'string') return -1;
    if (typeof x === 'string' && typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function requestIpPseudonym(req: Request): Buffer {
  return digestSecret('ip', req.socket.remoteAddress ?? 'unknown');
}

export function sendPlatformAuthError(error: unknown, response: {
  setHeader(name: string, value: string): void;
  status(code: number): { json(value: unknown): unknown };
}): void {
  const rejection = error instanceof PlatformAuthError
    ? error : new PlatformAuthError('invalid_request', 400, 'The authentication request is invalid.');
  response.setHeader('Cache-Control', 'no-store');
  if (rejection.nonce) response.setHeader('DPoP-Nonce', rejection.nonce);
  for (const [name, value] of Object.entries(rejection.headers)) response.setHeader(name, value);
  response.status(rejection.status).json({ error: rejection.message, code: rejection.code });
}
