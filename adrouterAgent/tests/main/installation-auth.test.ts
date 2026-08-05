import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationStore, type CredentialCipher } from '@/main/configuration-store';
import { InstallationAuthManager } from '@/main/installation-auth';
import type { InstallationRecord, PendingEnrollmentRecord } from '@/main/installation-records';
import { generateInstallationKeyPair } from '@/main/platform-auth-crypto';
import { bundledCatalogModels, bundledCatalogStatus } from '@/shared/model-catalog';

const directories: string[] = [];
const accessToken = `adr_at_${'A'.repeat(43)}`;
const refreshToken = `adr_rt_${'B'.repeat(43)}`;
const rotatedRefreshToken = `adr_rt_${'C'.repeat(43)}`;
const deviceCode = `adr_dc_${'D'.repeat(43)}`;
const installationId = '11111111-1111-4111-8111-111111111111';
const cipher: CredentialCipher = {
  assertSecure: async () => undefined,
  encrypt: async (value) => Buffer.from(`encrypted:${value}`).toString('base64'),
  decrypt: async (value) => ({
    value: Buffer.from(value, 'base64')
      .toString('utf8')
      .replace(/^encrypted:/, ''),
    shouldReEncrypt: false,
  }),
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const createStore = async (): Promise<{ store: ConfigurationStore; path: string }> => {
  const directory = await mkdtemp(join(tmpdir(), 'adrouter-installation-auth-'));
  directories.push(directory);
  const path = join(directory, 'configuration.json');
  return { store: new ConfigurationStore(path, cipher), path };
};

const createRecord = (): InstallationRecord => {
  const keyPair = generateInstallationKeyPair();
  return {
    version: 1,
    privateJwk: keyPair.privateJwk,
    refreshToken,
    installationId,
    scopes: ['agent:turn', 'profile:read'],
    origin: 'https://api-staging.adrouter.co',
    clientKind: 'desktop',
    clientVersion: '0.1.0-beta.12',
    familyExpiresAt: '2030-01-01T00:00:00.000Z',
    displayName: 'AdRouter Agent',
    keyThumbprint: keyPair.thumbprint,
    storageClassification: 'os_encrypted',
  };
};

describe('InstallationAuthManager', () => {
  it('signs in before the nonce challenge and exposes no handoff, device, or key secret to the renderer DTO', async () => {
    const { store, path } = await createStore();
    const requests: RequestInit[] = [];
    const fetchFn: typeof fetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      requests.push(init ?? {});
      if (requests.length === 1) {
        return new Response('', { status: 401, headers: { 'DPoP-Nonce': 'enroll-nonce' } });
      }
      return new Response(
        JSON.stringify({
          device_code: deviceCode,
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://app-staging.adrouter.co/connect',
          verification_uri_complete: 'https://app-staging.adrouter.co/connect?code=ABCD-EFGH',
          expires_in: 600,
          interval: 5,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const manager = new InstallationAuthManager(store, '0.1.0-beta.12', { fetchFn });

    const prepared = await manager.startEnrollment({
      serverUrl: 'https://api-staging.adrouter.co',
      sponsoredCompute: true,
      displayName: 'AdRouter Agent',
    });

    expect(prepared).toMatchObject({ state: 'awaiting_sign_in', userCode: null });
    expect(fetchFn).not.toHaveBeenCalled();
    const signInUrl = await manager.enrollmentUrl();
    expect(signInUrl).toMatch(
      /^https:\/\/app-staging\.adrouter\.co\/developers\?connect=agent#handoff=[0-9a-f-]{36}$/
    );
    expect(JSON.stringify(prepared)).not.toContain('handoff');

    const status = await manager.continueEnrollment();

    expect(status).toMatchObject({ state: 'pending', userCode: 'ABCD-EFGH' });
    expect(JSON.stringify(status)).not.toContain(deviceCode);
    expect(requests[0]?.headers).not.toMatchObject({ DPoP: expect.any(String) });
    expect(requests[1]?.headers).toMatchObject({ DPoP: expect.any(String) });
    const body = JSON.parse(String(requests[0]?.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        'client_kind',
        'client_version',
        'display_name',
        'browser_handoff_id',
        'public_key_jwk',
        'requested_scopes',
        'storage_class',
      ].sort()
    );
    expect(body).toMatchObject({
      client_kind: 'desktop',
      requested_scopes: ['agent:turn', 'profile:read'],
      storage_class: 'os_encrypted',
      browser_handoff_id: signInUrl.split('#handoff=')[1],
    });
    expect(body.public_key_jwk).not.toHaveProperty('d');
    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain(deviceCode);
    expect(persisted).not.toContain('ABCD-EFGH');
    await expect(
      new ConfigurationStore(path, cipher).getPendingEnrollment()
    ).resolves.toMatchObject({
      deviceCode,
      userCode: 'ABCD-EFGH',
    });
    await manager.cancelEnrollment();
  });

  it('fails before key generation or network access when OS credential storage is unsafe', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adrouter-installation-auth-'));
    directories.push(directory);
    const unsafeCipher: CredentialCipher = {
      ...cipher,
      assertSecure: async () => {
        throw new Error('unsafe credential storage');
      },
    };
    const fetchFn = vi.fn<typeof fetch>();
    const manager = new InstallationAuthManager(
      new ConfigurationStore(join(directory, 'configuration.json'), unsafeCipher),
      '0.1.0-beta.12',
      { fetchFn }
    );

    await expect(
      manager.startEnrollment({
        serverUrl: 'https://api-staging.adrouter.co',
        sponsoredCompute: true,
        displayName: 'AdRouter Agent',
      })
    ).rejects.toThrow(/unsafe credential storage/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('preserves an existing installation until replacement and signs cancellation with the pending key', async () => {
    const { store } = await createStore();
    const existing = createRecord();
    await store.completeEnrollment(
      existing,
      bundledCatalogModels(),
      bundledCatalogStatus(),
      '2026-07-27T00:00:00.000Z'
    );
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn: typeof fetch = vi.fn(async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      if (requests.length === 1) {
        return new Response('', { status: 401, headers: { 'DPoP-Nonce': 'enroll-nonce' } });
      }
      if (requests.length === 2) {
        return new Response(
          JSON.stringify({
            device_code: deviceCode,
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://app-staging.adrouter.co/connect',
            verification_uri_complete: 'https://app-staging.adrouter.co/connect?code=ABCD-EFGH',
            expires_in: 600,
            interval: 5,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(null, { status: 204 });
    });
    const manager = new InstallationAuthManager(store, '0.1.0-beta.12', { fetchFn });

    await manager.startEnrollment({
      serverUrl: 'https://api-staging.adrouter.co',
      sponsoredCompute: false,
      displayName: 'Replacement Agent',
    });
    await manager.continueEnrollment();

    await expect(store.getInstallationRecord()).resolves.toMatchObject({
      installationId: existing.installationId,
      refreshToken: existing.refreshToken,
    });
    await expect(store.get()).resolves.toMatchObject({
      configured: true,
      sponsoredCompute: true,
    });

    await manager.cancelEnrollment();

    const cancellation = requests.at(-1);
    expect(cancellation?.url).toBe(
      'https://api-staging.adrouter.co/v1/device/authorizations/cancel'
    );
    expect(cancellation?.init.headers).toMatchObject({ DPoP: expect.any(String) });
    expect(JSON.parse(String(cancellation?.init.body))).toEqual({
      device_code: deviceCode,
      client_kind: 'desktop',
    });
    await expect(store.getPendingEnrollment()).resolves.toBeUndefined();
    await expect(store.getInstallationRecord()).resolves.toMatchObject({
      installationId: existing.installationId,
    });
  });

  it('resumes an encrypted pending approval after restart without recreating it', async () => {
    const { store } = await createStore();
    const keyPair = generateInstallationKeyPair();
    const now = Date.now();
    const pending: PendingEnrollmentRecord = {
      version: 1,
      privateJwk: keyPair.privateJwk,
      deviceCode,
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://app-staging.adrouter.co/connect',
      verificationUriComplete: 'https://app-staging.adrouter.co/connect?code=ABCD-EFGH',
      intervalSeconds: 5,
      expiresAt: new Date(now + 20 * 60_000).toISOString(),
      nextPollAt: new Date(now + 10 * 60_000).toISOString(),
      origin: 'https://api-staging.adrouter.co',
      clientVersion: '0.1.0-beta.12',
      displayName: 'AdRouter Agent',
      sponsoredCompute: true,
      scopes: ['agent:turn', 'profile:read'],
    };
    await store.savePendingEnrollment(pending);
    const fetchFn = vi.fn<typeof fetch>();
    const manager = new InstallationAuthManager(store, '0.1.0-beta.12', { fetchFn });

    await expect(manager.enrollmentStatus()).resolves.toMatchObject({
      state: 'pending',
      userCode: 'ABCD-EFGH',
    });
    await expect(manager.enrollmentUrl()).resolves.toBe(pending.verificationUriComplete);
    expect(fetchFn).not.toHaveBeenCalled();
    manager.dispose();
    await expect(store.getPendingEnrollment()).resolves.toMatchObject({ deviceCode });
  });

  it('polls with the exact device grant and branches on the Router code field', async () => {
    const { store } = await createStore();
    const requests: RequestInit[] = [];
    const responses = [
      new Response('', { status: 401, headers: { 'DPoP-Nonce': 'enroll-nonce' } }),
      new Response(
        JSON.stringify({
          device_code: deviceCode,
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://app-staging.adrouter.co/connect',
          verification_uri_complete: 'https://app-staging.adrouter.co/connect?code=ABCD-EFGH',
          expires_in: 600,
          interval: 5,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      ),
      ...[
        ['Still waiting for approval.', 'authorization_pending'],
        ['Please reduce polling frequency.', 'slow_down'],
        ['The user declined this request.', 'access_denied'],
        ['This approval has expired.', 'expired_token'],
      ].map(
        ([error, code]) =>
          new Response(JSON.stringify({ error, code }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
      ),
    ];
    const fetchFn: typeof fetch = vi.fn(async (_input, init) => {
      requests.push(init ?? {});
      const response = responses.shift();
      if (!response) throw new Error('Unexpected authentication request.');
      return response;
    });
    const manager = new InstallationAuthManager(store, '0.1.0-beta.12', { fetchFn });
    await manager.startEnrollment({
      serverUrl: 'https://api-staging.adrouter.co',
      sponsoredCompute: true,
      displayName: 'AdRouter Agent',
    });
    await manager.continueEnrollment();
    const pending = await store.getPendingEnrollment();
    if (!pending) throw new Error('Expected encrypted pending enrollment.');
    const pollOnce = Reflect.get(manager, 'pollOnce') as (
      pending: PendingEnrollmentRecord,
      signal: AbortSignal
    ) => Promise<string>;

    await expect(pollOnce.call(manager, pending, new AbortController().signal)).resolves.toBe(
      'pending'
    );
    await expect(pollOnce.call(manager, pending, new AbortController().signal)).resolves.toBe(
      'pending'
    );
    await expect(pollOnce.call(manager, pending, new AbortController().signal)).resolves.toBe(
      'denied'
    );
    await expect(pollOnce.call(manager, pending, new AbortController().signal)).resolves.toBe(
      'expired'
    );

    for (const request of requests.slice(2)) {
      expect(JSON.parse(String(request.body))).toEqual({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_kind: 'desktop',
      });
    }
    await manager.cancelEnrollment();
  });

  it('persists refresh rotation before returning one single-flight access token', async () => {
    const { store, path } = await createStore();
    const record = createRecord();
    await store.completeEnrollment(
      record,
      bundledCatalogModels(),
      bundledCatalogStatus(),
      '2026-07-27T00:00:00.000Z'
    );
    const fetchFn: typeof fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: accessToken,
            token_type: 'DPoP',
            expires_in: 600,
            refresh_token: rotatedRefreshToken,
            refresh_expires_in: 2_592_000,
            installation_id: record.installationId,
            client_kind: 'desktop',
            scope: 'agent:turn profile:read',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    const manager = new InstallationAuthManager(store, '0.1.0-beta.12', { fetchFn });
    const body = Buffer.from('{"exact":true}', 'utf8');
    const [first, second] = await Promise.all([
      manager.authorize({ method: 'POST', path: '/v1/agent/turn', body }),
      manager.authorize({ method: 'POST', path: '/v1/agent/turn', body }),
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(first.Authorization).toBe(`DPoP ${accessToken}`);
    expect(second.Authorization).toBe(`DPoP ${accessToken}`);
    expect(first.DPoP).not.toBe(second.DPoP);
    await expect(store.getInstallationRecord()).resolves.toMatchObject({
      refreshToken: rotatedRefreshToken,
    });
    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain(rotatedRefreshToken);
    expect(persisted).not.toContain(accessToken);

    const profileHeaders = await manager.authorize({ method: 'GET', path: '/v1/profile' });
    expect(profileHeaders).not.toHaveProperty('Content-Digest');
    const encodedProfilePayload = profileHeaders.DPoP.split('.')[1];
    if (!encodedProfilePayload) throw new Error('The profile proof is malformed.');
    const profilePayload = JSON.parse(
      Buffer.from(encodedProfilePayload, 'base64url').toString('utf8')
    ) as Record<string, unknown>;
    expect(profilePayload).not.toHaveProperty('bht');
  });

  it('rejects non-allowlisted signing and clears local auth when remote revocation is offline', async () => {
    const { store } = await createStore();
    const record = createRecord();
    await store.completeEnrollment(
      record,
      bundledCatalogModels(),
      bundledCatalogStatus(),
      '2026-07-27T00:00:00.000Z'
    );
    const manager = new InstallationAuthManager(store, '0.1.0-beta.12', {
      fetchFn: vi.fn(async () => {
        throw new Error('offline');
      }),
    });

    await expect(
      manager.authorize({
        method: 'POST',
        path: '/v1/profile' as '/v1/agent/turn',
        body: Buffer.from('{}'),
      })
    ).rejects.toThrow(/not signable/);
    await expect(manager.signOut()).resolves.toMatchObject({
      remoteRevocationConfirmed: false,
      configuration: { configured: false },
    });
    await expect(store.getInstallationRecord()).resolves.toBeUndefined();
  });

  it('fails closed and clears persisted auth when refresh rotation cannot be stored', async () => {
    const { store } = await createStore();
    const record = createRecord();
    await store.completeEnrollment(
      record,
      bundledCatalogModels(),
      bundledCatalogStatus(),
      '2026-07-27T00:00:00.000Z'
    );
    vi.spyOn(store, 'rotateInstallation').mockRejectedValueOnce(new Error('disk failure'));
    const manager = new InstallationAuthManager(store, '0.1.0-beta.12', {
      fetchFn: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: accessToken,
              token_type: 'DPoP',
              expires_in: 600,
              refresh_token: rotatedRefreshToken,
              refresh_expires_in: 2_592_000,
              installation_id: record.installationId,
              client_kind: 'desktop',
              scope: 'agent:turn profile:read',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      ),
    });

    await expect(manager.authorize({ method: 'GET', path: '/v1/profile' })).rejects.toThrow(
      /could not be stored/
    );
    await expect(store.getInstallationRecord()).resolves.toBeUndefined();
    await expect(store.get()).resolves.toMatchObject({ configured: false });
  });
});
