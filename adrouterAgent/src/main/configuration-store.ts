import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { safeStorage } from 'electron';
import { AdRouterClient } from '../runtime/router-client';
import {
  classifyRouterOrigin,
  DEFAULT_ADROUTER_SERVER_URL,
  type RouterOriginClass,
} from '../shared/constants';
import type {
  InstallationDiagnostics,
  RouterAuthenticationModeSchema,
  RouterCatalogStatus,
  RouterConfiguration,
  RouterDiagnostics,
  RouterModelDescriptor,
  ThinkingLevel,
} from '../shared/contracts';
import { RouterCatalogStatusSchema, RouterModelDescriptorSchema } from '../shared/contracts';
import {
  bundledCatalogModels,
  bundledCatalogStatus,
  unavailableCatalogStatus,
} from '../shared/model-catalog';
import { assertSecureCredentialStorage } from './credential-storage';
import {
  type InstallationRecord,
  type PendingEnrollmentRecord,
  parseInstallationRecord,
  parsePendingEnrollmentRecord,
} from './installation-records';

type AuthenticationMode = (typeof RouterAuthenticationModeSchema)['_output'];

interface InstallationMetadata {
  installationIdSuffix: string;
  scopes: Array<'agent:turn' | 'profile:read'>;
  familyExpiresAt: string;
  reconnectRequired: boolean;
  minimumClientVersion: string | null;
  policyMode: 'observe' | 'warn' | 'enforce' | null;
}

interface PersistedConfiguration {
  version: 5;
  serverUrl: string;
  sponsoredCompute: boolean;
  authMode: AuthenticationMode;
  encryptedToken: string | null;
  encryptedInstallation: string | null;
  encryptedPendingEnrollment: string | null;
  installationMetadata: InstallationMetadata | null;
  models: RouterModelDescriptor[];
  catalog: RouterCatalogStatus;
  selectedModel: string | null;
  selectedThinkingLevel: ThinkingLevel;
  lastCheckedAt: string | null;
}

export type RuntimeRouterConfiguration =
  | {
      serverUrl: string;
      sponsoredCompute: boolean;
      authMode: 'installation';
    }
  | {
      serverUrl: string;
      sponsoredCompute: boolean;
      authMode: 'custom_bearer';
      token: string;
    };

export interface CredentialCipher {
  assertSecure(): Promise<void>;
  encrypt(value: string): Promise<string>;
  decrypt(value: string): Promise<{ value: string; shouldReEncrypt: boolean }>;
}

const electronCredentialCipher: CredentialCipher = {
  assertSecure: () => assertSecureCredentialStorage(),
  encrypt: async (value) => (await safeStorage.encryptStringAsync(value)).toString('base64'),
  decrypt: async (value) => {
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(value, 'base64'));
    return { value: decrypted.result, shouldReEncrypt: decrypted.shouldReEncrypt };
  },
};

export const allowRouterUrl = (value: string): string => {
  const url = new URL(value);
  const localHost = classifyRouterOrigin(url.toString()) === 'loopback';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) {
    throw new Error('Use HTTPS for AdRouter, except a local development server.');
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error('AdRouter URLs cannot contain credentials, query parameters, or fragments.');
  }
  return url.toString().replace(/\/$/, '');
};

const isTimestampOrNull = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

const isAuthenticationMode = (value: unknown): value is AuthenticationMode =>
  value === 'unconfigured' ||
  value === 'installation' ||
  value === 'custom_bearer' ||
  value === 'legacy_hosted';

const normalizeSuffix = (value: string): string => value.slice(-12);

const preferredDefaultModel = (
  models: RouterModelDescriptor[]
): RouterModelDescriptor | undefined =>
  models.find((model) => model.id === 'agnes-2.5-flash') ?? models[0];

export class ConfigurationStore {
  public constructor(
    private readonly path: string,
    private readonly cipher: CredentialCipher = electronCredentialCipher
  ) {}

  public async assertSecureStorage(): Promise<void> {
    await this.cipher.assertSecure();
  }

  public async get(): Promise<RouterConfiguration> {
    const configuration = await this.read();
    const current = configuration ?? this.emptyConfiguration();
    const serverUrl = current.serverUrl;
    const authentication = await this.authenticationDiagnostics(configuration, serverUrl);
    return {
      serverUrl,
      sponsoredCompute: current.sponsoredCompute,
      tokenStored: Boolean(current.encryptedToken),
      configured:
        (authentication.mode === 'installation' && authentication.state === 'connected') ||
        (authentication.mode === 'custom_bearer' && Boolean(current.encryptedToken)),
      models: current.models,
      catalog: current.catalog,
      selectedModel: current.selectedModel ?? preferredDefaultModel(current.models)?.id ?? null,
      selectedThinkingLevel: current.selectedThinkingLevel,
      lastCheckedAt: current.lastCheckedAt,
      authentication,
    };
  }

  public async save(input: {
    serverUrl: string;
    token: string;
    sponsoredCompute: boolean;
  }): Promise<RouterConfiguration> {
    const existing = await this.read();
    const serverUrl = allowRouterUrl(input.serverUrl);
    if (classifyRouterOrigin(serverUrl) === 'official') {
      throw new Error('Official AdRouter servers require Connect this Agent approval.');
    }
    const diagnostics = await new AdRouterClient({
      serverUrl,
      authentication: { mode: 'custom_bearer', token: input.token },
    }).diagnostics();
    this.assertConnected(diagnostics);
    const encryptedToken = __ADROUTER_E2E__
      ? 'e2e-runtime-token'
      : await this.encryptSecret(input.token);
    await this.write({
      version: 5,
      serverUrl,
      sponsoredCompute: input.sponsoredCompute,
      authMode: 'custom_bearer',
      encryptedToken,
      encryptedInstallation: null,
      encryptedPendingEnrollment: null,
      installationMetadata: null,
      models: diagnostics.models,
      catalog: diagnostics.catalog,
      ...this.selectPreferences(existing, diagnostics.models),
      lastCheckedAt: diagnostics.checkedAt,
    });
    return this.get();
  }

  public async signOutLocal(): Promise<RouterConfiguration> {
    const configuration = await this.read();
    if (!configuration) return this.get();
    await this.write({
      ...configuration,
      authMode: 'unconfigured',
      encryptedToken: null,
      encryptedInstallation: null,
      encryptedPendingEnrollment: null,
      installationMetadata: null,
    });
    return this.get();
  }

  public async test(input: { serverUrl: string; token: string }): Promise<RouterDiagnostics> {
    const checkedAt = new Date().toISOString();
    try {
      const serverUrl = allowRouterUrl(input.serverUrl);
      if (classifyRouterOrigin(serverUrl) === 'official') {
        throw new Error('Official AdRouter servers require installation approval, not an API key.');
      }
      return await new AdRouterClient({
        serverUrl,
        authentication: { mode: 'custom_bearer', token: input.token },
      }).diagnostics();
    } catch (error) {
      return this.failedDiagnostics(
        input.serverUrl,
        checkedAt,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  public async statusCustom(): Promise<RouterDiagnostics> {
    const configuration = await this.read();
    if (configuration?.authMode !== 'custom_bearer') {
      return this.failedDiagnostics(
        configuration?.serverUrl ?? DEFAULT_ADROUTER_SERVER_URL,
        new Date().toISOString(),
        'Custom AdRouter bearer authentication is not configured.',
        configuration?.models ?? []
      );
    }
    try {
      if (!configuration.encryptedToken) {
        throw new Error('The encrypted AdRouter credential is unavailable.');
      }
      const token = __ADROUTER_E2E__
        ? process.env.ADROUTER_E2E_TOKEN
        : await this.decryptSecret(configuration, 'encryptedToken');
      if (!token) throw new Error('The deterministic E2E router token is unavailable.');
      const diagnostics = await new AdRouterClient({
        serverUrl: configuration.serverUrl,
        authentication: { mode: 'custom_bearer', token },
      }).diagnostics();
      if (diagnostics.models.length > 0 && diagnostics.catalog.compatibility === 'compatible') {
        await this.updateModels(diagnostics.models, diagnostics.catalog, diagnostics.checkedAt);
        return diagnostics;
      }
      await this.noteCatalogFailure(diagnostics.catalog, diagnostics.checkedAt);
      return this.withCachedCatalog((await this.read()) ?? configuration, diagnostics);
    } catch (error) {
      const checkedAt = new Date().toISOString();
      const diagnostics = this.failedDiagnostics(
        configuration.serverUrl,
        checkedAt,
        error instanceof Error ? error.message : String(error),
        configuration.models,
        configuration.catalog
      );
      await this.noteCatalogFailure(diagnostics.catalog, checkedAt);
      return diagnostics;
    }
  }

  public async updatePreferences(input: {
    model: string;
    thinkingLevel: ThinkingLevel;
  }): Promise<RouterConfiguration> {
    const configuration = await this.read();
    if (!configuration) throw new Error('AdRouter is not configured.');
    const model = configuration.models.find((candidate) => candidate.id === input.model);
    if (!model) throw new Error('The selected model is not in the cached router catalog.');
    if (!model.thinkingLevels.includes(input.thinkingLevel)) {
      throw new Error('The selected thinking level is not supported by this model.');
    }
    configuration.selectedModel = model.id;
    configuration.selectedThinkingLevel = input.thinkingLevel;
    await this.write(configuration);
    return this.get();
  }

  public async getRuntimeConfiguration(): Promise<RuntimeRouterConfiguration> {
    const configuration = await this.read();
    if (!configuration) {
      throw new Error('Complete AdRouter onboarding before starting an agent task.');
    }
    if (configuration.catalog.compatibility === 'incompatible') {
      throw new Error('Update this Agent before using the incompatible router model catalog.');
    }
    if (configuration.models.length === 0) {
      throw new Error('Refresh the router model catalog before starting an agent task.');
    }
    if (configuration.authMode === 'installation' && configuration.encryptedInstallation) {
      if (configuration.installationMetadata?.reconnectRequired) {
        throw new Error('Reconnect this Agent before starting another task.');
      }
      return {
        serverUrl: configuration.serverUrl,
        sponsoredCompute: configuration.sponsoredCompute,
        authMode: 'installation',
      };
    }
    if (configuration.authMode !== 'custom_bearer' || !configuration.encryptedToken) {
      throw new Error('Complete AdRouter onboarding before starting an agent task.');
    }
    if (__ADROUTER_E2E__) {
      const token = process.env.ADROUTER_E2E_TOKEN;
      if (!token) throw new Error('The deterministic E2E router token is unavailable.');
      return {
        serverUrl: configuration.serverUrl,
        sponsoredCompute: configuration.sponsoredCompute,
        authMode: 'custom_bearer',
        token,
      };
    }
    const token = await this.decryptSecret(configuration, 'encryptedToken');
    return {
      serverUrl: configuration.serverUrl,
      sponsoredCompute: configuration.sponsoredCompute,
      authMode: 'custom_bearer',
      token,
    };
  }

  public async getInstallationRecord(): Promise<InstallationRecord | undefined> {
    const configuration = await this.read();
    if (!configuration?.encryptedInstallation) return undefined;
    return parseInstallationRecord(
      JSON.parse(await this.decryptSecret(configuration, 'encryptedInstallation'))
    );
  }

  public async getPendingEnrollment(): Promise<PendingEnrollmentRecord | undefined> {
    const configuration = await this.read();
    if (!configuration?.encryptedPendingEnrollment) return undefined;
    return parsePendingEnrollmentRecord(
      JSON.parse(await this.decryptSecret(configuration, 'encryptedPendingEnrollment'))
    );
  }

  public async savePendingEnrollment(record: PendingEnrollmentRecord): Promise<void> {
    const configuration = (await this.read()) ?? this.emptyConfiguration();
    const encryptedPendingEnrollment = await this.encryptSecret(JSON.stringify(record));
    await this.write({
      ...configuration,
      serverUrl: configuration.encryptedInstallation
        ? configuration.serverUrl
        : allowRouterUrl(record.origin),
      sponsoredCompute: configuration.encryptedInstallation
        ? configuration.sponsoredCompute
        : record.sponsoredCompute,
      authMode: configuration.encryptedInstallation ? configuration.authMode : 'installation',
      encryptedToken: null,
      encryptedPendingEnrollment,
    });
  }

  public async clearPendingEnrollment(): Promise<void> {
    const configuration = await this.read();
    if (!configuration?.encryptedPendingEnrollment) return;
    await this.write({
      ...configuration,
      authMode: configuration.encryptedInstallation ? 'installation' : 'unconfigured',
      encryptedPendingEnrollment: null,
    });
  }

  public async completeEnrollment(
    record: InstallationRecord,
    models: RouterModelDescriptor[],
    catalog: RouterCatalogStatus,
    checkedAt: string
  ): Promise<void> {
    const configuration = (await this.read()) ?? this.emptyConfiguration();
    const encryptedInstallation = await this.encryptSecret(JSON.stringify(record));
    await this.write({
      ...configuration,
      serverUrl: allowRouterUrl(record.origin),
      authMode: 'installation',
      encryptedToken: null,
      encryptedInstallation,
      encryptedPendingEnrollment: null,
      installationMetadata: this.metadataFor(record),
      models,
      catalog,
      ...this.selectPreferences(configuration, models),
      lastCheckedAt: checkedAt,
    });
  }

  public async rotateInstallation(record: InstallationRecord): Promise<void> {
    const configuration = await this.read();
    if (!configuration?.encryptedInstallation) {
      throw new Error('The installation is no longer available.');
    }
    const encryptedInstallation = await this.encryptSecret(JSON.stringify(record));
    await this.write({
      ...configuration,
      encryptedInstallation,
      installationMetadata: this.metadataFor(record),
    });
  }

  public async markReconnectRequired(
    minimumClientVersion: string | null = null,
    upgradeRequired = false
  ): Promise<void> {
    const configuration = await this.read();
    if (!configuration?.installationMetadata) return;
    await this.write({
      ...configuration,
      installationMetadata: {
        ...configuration.installationMetadata,
        reconnectRequired: true,
        minimumClientVersion: upgradeRequired
          ? minimumClientVersion
          : configuration.installationMetadata.minimumClientVersion,
      },
    });
  }

  public async updateModels(
    models: RouterModelDescriptor[],
    catalog: RouterCatalogStatus,
    checkedAt: string
  ): Promise<void> {
    const configuration = await this.read();
    if (!configuration) return;
    await this.write({
      ...configuration,
      models,
      catalog,
      ...this.selectPreferences(configuration, models),
      lastCheckedAt: checkedAt,
    });
  }

  public async noteCatalogFailure(
    attemptedCatalog: RouterCatalogStatus,
    checkedAt: string
  ): Promise<void> {
    const configuration = await this.read();
    if (!configuration) return;
    await this.write({
      ...configuration,
      catalog: {
        ...configuration.catalog,
        source: 'cache',
        freshness: configuration.models.length > 0 ? 'stale' : attemptedCatalog.freshness,
        compatibility: attemptedCatalog.compatibility,
        lastAttemptAt: checkedAt,
        errorCode: attemptedCatalog.errorCode,
      },
      lastCheckedAt: checkedAt,
    });
  }

  private metadataFor(record: InstallationRecord): InstallationMetadata {
    return {
      installationIdSuffix: normalizeSuffix(record.installationId),
      scopes: [...record.scopes],
      familyExpiresAt: record.familyExpiresAt,
      reconnectRequired: false,
      minimumClientVersion: null,
      policyMode: null,
    };
  }

  private emptyConfiguration(): PersistedConfiguration {
    const models = bundledCatalogModels();
    const selectedModel = preferredDefaultModel(models);
    return {
      version: 5,
      serverUrl: DEFAULT_ADROUTER_SERVER_URL,
      sponsoredCompute: true,
      authMode: 'unconfigured',
      encryptedToken: null,
      encryptedInstallation: null,
      encryptedPendingEnrollment: null,
      installationMetadata: null,
      models,
      catalog: bundledCatalogStatus(),
      selectedModel: selectedModel?.id ?? null,
      selectedThinkingLevel: selectedModel?.defaultThinkingLevel ?? 'none',
      lastCheckedAt: null,
    };
  }

  private async authenticationDiagnostics(
    configuration: PersistedConfiguration | undefined,
    serverUrl: string
  ): Promise<InstallationDiagnostics> {
    const originClass = classifyRouterOrigin(serverUrl);
    const mode = configuration?.authMode ?? 'unconfigured';
    const pendingEnrollment = Boolean(configuration?.encryptedPendingEnrollment);
    const metadata = configuration?.installationMetadata;
    let storageClassification: 'os_encrypted' | 'unavailable' | null = null;
    if (mode === 'installation' || mode === 'legacy_hosted' || pendingEnrollment) {
      try {
        await this.cipher.assertSecure();
        storageClassification = 'os_encrypted';
      } catch {
        storageClassification = 'unavailable';
      }
    }
    const expired = metadata ? Date.parse(metadata.familyExpiresAt) <= Date.now() : false;
    const reconnectRequired = Boolean(metadata?.reconnectRequired || expired);
    const hasInstallation =
      mode === 'installation' && Boolean(configuration?.encryptedInstallation);
    const state =
      pendingEnrollment && !hasInstallation
        ? 'pending'
        : hasInstallation
          ? reconnectRequired
            ? metadata?.minimumClientVersion
              ? 'upgrade_required'
              : 'reconnect_required'
            : 'connected'
          : mode === 'legacy_hosted'
            ? 'reconnect_required'
            : 'none';
    return {
      mode,
      state,
      originClass,
      storageClassification,
      signedRequestSupport: true,
      refreshHealthy: state === 'connected' && !expired,
      pendingEnrollment,
      reconnectRequired: state === 'reconnect_required' || state === 'upgrade_required',
      installationIdSuffix: metadata?.installationIdSuffix ?? null,
      scopes: metadata?.scopes ?? [],
      familyExpiresAt: metadata?.familyExpiresAt ?? null,
      minimumClientVersion: metadata?.minimumClientVersion ?? null,
      policyMode: metadata?.policyMode ?? null,
    };
  }

  private async read(): Promise<PersistedConfiguration | undefined> {
    if (!existsSync(this.path)) return undefined;
    const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
    if (
      parsed.version === 1 ||
      parsed.version === 2 ||
      parsed.version === 3 ||
      parsed.version === 4
    ) {
      const migrated = this.migrateLegacy(parsed);
      await this.write(migrated);
      return migrated;
    }
    const models = RouterModelDescriptorSchema.array().safeParse(parsed.models);
    const catalog = RouterCatalogStatusSchema.safeParse(parsed.catalog);
    if (
      parsed.version !== 5 ||
      typeof parsed.serverUrl !== 'string' ||
      typeof parsed.sponsoredCompute !== 'boolean' ||
      !isAuthenticationMode(parsed.authMode) ||
      !this.isCiphertext(parsed.encryptedToken) ||
      !this.isCiphertext(parsed.encryptedInstallation) ||
      !this.isCiphertext(parsed.encryptedPendingEnrollment) ||
      !models.success ||
      !catalog.success ||
      !(parsed.selectedModel === null || typeof parsed.selectedModel === 'string') ||
      !['none', 'medium', 'high'].includes(String(parsed.selectedThinkingLevel)) ||
      !isTimestampOrNull(parsed.lastCheckedAt)
    ) {
      throw new Error('AdRouter configuration is corrupted. Reconnect this Agent.');
    }
    const metadata = this.parseMetadata(parsed.installationMetadata);
    return {
      version: 5,
      serverUrl: allowRouterUrl(parsed.serverUrl),
      sponsoredCompute: parsed.sponsoredCompute,
      authMode: parsed.authMode,
      encryptedToken: parsed.encryptedToken,
      encryptedInstallation: parsed.encryptedInstallation,
      encryptedPendingEnrollment: parsed.encryptedPendingEnrollment,
      installationMetadata: metadata,
      models: models.data,
      catalog: catalog.data,
      selectedModel: parsed.selectedModel,
      selectedThinkingLevel: parsed.selectedThinkingLevel as ThinkingLevel,
      lastCheckedAt: parsed.lastCheckedAt,
    };
  }

  private migrateLegacy(parsed: Record<string, unknown>): PersistedConfiguration {
    if (
      typeof parsed.serverUrl !== 'string' ||
      typeof parsed.sponsoredCompute !== 'boolean' ||
      !(typeof parsed.encryptedToken === 'string' || parsed.encryptedToken === null)
    ) {
      throw new Error('AdRouter configuration is corrupted. Reconnect this Agent.');
    }
    const serverUrl = allowRouterUrl(parsed.serverUrl);
    const official = classifyRouterOrigin(serverUrl) === 'official';
    const models = official ? bundledCatalogModels() : [];
    const hasToken = typeof parsed.encryptedToken === 'string';
    const versionFour = parsed.version === 4;
    const authMode =
      versionFour && isAuthenticationMode(parsed.authMode)
        ? parsed.authMode
        : hasToken
          ? official
            ? 'legacy_hosted'
            : 'custom_bearer'
          : 'unconfigured';
    const encryptedInstallation =
      versionFour && this.isCiphertext(parsed.encryptedInstallation)
        ? parsed.encryptedInstallation
        : null;
    const encryptedPendingEnrollment =
      versionFour && this.isCiphertext(parsed.encryptedPendingEnrollment)
        ? parsed.encryptedPendingEnrollment
        : null;
    const installationMetadata = versionFour
      ? this.parseMetadata(parsed.installationMetadata)
      : null;
    const previousSelection =
      typeof parsed.selectedModel === 'string'
        ? models.find((model) => model.id === parsed.selectedModel)
        : undefined;
    const requestedThinking = ['none', 'medium', 'high'].includes(
      String(parsed.selectedThinkingLevel)
    )
      ? (parsed.selectedThinkingLevel as ThinkingLevel)
      : undefined;
    const selectedModel = previousSelection ?? preferredDefaultModel(models);
    return {
      version: 5,
      serverUrl,
      sponsoredCompute: parsed.sponsoredCompute,
      authMode,
      encryptedToken: parsed.encryptedToken,
      encryptedInstallation,
      encryptedPendingEnrollment,
      installationMetadata,
      models,
      catalog: official
        ? bundledCatalogStatus()
        : {
            ...unavailableCatalogStatus(new Date(0).toISOString(), 'catalog_unreachable'),
            source: 'cache',
            lastAttemptAt: null,
          },
      selectedModel: selectedModel?.id ?? null,
      selectedThinkingLevel:
        selectedModel &&
        requestedThinking &&
        selectedModel.thinkingLevels.includes(requestedThinking)
          ? requestedThinking
          : (selectedModel?.defaultThinkingLevel ?? 'medium'),
      lastCheckedAt: isTimestampOrNull(parsed.lastCheckedAt) ? parsed.lastCheckedAt : null,
    };
  }

  private parseMetadata(value: unknown): InstallationMetadata | null {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('AdRouter installation metadata is corrupted.');
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.installationIdSuffix !== 'string' ||
      !Array.isArray(record.scopes) ||
      !record.scopes.every((scope) => scope === 'agent:turn' || scope === 'profile:read') ||
      !isTimestampOrNull(record.familyExpiresAt) ||
      record.familyExpiresAt === null ||
      typeof record.reconnectRequired !== 'boolean' ||
      !(record.minimumClientVersion === null || typeof record.minimumClientVersion === 'string') ||
      !(
        record.policyMode === null ||
        record.policyMode === 'observe' ||
        record.policyMode === 'warn' ||
        record.policyMode === 'enforce'
      )
    ) {
      throw new Error('AdRouter installation metadata is corrupted.');
    }
    return record as unknown as InstallationMetadata;
  }

  private isCiphertext(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
  }

  private assertConnected(diagnostics: RouterDiagnostics): void {
    if (
      !diagnostics.health ||
      !diagnostics.authenticated ||
      diagnostics.catalog.compatibility !== 'compatible' ||
      diagnostics.models.length === 0
    ) {
      throw new Error(diagnostics.error ?? 'AdRouter connection verification failed.');
    }
  }

  private withCachedCatalog(
    configuration: PersistedConfiguration,
    diagnostics: RouterDiagnostics
  ): RouterDiagnostics {
    if (diagnostics.models.length > 0) return diagnostics;
    const modelsStale = configuration.models.length > 0;
    return {
      ...diagnostics,
      models: configuration.models,
      modelsStale,
      catalog: {
        ...configuration.catalog,
        source: 'cache',
        freshness: modelsStale ? 'stale' : configuration.catalog.freshness,
        compatibility: diagnostics.catalog.compatibility,
        lastAttemptAt: diagnostics.checkedAt,
        errorCode: diagnostics.catalog.errorCode,
      },
    };
  }

  private selectPreferences(
    existing: PersistedConfiguration | undefined,
    models: RouterModelDescriptor[]
  ): Pick<PersistedConfiguration, 'selectedModel' | 'selectedThinkingLevel'> {
    const previous = models.find((model) => model.id === existing?.selectedModel);
    if (previous) {
      return {
        selectedModel: previous.id,
        selectedThinkingLevel: previous.thinkingLevels.includes(
          existing?.selectedThinkingLevel ?? previous.defaultThinkingLevel
        )
          ? (existing?.selectedThinkingLevel ?? previous.defaultThinkingLevel)
          : previous.defaultThinkingLevel,
      };
    }
    const selectedModel = preferredDefaultModel(models);
    return {
      selectedModel: selectedModel?.id ?? null,
      selectedThinkingLevel: selectedModel?.defaultThinkingLevel ?? 'none',
    };
  }

  private failedDiagnostics(
    serverUrl: string,
    checkedAt: string,
    error: string,
    models: RouterModelDescriptor[] = [],
    cachedCatalog?: RouterCatalogStatus
  ): RouterDiagnostics {
    const originClass: RouterOriginClass = (() => {
      try {
        return classifyRouterOrigin(serverUrl);
      } catch {
        return 'custom';
      }
    })();
    return {
      health: false,
      authenticated: false,
      mode: 'unknown',
      models,
      catalog: cachedCatalog
        ? {
            ...cachedCatalog,
            source: 'cache',
            freshness: models.length > 0 ? 'stale' : cachedCatalog.freshness,
            lastAttemptAt: checkedAt,
            errorCode: 'catalog_unreachable',
          }
        : unavailableCatalogStatus(checkedAt, 'catalog_unreachable'),
      modelsStale: models.length > 0,
      checkedAt,
      error,
      authentication: {
        mode: 'unconfigured',
        state: 'none',
        originClass,
        storageClassification: null,
        signedRequestSupport: true,
        refreshHealthy: false,
        pendingEnrollment: false,
        reconnectRequired: false,
        installationIdSuffix: null,
        scopes: [],
        familyExpiresAt: null,
        minimumClientVersion: null,
        policyMode: null,
      },
    };
  }

  private async encryptSecret(value: string): Promise<string> {
    await this.cipher.assertSecure();
    return this.cipher.encrypt(value);
  }

  private async decryptSecret(
    configuration: PersistedConfiguration,
    key: 'encryptedToken' | 'encryptedInstallation' | 'encryptedPendingEnrollment'
  ): Promise<string> {
    await this.cipher.assertSecure();
    const ciphertext = configuration[key];
    if (!ciphertext) throw new Error('The encrypted AdRouter credential is unavailable.');
    const decrypted = await this.cipher.decrypt(ciphertext);
    if (decrypted.shouldReEncrypt) {
      configuration[key] = await this.cipher.encrypt(decrypted.value);
      await this.write(configuration);
    }
    return decrypted.value;
  }

  private async write(configuration: PersistedConfiguration): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = resolve(dirname(this.path), `.config-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(configuration), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      if (existsSync(temporary)) await unlink(temporary).catch(() => undefined);
    }
  }
}
