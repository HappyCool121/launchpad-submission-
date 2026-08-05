import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { importJWK, jwtVerify } from 'jose';
import {
  compareSemVer,
  contentDigestValue,
  jwkThumbprint,
  isBrowserHandoffId,
  normalizeUserCode,
  parseContentDigest,
  parseSemVer,
  sha256,
  sha256Base64Url,
  userCodeFromBrowserHandoffId,
  validatePublicEd25519Jwk,
} from '../src/runtime/platform-auth.js';
import { ACTIVE_CLIENT_KINDS } from '../src/runtime/platform-auth.js';
import { enforceClientVersion } from '../src/runtime/platform-auth-proof.js';
import { fixedWindowRetryAfterSeconds } from '../src/runtime/platform-auth-store.js';

const fixtureUrl = new URL('../test/fixtures/platform-auth-v1.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8')) as {
  public_jwk: { kty: 'OKP'; crv: 'Ed25519'; x: string };
  test_private_jwk: Record<string, string>;
  jwk_thumbprint: string;
  non_secret_test_access_token: string;
  access_token_sha256_base64url: string;
  raw_body_utf8: string;
  content_digest: string;
  bht: string;
  proof_jwt: string;
  claims: Record<string, unknown>;
  negative_vectors: { name: string; expected_code: string }[];
};

const key = validatePublicEd25519Jwk(fixture.public_jwk);
assert.equal(jwkThumbprint(key), fixture.jwk_thumbprint);
assert.equal(sha256Base64Url(fixture.non_secret_test_access_token), fixture.access_token_sha256_base64url);
const bodyDigest = sha256(fixture.raw_body_utf8);
assert.equal(bodyDigest.toString('base64url'), fixture.bht);
assert.equal(contentDigestValue(bodyDigest), fixture.content_digest);
assert.deepEqual(parseContentDigest(fixture.content_digest), bodyDigest);
assert.throws(() => validatePublicEd25519Jwk(fixture.test_private_jwk), /canonical public Ed25519 JWK/);

const verificationKey = await importJWK(key, 'EdDSA');
const verified = await jwtVerify(fixture.proof_jwt, verificationKey, { algorithms: ['EdDSA'], typ: 'dpop+jwt' });
assert.deepEqual(verified.payload, fixture.claims);
assert.equal(fixture.negative_vectors.length, 10);
assert(fixture.negative_vectors.every((vector) => ['invalid_request', 'invalid_dpop_proof', 'use_dpop_nonce'].includes(vector.expected_code)));

assert(parseSemVer('0.82.0'));
assert(parseSemVer('1.0.0-beta.2+build.4'));
assert.equal(parseSemVer('01.0.0'), undefined);
assert.equal(parseSemVer('1.0'), undefined);
assert.equal(compareSemVer('1.0.0-beta.2', '1.0.0-beta.10'), -1);
assert.equal(compareSemVer('1.0.0', '1.0.0-beta.10'), 1);
assert.equal(normalizeUserCode('m7kd-pq92'), 'M7KDPQ92');
assert.equal(normalizeUserCode('O000-0000'), undefined);
assert.equal(isBrowserHandoffId('46be2c5c-f9ea-4d55-b5b0-3f51c3de5739'), true);
assert.equal(isBrowserHandoffId('46be2c5c-f9ea-3d55-b5b0-3f51c3de5739'), false);
assert.equal(userCodeFromBrowserHandoffId('46be2c5c-f9ea-4d55-b5b0-3f51c3de5739'), 'A6FZ-3KHS');
assert.equal(normalizeUserCode(userCodeFromBrowserHandoffId('46be2c5c-f9ea-4d55-b5b0-3f51c3de5739')), 'A6FZ3KHS');
assert.equal(fixedWindowRetryAfterSeconds(60, 0), 60);
assert.equal(fixedWindowRetryAfterSeconds(60, 59_999), 1);
assert.equal(fixedWindowRetryAfterSeconds(60, 60_000), 60);
assert.deepEqual(enforceClientVersion({ signedVersion: '0.82.0', minimumVersion: '0.82.0', mode: 'enforce', enabled: true }), { belowMinimum: false, warning: false });
assert.deepEqual(enforceClientVersion({ signedVersion: '0.81.0', minimumVersion: '0.82.0', mode: 'warn', enabled: true }), { belowMinimum: true, warning: true });
assert.throws(
  () => enforceClientVersion({ signedVersion: '0.81.0', minimumVersion: '0.82.0', mode: 'enforce', enabled: true }),
  (error: unknown) => error instanceof Error && 'code' in error && error.code === 'client_upgrade_required',
);
assert.throws(
  () => enforceClientVersion({ signedVersion: '0.82.0', minimumVersion: '0.82.0', mode: 'observe', enabled: false }),
  (error: unknown) => error instanceof Error && 'code' in error && error.code === 'client_not_allowed',
);
assert.deepEqual(ACTIVE_CLIENT_KINDS, ['cli', 'desktop']);
assert(!ACTIVE_CLIENT_KINDS.includes('opencode' as never));

console.log('OK: platform-auth-v1 key, digest, JWT, active client kinds, SemVer, and negative-vector contract is canonical.');
