import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationStore, type CredentialCipher } from '@/main/configuration-store';
import type { RouterCatalogStatus, RouterModelDescriptor } from '@/shared/contracts';
import {
  ADROUTER_CATALOG_DIGEST,
  bundledCatalogModels,
  bundledCatalogStatus,
  unavailableCatalogStatus,
} from '@/shared/model-catalog';

const directories: string[] = [];

const testCipher: CredentialCipher = {
  assertSecure: async () => undefined,
  encrypt: async (value) => `encrypted:${value}`,
  decrypt: async () => ({ value: 'custom-token', shouldReEncrypt: false }),
};

const customModel: RouterModelDescriptor = {
  id: 'model-pro',
  provider: 'router',
  modelClass: 'pro',
  displayName: 'Model Pro',
  providerLabel: 'AdRouter',
  description: 'Strict custom model fixture.',
  thinkingLevels: ['medium', 'high'],
  defaultThinkingLevel: 'medium',
  contextWindow: 131_072,
  maxInputTokens: 126_976,
  maxOutputTokens: 4_096,
  configured: true,
};

const customCatalog: RouterCatalogStatus = {
  schemaVersion: 1,
  digest: `sha256:${'1'.repeat(64)}`,
  source: 'live',
  freshness: 'fresh',
  compatibility: 'compatible',
  lastValidatedAt: '2026-07-26T00:00:00.000Z',
  lastAttemptAt: '2026-07-26T00:00:00.000Z',
  errorCode: null,
};

const versionFiveConfiguration = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  version: 5,
  serverUrl: 'https://router.example',
  sponsoredCompute: false,
  authMode: 'custom_bearer',
  encryptedToken: 'ciphertext',
  encryptedInstallation: null,
  encryptedPendingEnrollment: null,
  installationMetadata: null,
  models: [customModel],
  catalog: customCatalog,
  selectedModel: customModel.id,
  selectedThinkingLevel: 'high',
  lastCheckedAt: customCatalog.lastAttemptAt,
  ...overrides,
});

beforeEach(() => {
  vi.stubGlobal('__ADROUTER_E2E__', false);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('ConfigurationStore', () => {
  it('uses the exact bundled hosted catalog for a fresh unconfigured install', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adrouter-config-'));
    directories.push(directory);
    const store = new ConfigurationStore(join(directory, 'configuration.json'));

    await expect(store.get()).resolves.toMatchObject({
      serverUrl: 'http://127.0.0.1:8787',
      configured: false,
      tokenStored: false,
      models: bundledCatalogModels(),
      catalog: {
        ...bundledCatalogStatus(),
        digest: ADROUTER_CATALOG_DIGEST,
      },
      selectedModel: 'agnes-2.5-flash',
      selectedThinkingLevel: 'none',
    });
  });

  it('drops permissive legacy custom IDs while preserving encrypted credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adrouter-config-'));
    directories.push(directory);
    const path = join(directory, 'configuration.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        serverUrl: 'https://router.example',
        sponsoredCompute: true,
        encryptedToken: 'preserve-ciphertext',
        models: ['model-flash'],
      })
    );

    const store = new ConfigurationStore(path, testCipher);
    await expect(store.get()).resolves.toMatchObject({
      models: [],
      selectedModel: null,
      tokenStored: true,
      catalog: {
        source: 'cache',
        freshness: 'stale',
        compatibility: 'compatible',
        errorCode: 'catalog_unreachable',
      },
    });
    await expect(
      store.updatePreferences({ model: 'model-flash', thinkingLevel: 'high' })
    ).rejects.toThrow('not in the cached router catalog');

    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      version: 5,
      encryptedToken: 'preserve-ciphertext',
      models: [],
      selectedModel: null,
    });
  });

  it('migrates a signed-out official configuration to the canonical bundle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adrouter-config-'));
    directories.push(directory);
    const path = join(directory, 'configuration.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 3,
        serverUrl: 'https://api-staging.adrouter.co',
        sponsoredCompute: true,
        encryptedToken: null,
        models: [],
        selectedModel: null,
        selectedThinkingLevel: 'medium',
        lastCheckedAt: null,
      })
    );

    const store = new ConfigurationStore(path);
    await expect(store.get()).resolves.toMatchObject({
      configured: false,
      tokenStored: false,
      models: bundledCatalogModels(),
      catalog: bundledCatalogStatus(),
      authentication: { mode: 'unconfigured', state: 'none' },
    });
  });

  it('signs out locally while preserving strict cached preferences', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adrouter-config-'));
    directories.push(directory);
    const path = join(directory, 'configuration.json');
    await writeFile(path, JSON.stringify(versionFiveConfiguration()));

    const store = new ConfigurationStore(path, testCipher);
    await expect(store.signOutLocal()).resolves.toMatchObject({
      serverUrl: 'https://router.example',
      sponsoredCompute: false,
      tokenStored: false,
      configured: false,
      selectedModel: 'model-pro',
      selectedThinkingLevel: 'high',
    });
    await expect(store.getRuntimeConfiguration()).rejects.toThrow(
      'Complete AdRouter onboarding before starting an agent task.'
    );

    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      version: 5,
      serverUrl: 'https://router.example',
      sponsoredCompute: false,
      authMode: 'unconfigured',
      encryptedToken: null,
      selectedModel: 'model-pro',
      selectedThinkingLevel: 'high',
    });
  });

  it('blocks new turns after catalog incompatibility but allows a stale compatible cache', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adrouter-config-'));
    directories.push(directory);
    const path = join(directory, 'configuration.json');
    await writeFile(path, JSON.stringify(versionFiveConfiguration()));

    const store = new ConfigurationStore(path, testCipher);
    const incompatible = unavailableCatalogStatus(
      '2026-08-02T00:00:00.000Z',
      'catalog_incompatible',
      true
    );
    await store.noteCatalogFailure(incompatible, '2026-08-02T00:00:00.000Z');
    await expect(store.getRuntimeConfiguration()).rejects.toThrow(
      'incompatible router model catalog'
    );
    await expect(store.get()).resolves.toMatchObject({
      models: [customModel],
      catalog: {
        source: 'cache',
        freshness: 'stale',
        compatibility: 'incompatible',
        errorCode: 'catalog_incompatible',
      },
    });

    const compatibleStale = unavailableCatalogStatus(
      '2026-08-02T00:01:00.000Z',
      'catalog_unreachable'
    );
    await store.noteCatalogFailure(compatibleStale, '2026-08-02T00:01:00.000Z');
    await expect(store.getRuntimeConfiguration()).resolves.toMatchObject({
      authMode: 'custom_bearer',
      token: 'custom-token',
    });
  });
});
