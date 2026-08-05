import { randomUUID } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import type pg from 'pg';
import { computeCostBreakdown } from '../lib/pricing.js';
import type { ProviderId, Settlement, ThinkingLevel } from '../lib/types.js';
import { defaultModel, providerForModel, resolveModel, resolveThinkingForModel, tokenLimitsForModel, type ModelTokenLimits } from '../lib/modelRegistry.js';
import { getProvider } from '../lib/providers/registry.js';
import { getRuntimeConfig } from './config.js';
import { principalFrom, type Principal } from './auth.js';
import { getPostgresPool } from './postgres.js';
import { activeRequestCount, releaseReservation, trackReservation } from './state.js';
import { logMetric } from './logging.js';
import { recordAdmissionRejection, recordProviderError, recordRecoveryRequired, refreshOperationalMetrics, setActiveRequests } from './metrics.js';
import { estimateProviderInputTokens } from './input-tokens.js';

export interface Admission {
  reservationId: string;
  principal: Principal;
  model: string;
  provider: ProviderId;
  thinkingLevel: ThinkingLevel;
  maxOutputTokens: number;
  abortController: AbortController;
  deadline: NodeJS.Timeout;
}

export class AdmissionError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string, public readonly details?: Record<string, number>) { super(message); }
}

function modelFromBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return defaultModel();
  const root = body as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(root, 'model') ? root.model : defaultModel();
}

function modelLimitDetails(descriptor: ModelTokenLimits): Record<string, number> {
  return {
    context_window: descriptor.context_window,
    max_input_tokens: descriptor.max_input_tokens,
    max_output_tokens: descriptor.max_output_tokens,
  };
}

export function maxOutputFromBody(body: unknown, descriptor: ModelTokenLimits, accountMax?: number): number {
  const config = getRuntimeConfig();
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>).max_output_tokens : undefined;
  const allowed = Math.min(descriptor.max_output_tokens, config.maxOutputTokens, accountMax ?? Number.MAX_SAFE_INTEGER);
  const requested = value === undefined ? config.defaultOutputTokens : value;
  if (!Number.isSafeInteger(requested) || (requested as number) < 1 || (requested as number) > allowed) {
    throw new AdmissionError('output_limit_exceeded', 400, `max_output_tokens must be between 1 and ${allowed} for ${descriptor.id}.`, {
      ...modelLimitDetails(descriptor),
      allowed_output_tokens: allowed,
      requested_output_tokens: typeof requested === 'number' && Number.isFinite(requested) ? requested : 0,
    });
  }
  return requested as number;
}

export function assertInputLimit(inputTokens: number, descriptor: ModelTokenLimits): void {
  const config = getRuntimeConfig();
  const allowed = Math.min(descriptor.max_input_tokens, config.maxInputTokens);
  if (inputTokens > allowed) {
    throw new AdmissionError('input_limit_exceeded', 413, `Input exceeds the token limit for ${descriptor.id}.`, {
      estimated_input_tokens: inputTokens,
      ...modelLimitDetails(descriptor),
      allowed_input_tokens: allowed,
    });
  }
}

function worstCaseMicrousd(model: string, inputTokens: number, outputTokens: number): number {
  return Math.ceil(computeCostBreakdown({ model, inputTokens, promptTokens: inputTokens, cacheHitTokens: 0, outputTokens }).total * 1_000_000);
}

async function spent(client: pg.PoolClient, userId: string, interval: 'day' | 'month'): Promise<number> {
  const result = await client.query<{ total: string }>(
    `select coalesce(sum(cost_microusd), 0)::text as total from router.usage
      where user_id = $1 and created_at >= date_trunc($2, now())`, [userId, interval],
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function platformSpent(client: pg.PoolClient, interval: 'day' | 'month'): Promise<number> {
  const result = await client.query<{ total: string }>(
    `select coalesce(sum(cost_microusd), 0)::text as total from router.usage where created_at >= date_trunc($1, now())`, [interval],
  );
  return Number(result.rows[0]?.total ?? 0);
}

export async function reserve(principal: Principal, model: string, inputTokens: number, maxOutputTokens: number): Promise<string> {
  if (principal.authSource === 'api_credential' && !principal.credentialId) {
    throw new AdmissionError('invalid_api_key', 401, 'An API credential is required.');
  }
  if (principal.authSource === 'browser_jwt' && principal.credentialId) {
    throw new AdmissionError('invalid_access_token', 401, 'Browser authentication cannot use an API credential identifier.');
  }
  if (principal.authSource === 'installation' && (!principal.installationId || !principal.tokenFamilyId || principal.credentialId)) {
    throw new AdmissionError('invalid_access_token', 401, 'An active installation token family is required.');
  }
  const resolvedModel = resolveModel(model);
  const descriptor = resolvedModel ? tokenLimitsForModel(resolvedModel) : undefined;
  if (!resolvedModel || !descriptor) throw new AdmissionError('invalid_model', 400, `${model} is not a registered runnable model.`);
  if (!principal.allowedModels.includes(resolvedModel)) throw new AdmissionError('model_forbidden', 403, 'This model is not enabled for the account.');
  const config = getRuntimeConfig();
  const allowedOutput = Math.min(descriptor.max_output_tokens, config.maxOutputTokens, principal.maxOutputTokens);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > allowedOutput) {
    throw new AdmissionError('output_limit_exceeded', 400, 'Output exceeds the selected model, platform, or account token limit.', {
      ...modelLimitDetails(descriptor),
      allowed_output_tokens: allowedOutput,
      requested_output_tokens: maxOutputTokens,
    });
  }
  assertInputLimit(inputTokens, descriptor);
  const amount = worstCaseMicrousd(model, inputTokens, maxOutputTokens);
  const id = randomUUID();
  const client = await getPostgresPool().connect();
  try {
    await client.query('begin');
    const platformResult = await client.query<{ traffic_mode: string; max_concurrency: number; daily_limit_microusd: string; monthly_limit_microusd: string; active_requests: number }>(
      'select traffic_mode, max_concurrency, daily_limit_microusd, monthly_limit_microusd, active_requests from router.platform_settings where singleton = true for update',
    );
    const platform = platformResult.rows[0];
    if (!platform || platform.traffic_mode === 'disabled' || (platform.traffic_mode === 'owner_only' && principal.role !== 'owner')) {
      throw new AdmissionError('traffic_disabled', 503, 'Live router traffic is not currently admitting this account.');
    }
    const userResult = await client.query<{ status: string; max_concurrency: number; daily_limit_microusd: string; monthly_limit_microusd: string }>(
      'select status, max_concurrency, daily_limit_microusd, monthly_limit_microusd from router.beta_users where user_id = $1 for update', [principal.userId],
    );
    const user = userResult.rows[0];
    if (!user || user.status !== 'active') throw new AdmissionError('account_inactive', 403, 'The account is not active.');
    const activeResult = await client.query<{ count: string }>('select count(*)::text as count from router.reservations where user_id = $1 and status = $2', [principal.userId, 'reserved']);
    const userActive = Number(activeResult.rows[0]?.count ?? 0);
    if (userActive >= user.max_concurrency || platform.active_requests >= platform.max_concurrency) {
      throw new AdmissionError('concurrency_limit', 429, 'Concurrency limit reached.');
    }
    const reservedResult = await client.query<{ user_reserved: string; platform_reserved: string }>(
      `select coalesce(sum(reserved_microusd) filter (where user_id = $1), 0)::text as user_reserved,
              coalesce(sum(reserved_microusd), 0)::text as platform_reserved from router.reservations where status = 'reserved'`, [principal.userId],
    );
    const reserved = reservedResult.rows[0]!;
    const [userDay, userMonth, platformDay, platformMonth] = await Promise.all([
      spent(client, principal.userId, 'day'), spent(client, principal.userId, 'month'), platformSpent(client, 'day'), platformSpent(client, 'month'),
    ]);
    const userHeld = Number(reserved.user_reserved); const platformHeld = Number(reserved.platform_reserved);
    if (userDay + userHeld + amount > Number(user.daily_limit_microusd) || userMonth + userHeld + amount > Number(user.monthly_limit_microusd)) {
      throw new AdmissionError('user_budget_limit', 429, 'Account spend limit reached.');
    }
    if (platformDay + platformHeld + amount > Number(platform.daily_limit_microusd) || platformMonth + platformHeld + amount > Number(platform.monthly_limit_microusd)) {
      throw new AdmissionError('platform_budget_limit', 503, 'Platform spend limit reached.');
    }
    await client.query(`insert into router.reservations(
        id,user_id,credential_id,installation_id,token_family_id,auth_source,model,reserved_microusd
      ) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      id, principal.userId, principal.credentialId ?? null, principal.installationId ?? null,
      principal.tokenFamilyId ?? null, principal.authSource, model, amount,
    ]);
    await client.query('update router.platform_settings set active_requests = active_requests + 1, updated_at = now() where singleton = true');
    await client.query('commit');
    trackReservation(id);
    setActiveRequests(activeRequestCount());
    logMetric('AdRouter', { AdmissionAccepted: 1, ActiveRequests: platform.active_requests + 1 }, { Environment: config.environment });
    return id;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

function microusd(value: number): number {
  return Math.max(0, Math.round(value * 1_000_000));
}

export async function settleAdmission(admission: Admission, turnId: string, settlement: Settlement, outcome = 'success'): Promise<void> {
  const cost = microusd(settlement.prompt_cost);
  const client = await getPostgresPool().connect();
  try {
    await client.query('begin');
    const locked = await client.query<{ status: string }>('select status from router.reservations where id = $1 for update', [admission.reservationId]);
    if (locked.rows[0]?.status === 'reserved') {
      const event = await client.query<{ status: string }>(
        'select status from router.ad_events where turn_id=$1 and reservation_id=$2 for update',
        [turnId, admission.reservationId],
      );
      if (!event.rows[0] || !['pending', 'off'].includes(event.rows[0].status)) {
        throw new Error('settlement_correlation_missing: the turn is not linked to its reservation.');
      }
      await client.query(`insert into router.usage(
          reservation_id,user_id,installation_id,token_family_id,model,input_tokens,cache_hit_tokens,output_tokens,cost_microusd,outcome
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (reservation_id) do nothing`, [
        admission.reservationId, admission.principal.userId, admission.principal.installationId ?? null,
        admission.principal.tokenFamilyId ?? null, admission.model, settlement.cache_miss_tokens,
        settlement.cache_hit_tokens, settlement.output_tokens, cost, outcome,
      ]);
      await client.query(`update router.ad_events
        set status='settled',settled_at=now(),input_tokens=$3,cache_hit_tokens=$4,cache_miss_tokens=$5,
            output_tokens=$6,cost_microusd=$7,subsidy_microusd=$8,paid_microusd=$9
        where turn_id=$1 and reservation_id=$2`,
      [turnId, admission.reservationId, settlement.input_tokens, settlement.cache_hit_tokens, settlement.cache_miss_tokens,
        settlement.output_tokens, cost, microusd(settlement.ad_subsidy), microusd(settlement.paid)]);
      await client.query(`update router.reservations set status='settled', settled_microusd=$2, settled_at=now() where id=$1`, [admission.reservationId, cost]);
      await client.query('update router.platform_settings set active_requests = greatest(0, active_requests - 1), updated_at=now() where singleton=true');
    }
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); clearTimeout(admission.deadline); releaseReservation(admission.reservationId); setActiveRequests(activeRequestCount()); }
  logMetric('AdRouter', { SpendMicrousd: cost, InputTokens: settlement.input_tokens, OutputTokens: settlement.output_tokens }, { Environment: getRuntimeConfig().environment, Outcome: outcome, Provider: settlement.provider });
  await refreshOperationalMetrics().catch((error) => {
    console.warn('[adrouter] post-settlement metrics refresh failed:', error instanceof Error ? error.message : String(error));
  });
}

export async function releaseAdmission(admission: Admission, knownPreGeneration: boolean): Promise<void> {
  const target = knownPreGeneration ? 'released' : 'recovery_required';
  await getPostgresPool().query(`with changed as (
      update router.reservations set status=$2, recovery_marked_at=case when $2='recovery_required' then now() else null end
      where id=$1 and status='reserved' returning id
    ) update router.platform_settings set active_requests=greatest(0,active_requests-(select count(*) from changed)),updated_at=now() where singleton=true`, [admission.reservationId, target]);
  clearTimeout(admission.deadline); releaseReservation(admission.reservationId);
  setActiveRequests(activeRequestCount());
  if (!knownPreGeneration) recordRecoveryRequired(1, 'request_incomplete');
}

export const requireAdmission: RequestHandler = async (req, res, next) => {
  const config = getRuntimeConfig();
  try {
    const body = req.body as Record<string, unknown>;
    const requestedModel = modelFromBody(body);
    const model = resolveModel(requestedModel);
    if (!model) throw new AdmissionError('invalid_model', 400, typeof requestedModel === 'string'
      ? `${requestedModel} is not a registered runnable model.` : 'The requested model is not a registered runnable model.');
    const descriptor = tokenLimitsForModel(model);
    if (!descriptor) throw new AdmissionError('invalid_model', 400, `${model} is not a registered runnable model.`);
    const provider = providerForModel(model);
    const adapter = provider ? getProvider(provider) : undefined;
    if (!provider || !adapter) throw new AdmissionError('invalid_model', 400, `${model} is not a registered runnable model.`);
    const principal = config.serviceMode ? principalFrom(res) : undefined;
    if (principal && !principal.allowedModels.includes(model)) {
      throw new AdmissionError('model_forbidden', 403, 'This model is not enabled for the account.');
    }
    const maxOutputTokens = maxOutputFromBody(body, descriptor, principal?.maxOutputTokens);
    const inputTokens = estimateProviderInputTokens(body, provider);
    assertInputLimit(inputTokens, descriptor);
    let thinkingLevel: ThinkingLevel;
    try {
      thinkingLevel = resolveThinkingForModel(model, body.thinking_level, body.reasoning_effort);
    } catch (error) {
      throw new AdmissionError('unsupported_thinking_level', 400, error instanceof Error ? error.message : 'The thinking level is not supported.');
    }
    if (!config.serviceMode) {
      res.locals.thinkingLevel = thinkingLevel;
      res.locals.maxOutputTokens = maxOutputTokens;
      next();
      return;
    }
    if (!principal) throw new AdmissionError('admission_failed', 503, 'Request admission failed.');
    if (config.hosted || body.runtime_mode === 'live') {
      if (!config.liveTrafficEnabled || !adapter.configured()) throw new AdmissionError('live_not_enabled', 409, `Live traffic requires explicit operator enablement and ${provider} provider configuration.`);
      if (config.environment === 'local' && principal.authSource === 'api_credential' && principal.credentialEnvironment !== 'live') {
        throw new AdmissionError('live_credential_required', 403, 'Local paid traffic requires a live machine credential.');
      }
    }
    const reservationId = await reserve(principal, model, inputTokens, maxOutputTokens);
    const abortController = new AbortController();
    const deadline = setTimeout(() => abortController.abort(new Error('request_deadline_exceeded')), config.requestDeadlineMs);
    const admission: Admission = { reservationId, principal, model, provider, thinkingLevel, maxOutputTokens, abortController, deadline };
    res.locals.admission = admission;
    res.locals.thinkingLevel = thinkingLevel;
    res.locals.maxOutputTokens = maxOutputTokens;
    req.once('aborted', () => abortController.abort(new Error('client_disconnected')));
    res.once('close', () => { if (!res.writableEnded) abortController.abort(new Error('client_disconnected')); });
    next();
  } catch (error) {
    const rejection = error instanceof AdmissionError ? error : new AdmissionError('admission_failed', 503, 'Request admission failed.');
    if (config.serviceMode) {
      logMetric('AdRouter', { AdmissionRejected: 1 }, { Environment: config.environment, Reason: rejection.code });
      recordAdmissionRejection(rejection.code);
    }
    res.status(rejection.status).json({ error: rejection.message, code: rejection.code, ...(rejection.details ? { details: rejection.details } : {}) });
  }
};

export const rejectHostedExecutionControls: RequestHandler = (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  if (getRuntimeConfig().hosted
    && (Object.prototype.hasOwnProperty.call(body, 'runtime_mode') || Object.prototype.hasOwnProperty.call(body, 'tier_override'))) {
    res.status(400).json({
      error: 'Hosted execution is always live and does not accept runtime_mode or tier_override.',
      code: 'hosted_control_not_allowed',
    });
    return;
  }
  next();
};

export function admissionFrom(res: Response): Admission | undefined { return res.locals.admission as Admission | undefined; }
export async function releasePreGeneration(res: Response): Promise<void> { const admission = admissionFrom(res); if (admission) await releaseAdmission(admission, true); }

export async function markStaleReservations(): Promise<number> {
  const result = await getPostgresPool().query(`with stale as (
      update router.reservations set status='recovery_required', recovery_marked_at=now()
      where status='reserved' and created_at < now() - interval '15 minutes' returning id
    ), adjusted as (
      update router.platform_settings set active_requests=greatest(0,active_requests-(select count(*) from stale)),updated_at=now() where singleton=true
    ) select id from stale`);
  const count = result.rowCount ?? 0;
  logMetric('AdRouter', { RecoveryRequired: count }, { Environment: getRuntimeConfig().environment });
  recordRecoveryRequired(count, 'stale_reservation');
  return count;
}

export async function markReservationsRecovery(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await getPostgresPool().query(`with marked as (
      update router.reservations set status='recovery_required',recovery_marked_at=now()
      where id=any($1::uuid[]) and status='reserved' returning id
    ) update router.platform_settings set active_requests=greatest(0,active_requests-(select count(*) from marked)),updated_at=now() where singleton=true`, [ids]);
  for (const id of ids) releaseReservation(id);
  setActiveRequests(activeRequestCount());
  recordRecoveryRequired(ids.length, 'shutdown');
}

export async function handleProviderFailure(error: unknown, admission: Admission): Promise<void> {
  const status = error && typeof error === 'object' && 'status' in error ? Number((error as { status?: unknown }).status) : undefined;
  if (status === 402) await getPostgresPool().query(`update router.platform_settings set traffic_mode='disabled',updated_at=now() where singleton=true`);
  logMetric('AdRouter', { ProviderErrors: 1, ...(status === 402 ? { TrafficKillSwitches: 1 } : {}) }, { Environment: getRuntimeConfig().environment, Provider: admission.provider });
  recordProviderError(admission.provider, status);
  await releaseAdmission(admission, false);
}
