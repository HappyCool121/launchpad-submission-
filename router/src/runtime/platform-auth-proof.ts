import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from 'jose';
import type { Request } from 'express';
import { getRuntimeConfig } from './config.js';
import { rawBodyDigest } from './raw-body.js';
import {
  canonicalHtu,
  compareSemVer,
  constantTimeEqual,
  contentDigestValue,
  jwkThumbprint,
  parseContentDigest,
  parseSemVer,
  PlatformAuthError,
  sha256Base64Url,
  validatePublicEd25519Jwk,
  type ClientKind,
  type PublicEd25519Jwk,
} from './platform-auth.js';
import { consumeNonceAndClaimReplay, nonceChallenge, type NoncePurpose } from './platform-auth-store.js';

export interface VerifiedProof {
  jti: string;
  clientKind: ClientKind;
  clientVersion: string;
  keyThumbprint: string;
  issuedAt: number;
}

function claimString(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' ? value : undefined;
}

export async function verifyPlatformProof(input: {
  request: Request;
  publicKey: PublicEd25519Jwk;
  keyThumbprint: string;
  purpose: NoncePurpose;
  nonceContext: Buffer;
  expectedClientKind: ClientKind;
  accessToken?: string;
  bodyRequired: boolean;
  challengeWhenMissingProof?: boolean;
}): Promise<VerifiedProof> {
  const compact = input.request.header('dpop');
  if (!compact) {
    if (input.challengeWhenMissingProof) return nonceChallenge(input.purpose, input.keyThumbprint, input.nonceContext);
    throw new PlatformAuthError('invalid_dpop_proof', 401, 'A DPoP proof is required.');
  }

  try {
    const protectedHeader = decodeProtectedHeader(compact);
    if (protectedHeader.typ !== 'dpop+jwt' || protectedHeader.alg !== 'EdDSA') {
      throw new PlatformAuthError('invalid_dpop_proof', 401, 'The DPoP protected header is invalid.');
    }
    const headerKey = validatePublicEd25519Jwk(protectedHeader.jwk);
    const headerThumbprint = jwkThumbprint(headerKey);
    if (!constantTimeEqual(headerThumbprint, input.keyThumbprint) || !constantTimeEqual(headerKey.x, input.publicKey.x)) {
      throw new PlatformAuthError('invalid_dpop_proof', 401, 'The DPoP proof key does not match the installation.');
    }
    const verificationKey = await importJWK(headerKey, 'EdDSA');
    const { payload } = await jwtVerify(compact, verificationKey, { algorithms: ['EdDSA'], typ: 'dpop+jwt' });
    const jti = claimString(payload, 'jti');
    const htm = claimString(payload, 'htm');
    const htu = claimString(payload, 'htu');
    const nonce = claimString(payload, 'nonce');
    const clientKind = claimString(payload, 'client_kind');
    const clientVersion = claimString(payload, 'client_version');
    const issuedAt = payload.iat;
    if (!jti || !/^[A-Za-z0-9_-]{22,200}$/.test(jti)
      || htm !== input.request.method.toUpperCase()
      || htu !== canonicalHtu(input.request)
      || typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt)
      || Math.abs(Math.floor(Date.now() / 1000) - issuedAt) > getRuntimeConfig().platformAuthProofSkewSeconds
      || clientKind !== input.expectedClientKind
      || !clientVersion || !parseSemVer(clientVersion)) {
      throw new PlatformAuthError('invalid_dpop_proof', 401, 'The DPoP proof claims are invalid.');
    }

    const ath = claimString(payload, 'ath');
    if (input.accessToken) {
      if (!ath || !constantTimeEqual(ath, sha256Base64Url(input.accessToken))) {
        throw new PlatformAuthError('invalid_dpop_proof', 401, 'The DPoP token binding is invalid.');
      }
    } else if (ath !== undefined) {
      throw new PlatformAuthError('invalid_dpop_proof', 401, 'The DPoP proof contains an unexpected access-token binding.');
    }

    const bodyDigest = rawBodyDigest(input.request);
    const headerDigest = parseContentDigest(input.request.header('content-digest'));
    const bht = claimString(payload, 'bht');
    if (input.bodyRequired) {
      if (!bodyDigest || !headerDigest || !constantTimeEqual(bodyDigest, headerDigest)
        || !bht || !constantTimeEqual(bht, bodyDigest.toString('base64url'))
        || input.request.header('content-digest') !== contentDigestValue(bodyDigest)) {
        throw new PlatformAuthError('invalid_dpop_proof', 401, 'The DPoP body binding is invalid.');
      }
    } else if (input.request.header('content-digest') !== undefined || bht !== undefined) {
      throw new PlatformAuthError('invalid_dpop_proof', 401, 'Body bindings are not accepted for this request.');
    }

    if (!nonce) return nonceChallenge(input.purpose, input.keyThumbprint, input.nonceContext);
    await consumeNonceAndClaimReplay({ nonce, purpose: input.purpose, keyThumbprint: input.keyThumbprint, contextDigest: input.nonceContext, jti });
    return { jti, clientKind: input.expectedClientKind, clientVersion, keyThumbprint: input.keyThumbprint, issuedAt };
  } catch (error) {
    if (error instanceof PlatformAuthError) throw error;
    throw new PlatformAuthError('invalid_dpop_proof', 401, 'The DPoP proof is invalid.');
  }
}

export function enforceClientVersion(input: {
  signedVersion: string;
  minimumVersion: string;
  mode: 'observe' | 'warn' | 'enforce';
  enabled: boolean;
  updateUrl?: string | null;
}): { belowMinimum: boolean; warning: boolean } {
  if (!input.enabled) throw new PlatformAuthError('client_not_allowed', 403, 'This client kind is disabled.');
  const comparison = compareSemVer(input.signedVersion, input.minimumVersion);
  if (comparison === undefined) throw new PlatformAuthError('invalid_dpop_proof', 401, 'The signed client version is malformed.');
  const belowMinimum = comparison < 0;
  if (belowMinimum && input.mode === 'enforce') {
    throw new PlatformAuthError('client_upgrade_required', 426, 'This client version must be upgraded.', undefined, {
      'AdRouter-Minimum-Version': input.minimumVersion,
      ...(input.updateUrl ? { Link: `<${input.updateUrl}>; rel="latest-version"` } : {}),
    });
  }
  return { belowMinimum, warning: belowMinimum && input.mode === 'warn' };
}
