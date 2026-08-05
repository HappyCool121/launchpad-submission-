import type { Context, Tool } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { classifyRouterOrigin } from '../shared/constants';
import type {
  InstallationDiagnostics,
  RouterDiagnostics,
  RouterModelDescriptor,
  RuntimeMode,
  ThinkingLevel,
} from '../shared/contracts';
import {
  liveCatalogStatus,
  ModelCatalogError,
  unavailableCatalogStatus,
  validateLiveCatalog,
} from '../shared/model-catalog';
import { containsSponsorKey, removeSponsorData } from '../shared/security';
import { NdjsonParser, type RouterStreamEvent } from './ndjson';

const ProfileSchema = z.object({}).passthrough();
const HealthSchema = z.object({ mode: z.enum(['live', 'mock']).optional() }).passthrough();
const MAX_ROUTER_ERROR_BYTES = 32 * 1024;
const MAX_ROUTER_ERROR_DETAILS = 16;
const RouterErrorEnvelopeSchema = z
  .object({
    error: z.string().min(1).max(1_000).optional(),
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
    details: z.record(z.string().min(1).max(64), z.unknown()).optional(),
  })
  .passthrough();

export type RouterErrorDetails = Readonly<Record<string, number>>;
export class RouterHttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly minimumClientVersion: string | null = null,
    public readonly code: string | null = null,
    public readonly details: RouterErrorDetails = {}
  ) {
    super(message);
    this.name = 'RouterHttpError';
  }
}

const readRouterError = async (
  response: Response
): Promise<{ message: string | null; code: string | null; details: RouterErrorDetails }> => {
  if (!response.body) return { message: null, code: null, details: {} };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_ROUTER_ERROR_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { message: null, code: null, details: {} };
      }
      chunks.push(value);
    }
  } catch {
    return { message: null, code: null, details: {} };
  }
  try {
    const parsed = RouterErrorEnvelopeSchema.parse(
      JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'))
    );
    const details = Object.fromEntries(
      Object.entries(parsed.details ?? {})
        .filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === 'number' &&
            Number.isFinite(entry[1]) &&
            Math.abs(entry[1]) <= Number.MAX_SAFE_INTEGER
        )
        .slice(0, MAX_ROUTER_ERROR_DETAILS)
    );
    return { message: parsed.error ?? null, code: parsed.code ?? null, details };
  } catch {
    return { message: null, code: null, details: {} };
  }
};

export interface RouterClientOptions {
  serverUrl: string;
  authentication:
    | { mode: 'custom_bearer'; token: string }
    | {
        mode: 'installation';
        authorize: (request: ProtectedRouterRequest) => Promise<ProtectedRouterHeaders>;
      };
  fetchFn?: typeof fetch;
}

export interface ProtectedRouterHeaders {
  Authorization: string;
  DPoP: string;
  'Content-Digest'?: string;
}

export interface ProtectedRouterRequest {
  method: 'GET' | 'POST';
  path: '/v1/profile' | '/v1/agent/turn';
  body?: Uint8Array;
  nonce?: string;
  signal?: AbortSignal;
}

export interface RouterTurnInput {
  model: string;
  thinkingLevel: ThinkingLevel;
  runtimeMode: RuntimeMode;
  messages: Context['messages'];
  tools: Tool[];
  systemPrompt?: string;
  projectDisplayName: string;
  adsEnabled: boolean;
}

const normalizeServerUrl = (input: string): string => input.replace(/\/+$/, '');

const minimumClientVersion = (response: Response): string | null => {
  const value = response.headers.get('AdRouter-Minimum-Version');
  if (!value || value.length > 100) return null;
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    value
  )
    ? value
    : null;
};

const getMessageText = (context: Context): unknown[] =>
  context.messages.map((message) => {
    if (message.role === 'user') {
      return { role: 'user', content: message.content };
    }
    if (message.role === 'toolResult') {
      return {
        role: 'toolResult',
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content,
        isError: message.isError,
      };
    }
    return {
      role: 'assistant',
      content: message.content,
    };
  });

export class AdRouterClient {
  private readonly fetchFn: typeof fetch;
  private readonly serverUrl: string;

  public constructor(private readonly options: RouterClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.serverUrl = normalizeServerUrl(options.serverUrl);
  }

  private authenticationDiagnostics(
    authenticated: boolean,
    requiredVersion: string | null = null
  ): InstallationDiagnostics {
    const installation = this.options.authentication.mode === 'installation';
    const originClass = classifyRouterOrigin(this.serverUrl);
    return {
      mode: installation ? 'installation' : 'custom_bearer',
      state: authenticated && installation ? 'connected' : 'none',
      originClass,
      storageClassification: installation ? 'os_encrypted' : null,
      signedRequestSupport: installation,
      refreshHealthy: authenticated && installation,
      pendingEnrollment: false,
      reconnectRequired: installation && !authenticated,
      installationIdSuffix: null,
      scopes: installation ? ['agent:turn', 'profile:read'] : [],
      familyExpiresAt: null,
      minimumClientVersion: requiredVersion,
      policyMode: null,
    };
  }

  private async protectedFetch(
    path: ProtectedRouterRequest['path'],
    method: ProtectedRouterRequest['method'],
    body: Uint8Array | undefined,
    headers: Record<string, string>,
    signal?: AbortSignal
  ): Promise<Response> {
    if ((method === 'POST' && !body) || (method === 'GET' && body)) {
      throw new Error('The protected router request has an invalid body binding.');
    }
    const authentication = this.options.authentication;
    let authorizationHeaders: ProtectedRouterHeaders | { Authorization: string };
    if (authentication.mode === 'custom_bearer') {
      authorizationHeaders = { Authorization: `Bearer ${authentication.token}` };
    } else {
      const protectedHeaders = await authentication.authorize({ method, path, body, signal });
      if (
        (method === 'GET' && protectedHeaders['Content-Digest'] !== undefined) ||
        (method === 'POST' && protectedHeaders['Content-Digest'] === undefined)
      ) {
        throw new Error('The installation signer returned an invalid body binding.');
      }
      authorizationHeaders = protectedHeaders;
    }
    const request = (
      protectedHeaders: ProtectedRouterHeaders | { Authorization: string }
    ): Promise<Response> =>
      this.fetchFn(`${this.serverUrl}${path}`, {
        method,
        headers: { ...headers, ...protectedHeaders },
        ...(body ? { body: Buffer.from(body) } : {}),
        redirect: 'manual',
        signal,
      });
    let response = await request(authorizationHeaders);
    if (response.status >= 300 && response.status < 400) {
      throw new RouterHttpError(response.status, 'Authenticated router redirects are not allowed.');
    }
    const nonce = response.headers.get('DPoP-Nonce');
    if (nonce && (nonce.length > 1_024 || /[^\x21-\x7E]/.test(nonce))) {
      throw new RouterHttpError(401, 'AdRouter returned an invalid proof nonce.');
    }
    if (authentication.mode === 'installation' && response.status === 401 && nonce) {
      const retryHeaders = await authentication.authorize({ method, path, body, nonce, signal });
      if (
        (method === 'GET' && retryHeaders['Content-Digest'] !== undefined) ||
        (method === 'POST' && retryHeaders['Content-Digest'] === undefined)
      ) {
        throw new Error('The installation signer returned an invalid body binding.');
      }
      response = await request(retryHeaders);
      if (response.status >= 300 && response.status < 400) {
        throw new RouterHttpError(
          response.status,
          'Authenticated router redirects are not allowed.'
        );
      }
    }
    return response;
  }

  public async diagnostics(signal?: AbortSignal): Promise<RouterDiagnostics> {
    const checkedAt = new Date().toISOString();
    let health: Response;
    try {
      health = await this.fetchFn(`${this.serverUrl}/health`, { signal });
    } catch (error) {
      return {
        health: false,
        authenticated: false,
        mode: 'unknown',
        models: [],
        catalog: unavailableCatalogStatus(checkedAt, 'catalog_unreachable'),
        modelsStale: false,
        checkedAt,
        error: error instanceof Error ? error.message : 'AdRouter is unreachable.',
        authentication: this.authenticationDiagnostics(false),
      };
    }
    if (!health.ok) {
      return {
        health: false,
        authenticated: false,
        mode: 'unknown',
        models: [],
        catalog: unavailableCatalogStatus(checkedAt, 'catalog_http_error'),
        modelsStale: false,
        checkedAt,
        error: `AdRouter health check failed (${health.status}).`,
        authentication: this.authenticationDiagnostics(false),
      };
    }
    const healthPayload = HealthSchema.parse(await health.json());

    let models: RouterModelDescriptor[] = [];
    let catalog = unavailableCatalogStatus(checkedAt, 'catalog_unreachable');
    let catalogError: string | null = null;
    try {
      const modelsResponse = await this.fetchFn(`${this.serverUrl}/v1/models`, {
        redirect: 'manual',
        signal,
      });
      if (modelsResponse.status >= 300 && modelsResponse.status < 400) {
        throw new ModelCatalogError(
          'catalog_invalid',
          'AdRouter model discovery redirects are not allowed.'
        );
      }
      if (!modelsResponse.ok) {
        catalog = unavailableCatalogStatus(checkedAt, 'catalog_http_error');
        catalogError = `AdRouter model discovery failed (${modelsResponse.status}).`;
      } else {
        const validated = validateLiveCatalog(
          await modelsResponse.json(),
          classifyRouterOrigin(this.serverUrl) === 'official'
        );
        models = validated.models;
        catalog = liveCatalogStatus(validated, checkedAt);
      }
    } catch (error) {
      if (error instanceof ModelCatalogError) {
        catalog = unavailableCatalogStatus(
          checkedAt,
          error.code,
          error.code === 'catalog_incompatible' || error.code === 'catalog_invalid'
        );
        catalogError = error.message;
      } else {
        catalog = unavailableCatalogStatus(checkedAt, 'catalog_unreachable');
        catalogError = error instanceof Error ? error.message : 'AdRouter model discovery failed.';
      }
    }

    try {
      const profile = await this.protectedFetch('/v1/profile', 'GET', undefined, {}, signal);
      if (!profile.ok) {
        return {
          health: true,
          authenticated: false,
          mode: healthPayload.mode ?? 'unknown',
          models,
          catalog,
          modelsStale: false,
          checkedAt,
          error: `AdRouter authentication failed (${profile.status}).`,
          authentication: this.authenticationDiagnostics(
            false,
            profile.status === 426 ? minimumClientVersion(profile) : null
          ),
        };
      }
      ProfileSchema.parse(await profile.json());
    } catch (error) {
      return {
        health: true,
        authenticated: false,
        mode: healthPayload.mode ?? 'unknown',
        models,
        catalog,
        modelsStale: false,
        checkedAt,
        error: error instanceof Error ? error.message : 'AdRouter authentication failed.',
        authentication: this.authenticationDiagnostics(false),
      };
    }

    return {
      health: true,
      authenticated: true,
      mode: healthPayload.mode ?? 'unknown',
      models,
      catalog,
      modelsStale: false,
      checkedAt,
      error: models.length > 0 ? null : (catalogError ?? 'AdRouter returned no models.'),
      authentication: this.authenticationDiagnostics(true),
    };
  }

  public async *turn(
    input: RouterTurnInput,
    signal?: AbortSignal
  ): AsyncGenerator<RouterStreamEvent> {
    const requestBody = {
      model: input.model,
      thinking_level: input.thinkingLevel,
      ...(input.runtimeMode === 'auto' ? {} : { runtime_mode: input.runtimeMode }),
      context: removeSponsorData({
        systemPrompt: input.systemPrompt,
        messages: getMessageText({ messages: input.messages }),
        tools: input.tools,
      }),
      metadata: {
        client: 'adrouter-agent-desktop',
        workspace: input.projectDisplayName,
        ads_enabled: input.adsEnabled,
      },
    };

    if (containsSponsorKey(requestBody.context)) {
      throw new Error('Sponsor data was rejected before reaching the router model context.');
    }

    const requestBytes = Buffer.from(JSON.stringify(requestBody), 'utf8');
    const response = await this.protectedFetch(
      '/v1/agent/turn',
      'POST',
      requestBytes,
      {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson, application/json',
      },
      signal
    );
    if (!response.ok) {
      const envelope = await readRouterError(response);
      throw new RouterHttpError(
        response.status,
        response.status === 426
          ? 'This AdRouter Agent version must be upgraded before reconnecting.'
          : (envelope.message ?? `AdRouter returned ${response.status}.`),
        response.status === 426 ? minimumClientVersion(response) : null,
        envelope.code,
        envelope.details
      );
    }
    if (!response.body) {
      throw new Error('AdRouter returned no response body.');
    }

    const reader = response.body.getReader();
    const parser = new NdjsonParser();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const parsed = parser.push(value);
      for (const parseError of parsed.errors) {
        yield { type: 'error', message: parseError, code: 'malformed_event' };
      }
      yield* parsed.events;
    }
    const final = parser.finish();
    for (const parseError of final.errors) {
      yield { type: 'error', message: parseError, code: 'malformed_event' };
    }
    yield* final.events;
  }
}
