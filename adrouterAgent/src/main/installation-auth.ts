import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  AdRouterClient,
  type ProtectedRouterHeaders,
  type ProtectedRouterRequest,
} from '../runtime/router-client';
import {
  classifyRouterOrigin,
  DESKTOP_CLIENT_KIND,
  MAX_SIGNED_REQUEST_BYTES,
  OFFICIAL_ADROUTER_WEB_ORIGINS,
} from '../shared/constants';
import type { EnrollmentStatus, RouterConfiguration, RouterDiagnostics } from '../shared/contracts';
import { allowRouterUrl, type ConfigurationStore } from './configuration-store';
import {
  INSTALLATION_SCOPES,
  type InstallationRecord,
  type PendingEnrollmentRecord,
} from './installation-records';
import {
  contentDigest,
  createDpopProof,
  exactJsonBytes,
  generateInstallationKeyPair,
  jwkThumbprint,
  publicJwkFromPrivate,
} from './platform-auth-crypto';

const MAX_AUTH_RESPONSE_BYTES = 256 * 1024;
const REFRESH_SKEW_MS = 60_000;
const PREPARED_SIGN_IN_TTL_MS = 15 * 60_000;
const DEVICE_AUTHORIZATION_CANCEL_PATH = '/v1/device/authorizations/cancel' as const;

const officialWebOriginFor = (origin: string): string => {
  if (origin === 'https://api.adrouter.co') return 'https://app.adrouter.co';
  if (origin === 'https://api-staging.adrouter.co') return 'https://app-staging.adrouter.co';
  throw new Error('Connect this Agent is available only for official AdRouter servers.');
};

const DeviceAuthorizationSchema = z
  .object({
    device_code: z.string().regex(/^adr_dc_[A-Za-z0-9_-]{43}$/),
    user_code: z.string().min(1).max(64),
    verification_uri: z.string().url(),
    verification_uri_complete: z.string().url(),
    expires_in: z.number().int().min(30).max(1_800),
    interval: z.number().int().min(1).max(30).default(5),
  })
  .strict();

const TokenResponseSchema = z
  .object({
    access_token: z.string().regex(/^adr_at_[A-Za-z0-9_-]{43}$/),
    token_type: z.literal('DPoP'),
    expires_in: z.number().int().min(30).max(3_600),
    refresh_token: z.string().regex(/^adr_rt_[A-Za-z0-9_-]{43}$/),
    refresh_expires_in: z.number().int().min(0).max(2_592_000),
    installation_id: z.string().uuid(),
    client_kind: z.literal(DESKTOP_CLIENT_KIND),
    scope: z.string().min(1).max(500),
  })
  .strict();

const OAuthErrorSchema = z
  .object({
    error: z.string().min(1).max(500),
    code: z.enum([
      'authorization_pending',
      'slow_down',
      'access_denied',
      'expired_token',
      'invalid_request',
      'invalid_access_token',
      'invalid_dpop_proof',
      'use_dpop_nonce',
      'client_not_allowed',
      'developer_required',
      'installation_not_allowed',
      'rate_limited',
      'client_upgrade_required',
    ]),
  })
  .strict();

interface AccessState {
  token: string;
  expiresAt: number;
}

interface PreparedEnrollment {
  origin: string;
  sponsoredCompute: boolean;
  displayName: string;
  browserHandoffId: string;
  signInUrl: string;
  expiresAt: number;
}

export interface SignOutResult {
  configuration: RouterConfiguration;
  remoteRevocationConfirmed: boolean;
}

export interface InstallationAuthOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
}

const idleStatus = (): EnrollmentStatus => ({
  state: 'idle',
  userCode: null,
  verificationUri: null,
  verificationUriComplete: null,
  expiresAt: null,
  nextPollAt: null,
  message: null,
});

const preparedStatus = (
  prepared: PreparedEnrollment,
  message = 'Sign in to AdRouter in your browser, then return here to continue.'
): EnrollmentStatus => ({
  ...idleStatus(),
  state: 'awaiting_sign_in',
  expiresAt: new Date(prepared.expiresAt).toISOString(),
  message,
});

const safeEnrollmentFailureMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  const allowed = [
    'This AdRouter Agent version must be upgraded.',
    'This Agent client is not allowed by the selected AdRouter server.',
    'Sign in to AdRouter and finish developer registration before continuing.',
    'This AdRouter account cannot create another installation.',
    'Your AdRouter sign-in expired. Sign in again and retry.',
    'AdRouter is receiving too many installation requests. Try again shortly.',
    'AdRouter rejected this device proof.',
    "AdRouter rejected this device proof. Check that this computer's clock is correct.",
    'AdRouter did not provide the required installation proof challenge.',
    'AdRouter returned an invalid installation approval response.',
    'AdRouter returned an unsafe approval URL.',
  ];
  if (
    allowed.includes(message) ||
    /^AdRouter Agent [0-9A-Za-z.+-]+ or newer is required\.$/.test(message)
  ) {
    return message;
  }
  return 'AdRouter could not start installation approval. Sign in again and retry.';
};

const safeStatus = (
  pending: PendingEnrollmentRecord,
  state: EnrollmentStatus['state'] = 'pending',
  message: string | null = null
): EnrollmentStatus => ({
  state,
  userCode: pending.userCode,
  verificationUri: pending.verificationUri,
  verificationUriComplete: pending.verificationUriComplete,
  expiresAt: pending.expiresAt,
  nextPollAt: pending.nextPollAt,
  message,
});

const requireOfficialWebUrl = (value: string): string => {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !(OFFICIAL_ADROUTER_WEB_ORIGINS as readonly string[]).includes(url.origin)
  ) {
    throw new Error('AdRouter returned an unsafe approval URL.');
  }
  return url.toString();
};

const requireOfficialSignInUrl = (value: string): string => {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !(OFFICIAL_ADROUTER_WEB_ORIGINS as readonly string[]).includes(url.origin) ||
    url.pathname !== '/developers' ||
    url.search !== '?connect=agent' ||
    !/^#handoff=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      url.hash
    )
  ) {
    throw new Error('The AdRouter sign-in link is invalid.');
  }
  return url.toString();
};

export class InstallationAuthManager {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private access?: AccessState;
  private refreshFlight?: Promise<AccessState>;
  private pollController?: AbortController;
  private prepared?: PreparedEnrollment;
  private continueFlight?: Promise<EnrollmentStatus>;
  private statusValue: EnrollmentStatus = idleStatus();
  private persistenceCompromised = false;

  public constructor(
    private readonly configuration: ConfigurationStore,
    private readonly clientVersion: string,
    options: InstallationAuthOptions = {}
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  public async startEnrollment(input: {
    serverUrl: string;
    sponsoredCompute: boolean;
    displayName: string;
  }): Promise<EnrollmentStatus> {
    const origin = allowRouterUrl(input.serverUrl);
    if (classifyRouterOrigin(origin) !== 'official') {
      throw new Error('Connect this Agent is available only for official AdRouter servers.');
    }
    await this.configuration.assertSecureStorage();
    if (this.continueFlight) await this.continueFlight;
    await this.discardActiveEnrollment();
    const browserHandoffId = randomUUID();
    const prepared: PreparedEnrollment = {
      origin,
      sponsoredCompute: input.sponsoredCompute,
      displayName: input.displayName,
      browserHandoffId,
      signInUrl: `${officialWebOriginFor(origin)}/developers?connect=agent#handoff=${browserHandoffId}`,
      expiresAt: this.now() + PREPARED_SIGN_IN_TTL_MS,
    };
    this.prepared = prepared;
    this.statusValue = preparedStatus(prepared);
    return this.statusValue;
  }

  public async continueEnrollment(): Promise<EnrollmentStatus> {
    if (!this.continueFlight) {
      this.continueFlight = this.createPendingEnrollment().finally(() => {
        this.continueFlight = undefined;
      });
    }
    return this.continueFlight;
  }

  private async createPendingEnrollment(): Promise<EnrollmentStatus> {
    const existing = await this.configuration.getPendingEnrollment();
    if (existing && Date.parse(existing.expiresAt) > this.now()) {
      this.prepared = undefined;
      this.statusValue = safeStatus(existing);
      if (!this.pollController) this.beginPolling(existing);
      return this.statusValue;
    }
    const prepared = this.prepared;
    if (!prepared || prepared.expiresAt <= this.now()) {
      this.prepared = undefined;
      this.statusValue = {
        ...idleStatus(),
        state: 'expired',
        message: 'The sign-in window expired. Start again to reconnect.',
      };
      return this.statusValue;
    }
    this.statusValue = {
      ...idleStatus(),
      state: 'starting',
      message: 'Creating this installation…',
    };
    const keyPair = generateInstallationKeyPair();
    const body = exactJsonBytes({
      client_kind: DESKTOP_CLIENT_KIND,
      client_version: this.clientVersion,
      display_name: prepared.displayName,
      public_key_jwk: keyPair.publicJwk,
      requested_scopes: [...INSTALLATION_SCOPES],
      storage_class: 'os_encrypted',
      browser_handoff_id: prepared.browserHandoffId,
    });
    let pending: PendingEnrollmentRecord | undefined;
    try {
      const endpoint = `${prepared.origin}/v1/device/authorizations`;
      const challenge = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Digest': contentDigest(body),
        },
        body: Buffer.from(body),
        redirect: 'manual',
      });
      this.rejectRedirect(challenge);
      const nonce = this.validNonce(challenge);
      if (challenge.status !== 401 || !nonce) {
        throw await this.responseError(
          challenge,
          'AdRouter did not provide the required installation proof challenge.'
        );
      }
      const response = await this.signedFetch({
        origin: prepared.origin,
        path: '/v1/device/authorizations',
        body,
        privateJwk: keyPair.privateJwk,
        nonce,
      });
      if (!response.ok) {
        throw await this.responseError(
          response,
          `AdRouter could not start installation approval (${response.status}).`
        );
      }
      const parsedAuthorization = DeviceAuthorizationSchema.safeParse(
        await this.readJson(response)
      );
      if (!parsedAuthorization.success) {
        throw new Error('AdRouter returned an invalid installation approval response.');
      }
      const created = parsedAuthorization.data;
      const now = this.now();
      pending = {
        version: 1,
        privateJwk: keyPair.privateJwk,
        deviceCode: created.device_code,
        userCode: created.user_code,
        verificationUri: requireOfficialWebUrl(created.verification_uri),
        verificationUriComplete: requireOfficialWebUrl(created.verification_uri_complete),
        intervalSeconds: created.interval,
        expiresAt: new Date(now + created.expires_in * 1_000).toISOString(),
        nextPollAt: new Date(now + created.interval * 1_000).toISOString(),
        origin: prepared.origin,
        clientVersion: this.clientVersion,
        displayName: prepared.displayName,
        sponsoredCompute: prepared.sponsoredCompute,
        scopes: [...INSTALLATION_SCOPES],
      };
      await this.configuration.savePendingEnrollment(pending);
      this.prepared = undefined;
      this.statusValue = safeStatus(pending);
      this.beginPolling(pending);
      return this.statusValue;
    } catch (error) {
      if (pending) await this.cancelPendingAuthorization(pending);
      await this.configuration.clearPendingEnrollment().catch(() => undefined);
      this.prepared = undefined;
      this.statusValue = {
        ...idleStatus(),
        state: 'failed',
        message: safeEnrollmentFailureMessage(error),
      };
      return this.statusValue;
    }
  }

  public async enrollmentStatus(): Promise<EnrollmentStatus> {
    const pending = await this.configuration.getPendingEnrollment();
    if (!pending) {
      if (this.prepared) {
        if (this.prepared.expiresAt <= this.now()) {
          this.prepared = undefined;
          this.statusValue = {
            ...idleStatus(),
            state: 'expired',
            message: 'The sign-in window expired. Start again to reconnect.',
          };
        } else {
          this.statusValue = preparedStatus(this.prepared, this.statusValue.message ?? undefined);
        }
      }
      return this.statusValue;
    }
    if (pending.clientVersion !== this.clientVersion) {
      await this.configuration.clearPendingEnrollment();
      this.pollController?.abort();
      await this.cancelPendingAuthorization(pending);
      this.statusValue = safeStatus(
        pending,
        'failed',
        'The Agent changed version during approval. Start again to reconnect.'
      );
      return this.statusValue;
    }
    if (Date.parse(pending.expiresAt) <= this.now()) {
      await this.configuration.clearPendingEnrollment();
      this.pollController?.abort();
      await this.cancelPendingAuthorization(pending);
      this.statusValue = safeStatus(
        pending,
        'expired',
        'Approval expired. Start again to reconnect.'
      );
      return this.statusValue;
    }
    if (!this.pollController) this.beginPolling(pending);
    if (this.statusValue.state === 'idle' || this.statusValue.state === 'starting') {
      this.statusValue = safeStatus(pending);
    }
    return this.statusValue;
  }

  public async cancelEnrollment(): Promise<EnrollmentStatus> {
    if (this.continueFlight) await this.continueFlight;
    this.pollController?.abort();
    this.pollController = undefined;
    this.prepared = undefined;
    const pending = await this.configuration.getPendingEnrollment().catch(() => undefined);
    await this.configuration.clearPendingEnrollment().catch(() => undefined);
    if (pending) await this.cancelPendingAuthorization(pending);
    this.statusValue = pending
      ? safeStatus(pending, 'cancelled', 'Installation approval was cancelled on this device.')
      : idleStatus();
    return this.statusValue;
  }

  public async enrollmentUrl(): Promise<string> {
    if (this.prepared && this.prepared.expiresAt > this.now()) {
      return requireOfficialSignInUrl(this.prepared.signInUrl);
    }
    const pending = await this.configuration.getPendingEnrollment();
    if (!pending || Date.parse(pending.expiresAt) <= this.now()) {
      throw new Error('There is no active AdRouter sign-in or approval to open.');
    }
    return requireOfficialWebUrl(pending.verificationUriComplete);
  }

  public async approvalUrl(): Promise<string> {
    return this.enrollmentUrl();
  }

  public noteBrowserOpenFailure(): EnrollmentStatus {
    if (this.prepared && this.prepared.expiresAt > this.now()) {
      this.statusValue = preparedStatus(
        this.prepared,
        'The browser could not be opened. Copy the sign-in link and open it manually.'
      );
    } else if (this.statusValue.state === 'pending') {
      this.statusValue = {
        ...this.statusValue,
        message: 'The browser could not be opened. Copy the approval link and open it manually.',
      };
    }
    return this.statusValue;
  }

  public async authorize(request: ProtectedRouterRequest): Promise<ProtectedRouterHeaders> {
    if (request.signal?.aborted) throw request.signal.reason;
    if (this.persistenceCompromised) {
      throw new Error('Reconnect this Agent before making another protected request.');
    }
    if ((request.body?.byteLength ?? 0) > MAX_SIGNED_REQUEST_BYTES) {
      throw new Error('The router request is too large for installation signing.');
    }
    const allowed =
      (request.method === 'GET' && request.path === '/v1/profile' && request.body === undefined) ||
      (request.method === 'POST' &&
        request.path === '/v1/agent/turn' &&
        request.body !== undefined);
    if (!allowed) throw new Error('The requested router operation is not signable.');
    const record = await this.requireInstallation();
    const access = await this.ensureAccess(record);
    if (request.signal?.aborted) throw request.signal.reason;
    return this.protectedHeaders(
      record,
      access.token,
      request.method,
      request.path,
      request.body,
      request.nonce
    );
  }

  public async diagnostics(signal?: AbortSignal): Promise<RouterDiagnostics> {
    const publicConfiguration = await this.configuration.get();
    if (publicConfiguration.authentication.mode === 'custom_bearer') {
      return this.configuration.statusCustom();
    }
    if (publicConfiguration.authentication.mode !== 'installation') {
      return {
        health: false,
        authenticated: false,
        mode: 'unknown',
        models: publicConfiguration.models,
        catalog: publicConfiguration.catalog,
        modelsStale: publicConfiguration.models.length > 0,
        checkedAt: new Date(this.now()).toISOString(),
        error:
          publicConfiguration.authentication.mode === 'legacy_hosted'
            ? 'Reconnect this Agent with installation approval; copied hosted API keys are no longer used.'
            : 'AdRouter is not configured.',
        authentication: publicConfiguration.authentication,
      };
    }
    try {
      const client = new AdRouterClient({
        serverUrl: publicConfiguration.serverUrl,
        authentication: { mode: 'installation', authorize: (request) => this.authorize(request) },
        fetchFn: this.fetchFn,
      });
      const diagnostics = await client.diagnostics(signal);
      if (diagnostics.models.length > 0 && diagnostics.catalog.compatibility === 'compatible') {
        await this.configuration.updateModels(
          diagnostics.models,
          diagnostics.catalog,
          diagnostics.checkedAt
        );
      } else {
        await this.configuration.noteCatalogFailure(diagnostics.catalog, diagnostics.checkedAt);
      }
      if (diagnostics.error?.includes('(426)')) {
        await this.configuration.markReconnectRequired(
          diagnostics.authentication.minimumClientVersion,
          true
        );
      } else if (diagnostics.error?.includes('(401)')) {
        await this.configuration.markReconnectRequired();
        this.clearMemory();
      }
      const latest = await this.configuration.get();
      return {
        ...diagnostics,
        models: diagnostics.models.length > 0 ? diagnostics.models : latest.models,
        modelsStale: diagnostics.models.length === 0 && latest.models.length > 0,
        catalog:
          diagnostics.models.length > 0
            ? diagnostics.catalog
            : {
                ...latest.catalog,
                source: 'cache',
                freshness: latest.models.length > 0 ? 'stale' : latest.catalog.freshness,
                compatibility: diagnostics.catalog.compatibility,
                lastAttemptAt: diagnostics.checkedAt,
                errorCode: diagnostics.catalog.errorCode,
              },
        authentication: latest.authentication,
      };
    } catch (error) {
      const checkedAt = new Date(this.now()).toISOString();
      await this.configuration.noteCatalogFailure(
        {
          ...publicConfiguration.catalog,
          source: 'cache',
          freshness: publicConfiguration.models.length > 0 ? 'stale' : 'bundled',
          lastAttemptAt: checkedAt,
          errorCode: 'catalog_unreachable',
        },
        checkedAt
      );
      const latest = await this.configuration.get();
      return {
        health: false,
        authenticated: false,
        mode: 'unknown',
        models: latest.models,
        catalog: {
          ...latest.catalog,
          source: 'cache',
          freshness: latest.models.length > 0 ? 'stale' : 'bundled',
          lastAttemptAt: checkedAt,
          errorCode: 'catalog_unreachable',
        },
        modelsStale: latest.models.length > 0,
        checkedAt,
        error: error instanceof Error ? error.message : 'AdRouter authentication failed.',
        authentication: latest.authentication,
      };
    }
  }

  public async signOut(): Promise<SignOutResult> {
    if (this.continueFlight) await this.continueFlight;
    this.pollController?.abort();
    this.pollController = undefined;
    this.prepared = undefined;
    const pending = await this.configuration.getPendingEnrollment().catch(() => undefined);
    await this.configuration.clearPendingEnrollment().catch(() => undefined);
    if (pending) await this.cancelPendingAuthorization(pending);
    let remoteRevocationConfirmed = false;
    try {
      const record = await this.configuration.getInstallationRecord();
      if (record) {
        const access = await this.ensureAccess(record);
        const body = exactJsonBytes({ installation_id: record.installationId });
        const response = await this.fetchFn(`${record.origin}/v1/installation/revoke`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.protectedHeaders(record, access.token, 'POST', '/v1/installation/revoke', body),
          },
          body: Buffer.from(body),
          redirect: 'manual',
        });
        remoteRevocationConfirmed =
          response.ok || response.status === 404 || response.status === 410;
      }
    } catch {
      remoteRevocationConfirmed = false;
    } finally {
      this.clearMemory();
    }
    const configuration = await this.configuration.signOutLocal();
    this.persistenceCompromised = false;
    return {
      configuration,
      remoteRevocationConfirmed,
    };
  }

  public dispose(): void {
    this.pollController?.abort();
    this.pollController = undefined;
    this.prepared = undefined;
    this.clearMemory();
  }

  private beginPolling(pending: PendingEnrollmentRecord): void {
    this.pollController?.abort();
    const controller = new AbortController();
    this.pollController = controller;
    void this.pollLoop(pending, controller.signal).finally(() => {
      if (this.pollController === controller) this.pollController = undefined;
    });
  }

  private async pollLoop(initial: PendingEnrollmentRecord, signal: AbortSignal): Promise<void> {
    let pending = initial;
    while (!signal.aborted && Date.parse(pending.expiresAt) > this.now()) {
      const wait = Math.max(0, Date.parse(pending.nextPollAt) - this.now());
      try {
        await delay(wait, undefined, { signal });
      } catch {
        return;
      }
      if (signal.aborted) return;
      try {
        const result = await this.pollOnce(pending, signal);
        if (result === 'approved') return;
        if (result === 'denied' || result === 'expired' || result === 'failed') {
          await this.configuration.clearPendingEnrollment();
          await this.cancelPendingAuthorization(pending);
          return;
        }
        pending = (await this.configuration.getPendingEnrollment()) ?? pending;
      } catch {
        const nextDelay = Math.min(30, Math.max(5, pending.intervalSeconds * 2));
        pending = {
          ...pending,
          intervalSeconds: nextDelay,
          nextPollAt: new Date(this.now() + nextDelay * 1_000).toISOString(),
        };
        await this.configuration.savePendingEnrollment(pending).catch(() => undefined);
        this.statusValue = safeStatus(
          pending,
          'pending',
          'Approval is still pending; AdRouter will retry safely.'
        );
      }
    }
    if (!signal.aborted) {
      await this.configuration.clearPendingEnrollment();
      await this.cancelPendingAuthorization(pending);
      this.statusValue = safeStatus(
        pending,
        'expired',
        'Approval expired. Start again to reconnect.'
      );
    }
  }

  private async pollOnce(
    pending: PendingEnrollmentRecord,
    signal: AbortSignal
  ): Promise<'pending' | 'approved' | 'denied' | 'expired' | 'failed'> {
    const body = exactJsonBytes({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: pending.deviceCode,
      client_kind: DESKTOP_CLIENT_KIND,
    });
    const response = await this.signedFetch({
      origin: pending.origin,
      path: '/v1/oauth/token',
      body,
      privateJwk: pending.privateJwk,
      signal,
    });
    if (response.ok) {
      const parsedToken = TokenResponseSchema.safeParse(await this.readJson(response));
      if (!parsedToken.success) {
        this.statusValue = safeStatus(
          pending,
          'failed',
          'AdRouter returned an invalid installation token response.'
        );
        return 'failed';
      }
      const token = parsedToken.data;
      const scopes = this.parseScopes(token);
      const familyExpiresAt = this.familyExpiry(token);
      const record: InstallationRecord = {
        version: 1,
        privateJwk: pending.privateJwk,
        refreshToken: token.refresh_token,
        installationId: token.installation_id,
        scopes,
        origin: pending.origin,
        clientKind: DESKTOP_CLIENT_KIND,
        clientVersion: pending.clientVersion,
        familyExpiresAt,
        displayName: pending.displayName,
        keyThumbprint: generateThumbprint(pending),
        storageClassification: 'os_encrypted',
      };
      const candidateAccess = {
        token: token.access_token,
        expiresAt: this.now() + token.expires_in * 1_000,
      };
      const diagnostics = await this.diagnosticsWithRecord(record, candidateAccess.token, signal);
      if (
        !diagnostics.authenticated ||
        diagnostics.models.length === 0 ||
        diagnostics.catalog.compatibility !== 'compatible'
      ) {
        this.statusValue = safeStatus(
          pending,
          'failed',
          'Approval completed, but the signed profile check failed. Reconnect this Agent.'
        );
        return 'failed';
      }
      await this.configuration.completeEnrollment(
        record,
        diagnostics.models,
        diagnostics.catalog,
        diagnostics.checkedAt
      );
      this.access = candidateAccess;
      this.persistenceCompromised = false;
      this.statusValue = safeStatus(pending, 'approved', 'This Agent is connected.');
      return 'approved';
    }
    const parsed = OAuthErrorSchema.safeParse(await this.readJson(response).catch(() => ({})));
    if (!parsed.success) {
      this.statusValue = safeStatus(
        pending,
        'failed',
        'AdRouter returned an invalid approval response.'
      );
      return 'failed';
    }
    if (parsed.data.code === 'authorization_pending') {
      await this.scheduleNextPoll(pending, pending.intervalSeconds);
      return 'pending';
    }
    if (parsed.data.code === 'slow_down') {
      await this.scheduleNextPoll(pending, Math.min(30, pending.intervalSeconds + 5));
      return 'pending';
    }
    if (parsed.data.code === 'access_denied') {
      this.statusValue = safeStatus(pending, 'denied', 'Installation approval was denied.');
      return 'denied';
    }
    if (parsed.data.code === 'expired_token') {
      this.statusValue = safeStatus(pending, 'expired', 'Installation approval expired.');
      return 'expired';
    }
    if (parsed.data.code === 'client_upgrade_required' || response.status === 426) {
      const minimum = this.minimumClientVersion(response);
      this.statusValue = safeStatus(
        pending,
        'failed',
        minimum
          ? `AdRouter Agent ${minimum} or newer is required.`
          : 'This AdRouter Agent version must be upgraded.'
      );
      return 'failed';
    }
    this.statusValue = safeStatus(pending, 'failed', 'Reconnect this Agent to continue.');
    return 'failed';
  }

  private async diagnosticsWithRecord(
    record: InstallationRecord,
    accessToken: string,
    signal: AbortSignal
  ): Promise<RouterDiagnostics> {
    const client = new AdRouterClient({
      serverUrl: record.origin,
      authentication: {
        mode: 'installation',
        authorize: async (request) => {
          return this.protectedHeaders(
            record,
            accessToken,
            request.method,
            request.path,
            request.body,
            request.nonce
          );
        },
      },
      fetchFn: this.fetchFn,
    });
    return client.diagnostics(signal);
  }

  private async scheduleNextPoll(
    pending: PendingEnrollmentRecord,
    intervalSeconds: number
  ): Promise<void> {
    const updated = {
      ...pending,
      intervalSeconds,
      nextPollAt: new Date(this.now() + intervalSeconds * 1_000).toISOString(),
    };
    await this.configuration.savePendingEnrollment(updated);
    this.statusValue = safeStatus(updated);
  }

  private async ensureAccess(record: InstallationRecord): Promise<AccessState> {
    if (Date.parse(record.familyExpiresAt) <= this.now()) {
      await this.configuration.markReconnectRequired();
      throw new Error('This installation expired. Reconnect this Agent.');
    }
    if (this.access && this.access.expiresAt - REFRESH_SKEW_MS > this.now()) return this.access;
    if (!this.refreshFlight) {
      this.refreshFlight = this.refresh(record).finally(() => {
        this.refreshFlight = undefined;
      });
    }
    return this.refreshFlight;
  }

  private async refresh(record: InstallationRecord): Promise<AccessState> {
    const body = exactJsonBytes({
      grant_type: 'refresh_token',
      refresh_token: record.refreshToken,
      installation_id: record.installationId,
    });
    const response = await this.signedFetch({
      origin: record.origin,
      path: '/v1/oauth/token',
      body,
      privateJwk: record.privateJwk,
    });
    if (!response.ok) {
      const failure = await this.readPlatformError(response);
      const upgradeRequired =
        response.status === 426 || failure?.code === 'client_upgrade_required';
      await this.configuration.markReconnectRequired(
        upgradeRequired ? this.minimumClientVersion(response) : null,
        upgradeRequired
      );
      this.clearMemory();
      throw new Error(
        upgradeRequired
          ? 'This AdRouter Agent version must be upgraded before reconnecting.'
          : 'This installation must be reconnected.'
      );
    }
    const parsedToken = TokenResponseSchema.safeParse(await this.readJson(response));
    if (!parsedToken.success) {
      await this.configuration.markReconnectRequired();
      this.clearMemory();
      throw new Error('AdRouter returned an invalid installation refresh.');
    }
    const token = parsedToken.data;
    if (token.installation_id !== record.installationId) {
      await this.configuration.markReconnectRequired();
      throw new Error('AdRouter returned a mismatched installation refresh.');
    }
    const rotated: InstallationRecord = {
      ...record,
      refreshToken: token.refresh_token,
      scopes: this.parseScopes(token),
      familyExpiresAt: this.familyExpiry(token),
    };
    try {
      await this.configuration.rotateInstallation(rotated);
    } catch {
      this.clearMemory();
      this.persistenceCompromised = true;
      await this.configuration.signOutLocal().catch(() => undefined);
      throw new Error('The rotated installation could not be stored. Reconnect this Agent.');
    }
    const access = { token: token.access_token, expiresAt: this.now() + token.expires_in * 1_000 };
    this.access = access;
    return access;
  }

  private protectedHeaders(
    record: InstallationRecord,
    accessToken: string,
    method: 'GET' | 'POST',
    path: string,
    body: Uint8Array | undefined,
    nonce?: string
  ): ProtectedRouterHeaders {
    const proof = createDpopProof({
      privateJwk: record.privateJwk,
      method,
      url: `${record.origin}${path}`,
      ...(body ? { body } : {}),
      clientVersion: this.clientVersion,
      accessToken,
      nonce,
    });
    return {
      Authorization: `DPoP ${accessToken}`,
      DPoP: proof,
      ...(body ? { 'Content-Digest': contentDigest(body) } : {}),
    };
  }

  private async signedFetch(input: {
    origin: string;
    path: '/v1/device/authorizations' | typeof DEVICE_AUTHORIZATION_CANCEL_PATH | '/v1/oauth/token';
    body: Uint8Array;
    privateJwk: InstallationRecord['privateJwk'];
    nonce?: string;
    signal?: AbortSignal;
  }): Promise<Response> {
    const makeRequest = (nonce?: string): Promise<Response> =>
      this.fetchFn(`${input.origin}${input.path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Digest': contentDigest(input.body),
          DPoP: createDpopProof({
            privateJwk: input.privateJwk,
            method: 'POST',
            url: `${input.origin}${input.path}`,
            body: input.body,
            clientVersion: this.clientVersion,
            nonce,
          }),
        },
        body: Buffer.from(input.body),
        redirect: 'manual',
        signal: input.signal,
      });
    let response = await makeRequest(input.nonce);
    this.rejectRedirect(response);
    const challenge = this.validNonce(response);
    if (response.status === 401 && challenge && !input.nonce) {
      response = await makeRequest(challenge);
      this.rejectRedirect(response);
    }
    return response;
  }

  private validNonce(response: Response): string | undefined {
    const nonce = response.headers.get('DPoP-Nonce') ?? undefined;
    if (!nonce) return undefined;
    if (nonce.length > 1_024 || /[^\x21-\x7E]/.test(nonce)) {
      throw new Error('AdRouter returned an invalid proof nonce.');
    }
    return nonce;
  }

  private rejectRedirect(response: Response): void {
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Authenticated router redirects are not allowed.');
    }
  }

  private minimumClientVersion(response: Response): string | null {
    const value = response.headers.get('AdRouter-Minimum-Version');
    if (!value || value.length > 100) return null;
    return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value
    )
      ? value
      : null;
  }

  private async readPlatformError(
    response: Response
  ): Promise<z.infer<typeof OAuthErrorSchema> | undefined> {
    const parsed = OAuthErrorSchema.safeParse(await this.readJson(response).catch(() => ({})));
    return parsed.success ? parsed.data : undefined;
  }

  private async responseError(response: Response, fallback: string): Promise<Error> {
    const parsed = await this.readPlatformError(response);
    if (response.status === 426 || parsed?.code === 'client_upgrade_required') {
      const minimum = this.minimumClientVersion(response);
      return new Error(
        minimum
          ? `AdRouter Agent ${minimum} or newer is required.`
          : 'This AdRouter Agent version must be upgraded.'
      );
    }
    if (parsed?.code === 'client_not_allowed') {
      return new Error('This Agent client is not allowed by the selected AdRouter server.');
    }
    if (parsed?.code === 'developer_required') {
      return new Error('Sign in to AdRouter and finish developer registration before continuing.');
    }
    if (parsed?.code === 'installation_not_allowed') {
      return new Error('This AdRouter account cannot create another installation.');
    }
    if (parsed?.code === 'invalid_access_token') {
      return new Error('Your AdRouter sign-in expired. Sign in again and retry.');
    }
    if (parsed?.code === 'rate_limited') {
      return new Error('AdRouter is receiving too many installation requests. Try again shortly.');
    }
    if (parsed?.code === 'invalid_dpop_proof') {
      const serverDate = response.headers.get('date');
      const clockHint = serverDate ? " Check that this computer's clock is correct." : '';
      return new Error(`AdRouter rejected this device proof.${clockHint}`);
    }
    return new Error(fallback);
  }

  private async readJson(response: Response): Promise<unknown> {
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_AUTH_RESPONSE_BYTES) {
      throw new Error('AdRouter returned an oversized authentication response.');
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_AUTH_RESPONSE_BYTES) {
      throw new Error('AdRouter returned an oversized authentication response.');
    }
    return JSON.parse(text);
  }

  private parseScopes(token: z.infer<typeof TokenResponseSchema>): InstallationRecord['scopes'] {
    const values = token.scope.split(/\s+/).filter(Boolean);
    if (!INSTALLATION_SCOPES.every((scope) => values.includes(scope))) {
      throw new Error('AdRouter returned insufficient installation scopes.');
    }
    return [...INSTALLATION_SCOPES];
  }

  private familyExpiry(token: z.infer<typeof TokenResponseSchema>): string {
    return new Date(this.now() + token.refresh_expires_in * 1_000).toISOString();
  }

  private async requireInstallation(): Promise<InstallationRecord> {
    const record = await this.configuration.getInstallationRecord();
    if (!record) throw new Error('Reconnect this Agent before using hosted AdRouter.');
    if (classifyRouterOrigin(record.origin) !== 'official') {
      throw new Error('Installation authentication is restricted to official AdRouter origins.');
    }
    return record;
  }

  private async discardActiveEnrollment(): Promise<void> {
    this.pollController?.abort();
    this.pollController = undefined;
    this.prepared = undefined;
    const pending = await this.configuration.getPendingEnrollment().catch(() => undefined);
    await this.configuration.clearPendingEnrollment().catch(() => undefined);
    if (pending) await this.cancelPendingAuthorization(pending);
  }

  private async cancelPendingAuthorization(pending: PendingEnrollmentRecord): Promise<boolean> {
    const body = exactJsonBytes({
      device_code: pending.deviceCode,
      client_kind: DESKTOP_CLIENT_KIND,
    });
    try {
      const response = await this.signedFetch({
        origin: pending.origin,
        path: DEVICE_AUTHORIZATION_CANCEL_PATH,
        body,
        privateJwk: pending.privateJwk,
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  private clearMemory(): void {
    this.access = undefined;
    this.refreshFlight = undefined;
  }
}

const generateThumbprint = (pending: PendingEnrollmentRecord): string => {
  const publicJwk = publicJwkFromPrivate(pending.privateJwk);
  return jwkThumbprint(publicJwk);
};
