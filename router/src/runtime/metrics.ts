import { createServer, type Server } from 'node:http';
import type { Request, Response } from 'express';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { getRuntimeConfig } from './config.js';
import { getPostgresPool } from './postgres.js';

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'adrouter_node_' });

const requests = new Counter({ name: 'adrouter_requests_total', help: 'Completed HTTP requests.',
  labelNames: ['environment', 'route', 'outcome', 'status_class'] as const, registers: [registry] });
const requestDuration = new Histogram({ name: 'adrouter_request_duration_seconds', help: 'HTTP request duration.',
  labelNames: ['environment', 'route', 'outcome'] as const, registers: [registry] });
const firstToken = new Histogram({ name: 'adrouter_time_to_first_token_seconds', help: 'Time to first streamed model token.',
  labelNames: ['environment', 'model', 'outcome'] as const, registers: [registry] });
const activeRequests = new Gauge({ name: 'adrouter_active_requests', help: 'In-process admitted requests.',
  labelNames: ['environment'] as const, registers: [registry] });
const admissionRejections = new Counter({ name: 'adrouter_admission_rejections_total', help: 'Rejected admission attempts.',
  labelNames: ['environment', 'reason'] as const, registers: [registry] });
const providerErrors = new Counter({ name: 'adrouter_provider_errors_total', help: 'Provider failures.',
  labelNames: ['environment', 'provider', 'status_class'] as const, registers: [registry] });
const recoveryRequired = new Counter({ name: 'adrouter_recovery_required_total', help: 'Reservations marked for recovery.',
  labelNames: ['environment', 'reason'] as const, registers: [registry] });
const recoveryFailures = new Counter({ name: 'adrouter_recovery_sweep_failures_total', help: 'Failed recovery sweeps.',
  labelNames: ['environment'] as const, registers: [registry] });
const spend = new Gauge({ name: 'adrouter_spend_microusd', help: 'Settled platform spend.',
  labelNames: ['environment', 'period'] as const, registers: [registry] });
const spendLimit = new Gauge({ name: 'adrouter_spend_limit_microusd', help: 'Configured platform spend limit.',
  labelNames: ['environment', 'period'] as const, registers: [registry] });
const trafficMode = new Gauge({ name: 'adrouter_traffic_mode', help: 'Active database traffic mode (one-hot).',
  labelNames: ['environment', 'mode'] as const, registers: [registry] });
const machineAuthentication = new Counter({ name: 'adrouter_machine_authentication_total', help: 'Bounded machine authentication outcomes.',
  labelNames: ['environment', 'auth_source', 'client_kind', 'outcome'] as const, registers: [registry] });
const proofFailures = new Counter({ name: 'adrouter_platform_proof_failures_total', help: 'Sanitized platform proof failure categories.',
  labelNames: ['environment', 'category'] as const, registers: [registry] });
const clientPolicyOutcomes = new Counter({ name: 'adrouter_client_policy_outcomes_total', help: 'Client policy decisions.',
  labelNames: ['environment', 'client_kind', 'mode', 'outcome'] as const, registers: [registry] });
const nonceChallenges = new Counter({ name: 'adrouter_dpop_nonce_challenges_total', help: 'Server DPoP nonce challenges.',
  labelNames: ['environment', 'purpose'] as const, registers: [registry] });
const refreshReuse = new Counter({ name: 'adrouter_refresh_reuse_total', help: 'Refresh-family reuse detections.',
  labelNames: ['environment', 'client_kind'] as const, registers: [registry] });
const authCleanupRemoved = new Counter({ name: 'adrouter_platform_auth_cleanup_removed_total', help: 'Expired platform-auth rows removed.',
  labelNames: ['environment', 'record_type'] as const, registers: [registry] });
const campaignInventoryRefreshes = new Counter({ name: 'adrouter_campaign_inventory_refresh_total', help: 'Campaign inventory refresh outcomes.',
  labelNames: ['environment', 'outcome', 'source'] as const, registers: [registry] });
const campaignInventoryVersion = new Gauge({ name: 'adrouter_campaign_inventory_version', help: 'Locally applied campaign inventory version.',
  labelNames: ['environment'] as const, registers: [registry] });
const campaignInventorySize = new Gauge({ name: 'adrouter_campaign_inventory_campaigns', help: 'Campaigns in the locally applied routing cache.',
  labelNames: ['environment'] as const, registers: [registry] });

const environment = () => getRuntimeConfig().environment;
const statusClass = (status: number | undefined) => status && Number.isFinite(status) ? `${Math.floor(status / 100)}xx` : 'unknown';

function routeLabel(req: Request): string {
  const path = req.path;
  if (path === '/health/live' || path === '/health/ready' || path === '/health') return path;
  if (path === '/api/chat') return '/api/chat';
  if (path === '/v1/turn') return '/v1/turn';
  if (path === '/v1/agent/turn') return '/v1/agent/turn';
  if (path.startsWith('/v1/account/credentials')) return '/v1/account/credentials/:id?/:action?';
  if (path.startsWith('/v1/account')) return '/v1/account';
  if (path.startsWith('/v1/operator')) return '/v1/operator';
  if (path.startsWith('/v1/')) return '/v1/other';
  if (path.startsWith('/api/')) return '/api/other';
  return 'other';
}

export function observeHttpRequest(req: Request, res: Response, started: bigint): void {
  const outcome = res.statusCode < 400 ? 'success' : 'error';
  const labels = { environment: environment(), route: routeLabel(req), outcome };
  requests.inc({ ...labels, status_class: statusClass(res.statusCode) });
  requestDuration.observe(labels, Number(process.hrtime.bigint() - started) / 1e9);
}

export function setActiveRequests(value: number): void { activeRequests.set({ environment: environment() }, value); }
export function recordAdmissionRejection(reason: string): void { admissionRejections.inc({ environment: environment(), reason }); }
export function recordProviderError(provider: string, status?: number): void {
  providerErrors.inc({ environment: environment(), provider, status_class: statusClass(status) });
}
export function recordRecoveryRequired(count: number, reason: string): void {
  if (count > 0) recoveryRequired.inc({ environment: environment(), reason }, count);
}
export function recordRecoveryFailure(): void { recoveryFailures.inc({ environment: environment() }); }
export function recordFirstToken(model: string, started: bigint, outcome: 'success' | 'error'): void {
  firstToken.observe({ environment: environment(), model, outcome }, Number(process.hrtime.bigint() - started) / 1e9);
}
export function recordMachineAuthentication(authSource: 'legacy' | 'installation', clientKind: string, outcome: 'accepted' | 'rejected'): void {
  machineAuthentication.inc({ environment: environment(), auth_source: authSource, client_kind: clientKind, outcome });
}
export function recordPlatformProofFailure(category: string): void {
  const allowed = new Set(['invalid_access_token', 'invalid_dpop_proof', 'use_dpop_nonce', 'installation_not_allowed', 'client_not_allowed', 'client_upgrade_required', 'rate_limited']);
  proofFailures.inc({ environment: environment(), category: allowed.has(category) ? category : 'other' });
}
export function recordClientPolicyOutcome(clientKind: string, mode: string, outcome: string): void {
  clientPolicyOutcomes.inc({ environment: environment(), client_kind: clientKind, mode, outcome });
}
export function recordNonceChallenge(purpose: string): void { nonceChallenges.inc({ environment: environment(), purpose }); }
export function recordRefreshReuse(clientKind: string): void { refreshReuse.inc({ environment: environment(), client_kind: clientKind }); }
export function recordAuthCleanup(removed: Record<string, number>): void {
  for (const [recordType, count] of Object.entries(removed)) if (count > 0) authCleanupRemoved.inc({ environment: environment(), record_type: recordType }, count);
}
export function recordCampaignInventoryRefresh(outcome: 'success' | 'failure', source: 'startup' | 'notification' | 'poll' | 'mutation', version?: bigint, campaigns?: number): void {
  campaignInventoryRefreshes.inc({ environment: environment(), outcome, source });
  if (outcome === 'success' && version !== undefined) campaignInventoryVersion.set({ environment: environment() }, Number(version));
  if (outcome === 'success' && campaigns !== undefined) campaignInventorySize.set({ environment: environment() }, campaigns);
}

export async function refreshOperationalMetrics(): Promise<void> {
  if (!getRuntimeConfig().serviceMode) return;
  const result = await getPostgresPool().query<{
    day_spend: string; month_spend: string; daily_limit: string; monthly_limit: string; traffic_mode: 'disabled'|'owner_only'|'beta';
  }>(`select
      coalesce(sum(cost_microusd) filter (where created_at >= date_trunc('day',now())),0)::text day_spend,
      coalesce(sum(cost_microusd) filter (where created_at >= date_trunc('month',now())),0)::text month_spend,
      (select daily_limit_microusd from router.platform_settings where singleton)::text daily_limit,
      (select monthly_limit_microusd from router.platform_settings where singleton)::text monthly_limit,
      (select traffic_mode from router.platform_settings where singleton) traffic_mode
    from router.usage`);
  const row = result.rows[0];
  if (!row) return;
  spend.set({ environment: environment(), period: 'day' }, Number(row.day_spend));
  spend.set({ environment: environment(), period: 'month' }, Number(row.month_spend));
  spendLimit.set({ environment: environment(), period: 'day' }, Number(row.daily_limit));
  spendLimit.set({ environment: environment(), period: 'month' }, Number(row.monthly_limit));
  for (const mode of ['disabled', 'owner_only', 'beta'] as const) {
    trafficMode.set({ environment: environment(), mode }, row.traffic_mode === mode ? 1 : 0);
  }
}

let metricsServer: Server | undefined;
export async function startMetricsServer(): Promise<void> {
  const port = getRuntimeConfig().metricsPort;
  if (!port || metricsServer) return;
  metricsServer = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') { res.writeHead(404).end(); return; }
    try {
      res.writeHead(200, { 'content-type': registry.contentType, 'cache-control': 'no-store' });
      res.end(await registry.metrics());
    } catch { res.writeHead(503).end(); }
  });
  await new Promise<void>((resolve, reject) => {
    metricsServer!.once('error', reject);
    metricsServer!.listen(port, '0.0.0.0', resolve);
  });
}

export async function stopMetricsServer(): Promise<void> {
  const current = metricsServer; metricsServer = undefined;
  if (!current) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

export async function metricsTextForTests(): Promise<string> { return registry.metrics(); }
