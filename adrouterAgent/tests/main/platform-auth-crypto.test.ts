import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalRequestUrl,
  contentDigest,
  createDpopProof,
  generateInstallationKeyPair,
  jwkThumbprint,
  sha256Base64Url,
  validatePublicJwk,
} from '@/main/platform-auth-crypto';

const fixtureBytes = readFileSync('tests/fixtures/platform-auth-v1.json');
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as {
  fixture_version: string;
  public_jwk: { kty: 'OKP'; crv: 'Ed25519'; x: string };
  jwk_thumbprint: string;
  non_secret_test_access_token: string;
  access_token_sha256_base64url: string;
  method: 'POST';
  normalized_htu: string;
  raw_body_utf8: string;
  content_digest: string;
  bht: string;
  claims: Record<string, unknown>;
  proof_jwt: string;
  negative_vectors: Array<{ name: string; expected_code: string }>;
};

describe('platform authentication crypto', () => {
  it('creates a verifiable Ed25519 proof bound to exact bytes, token, nonce, and client identity', () => {
    const keyPair = generateInstallationKeyPair();
    const body = Buffer.from('{"value":"exact"}', 'utf8');
    const proof = createDpopProof({
      privateJwk: keyPair.privateJwk,
      publicJwk: keyPair.publicJwk,
      method: 'POST',
      url: 'https://api-staging.adrouter.co/v1/agent/turn?ignored=true#ignored',
      body,
      clientVersion: '0.1.0-beta.12',
      accessToken: 'fixture-access-token',
      nonce: 'fixture-nonce',
      now: 1_800_000_000_000,
      jti: '11111111-1111-4111-8111-111111111111',
    });
    const [encodedHeader, encodedPayload, encodedSignature] = proof.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error('Invalid proof.');
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));

    expect(header).toEqual({ typ: 'dpop+jwt', alg: 'EdDSA', jwk: keyPair.publicJwk });
    expect(payload).toMatchObject({
      htm: 'POST',
      htu: 'https://api-staging.adrouter.co/v1/agent/turn',
      iat: 1_800_000_000,
      nonce: 'fixture-nonce',
      ath: sha256Base64Url('fixture-access-token'),
      bht: sha256Base64Url(body),
      client_kind: 'desktop',
      client_version: '0.1.0-beta.12',
    });
    expect(
      verify(
        null,
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        createPublicKey({ key: keyPair.publicJwk, format: 'jwk' }),
        Buffer.from(encodedSignature, 'base64url')
      )
    ).toBe(true);
    expect(contentDigest(body)).toMatch(/^sha-256=:[A-Za-z0-9+/]{43}=:/);
    expect(jwkThumbprint(keyPair.publicJwk)).toBe(keyPair.thumbprint);
  });

  it('rejects private or noncanonical public JWK input and unsafe canonical URLs', () => {
    const keyPair = generateInstallationKeyPair();
    expect(() => validatePublicJwk(keyPair.privateJwk)).toThrow(/minimal public Ed25519/);
    expect(() => validatePublicJwk({ ...keyPair.publicJwk, x: `${keyPair.publicJwk.x}=` })).toThrow(
      /malformed|canonical/
    );
    expect(() => canonicalRequestUrl('http://api-staging.adrouter.co/v1/profile')).toThrow(/HTTPS/);
  });

  it('matches the canonical Router and CLI platform-auth-v1 fixture byte for byte', () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(
      '93a8ec8d4eba38f9165179aa0cdfe3316f8134a882bd0426bd83339af55d17f8'
    );
    expect(fixture.fixture_version).toBe('platform-auth-v1');
    expect(validatePublicJwk(fixture.public_jwk)).toEqual(fixture.public_jwk);
    expect(jwkThumbprint(fixture.public_jwk)).toBe(fixture.jwk_thumbprint);
    expect(sha256Base64Url(fixture.non_secret_test_access_token)).toBe(
      fixture.access_token_sha256_base64url
    );
    const body = Buffer.from(fixture.raw_body_utf8, 'utf8');
    expect(contentDigest(body)).toBe(fixture.content_digest);
    expect(sha256Base64Url(body)).toBe(fixture.bht);
    expect(canonicalRequestUrl(fixture.normalized_htu)).toBe(fixture.normalized_htu);

    const [encodedHeader, encodedPayload, encodedSignature] = fixture.proof_jwt.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      throw new Error('The canonical proof is malformed.');
    }
    expect(JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))).toEqual(
      fixture.claims
    );
    expect(
      verify(
        null,
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        createPublicKey({ key: fixture.public_jwk, format: 'jwk' }),
        Buffer.from(encodedSignature, 'base64url')
      )
    ).toBe(true);
    expect(
      fixture.negative_vectors.map(({ name, expected_code }) => ({ name, expected_code }))
    ).toEqual([
      { name: 'private_jwk_submitted', expected_code: 'invalid_request' },
      { name: 'wrong_method', expected_code: 'invalid_dpop_proof' },
      { name: 'wrong_url', expected_code: 'invalid_dpop_proof' },
      { name: 'wrong_access_hash', expected_code: 'invalid_dpop_proof' },
      { name: 'tampered_body', expected_code: 'invalid_dpop_proof' },
      { name: 'wrong_nonce', expected_code: 'use_dpop_nonce' },
      { name: 'replayed_jti', expected_code: 'invalid_dpop_proof' },
      { name: 'wrong_client_kind', expected_code: 'invalid_dpop_proof' },
      { name: 'malformed_version', expected_code: 'invalid_dpop_proof' },
      { name: 'future_iat', expected_code: 'invalid_dpop_proof' },
    ]);
  });

  it('omits body binding entirely for bodyless proofs', () => {
    const keyPair = generateInstallationKeyPair();
    const proof = createDpopProof({
      privateJwk: keyPair.privateJwk,
      method: 'GET',
      url: 'https://api-staging.adrouter.co/v1/profile',
      clientVersion: '0.1.0-beta.12',
      accessToken: 'fixture-access-token',
    });
    const encodedPayload = proof.split('.')[1];
    if (!encodedPayload) throw new Error('The bodyless proof is malformed.');
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty('bht');
  });
});
