import { describe, expect, it } from 'vitest';
import { parseInstallationRecord, parsePendingEnrollmentRecord } from '@/main/installation-records';
import { generateInstallationKeyPair } from '@/main/platform-auth-crypto';

const keyPair = generateInstallationKeyPair();

describe('installation records', () => {
  it('rejects a persisted installation whose origin or key thumbprint changed', () => {
    const record = {
      version: 1,
      privateJwk: keyPair.privateJwk,
      refreshToken: 'refresh-fixture',
      installationId: 'installation-fixture',
      scopes: ['agent:turn', 'profile:read'],
      origin: 'https://api-staging.adrouter.co',
      clientKind: 'desktop',
      clientVersion: '0.1.0-beta.12',
      familyExpiresAt: '2030-01-01T00:00:00.000Z',
      displayName: 'AdRouter Agent',
      keyThumbprint: keyPair.thumbprint,
      storageClassification: 'os_encrypted',
    };

    expect(() => parseInstallationRecord(record)).not.toThrow();
    expect(() =>
      parseInstallationRecord({ ...record, origin: 'https://attacker.example' })
    ).toThrow(/official AdRouter origin/);
    expect(() => parseInstallationRecord({ ...record, keyThumbprint: 'changed' })).toThrow(
      /thumbprint is inconsistent/
    );
  });

  it('rejects persisted approval links outside the official WebUI origins', () => {
    const pending = {
      version: 1,
      privateJwk: keyPair.privateJwk,
      deviceCode: 'device-fixture',
      installationId: 'installation-fixture',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://app-staging.adrouter.co/connect',
      verificationUriComplete: 'https://app-staging.adrouter.co/connect?code=ABCD-EFGH',
      intervalSeconds: 5,
      expiresAt: '2030-01-01T00:00:00.000Z',
      nextPollAt: '2029-12-31T23:59:00.000Z',
      origin: 'https://api-staging.adrouter.co',
      clientVersion: '0.1.0-beta.12',
      displayName: 'AdRouter Agent',
      sponsoredCompute: true,
      scopes: ['agent:turn', 'profile:read'],
    };

    expect(() => parsePendingEnrollmentRecord(pending)).not.toThrow();
    expect(() =>
      parsePendingEnrollmentRecord({
        ...pending,
        verificationUriComplete: 'https://attacker.example/connect?code=ABCD-EFGH',
      })
    ).toThrow(/official approval URL/);
  });
});
