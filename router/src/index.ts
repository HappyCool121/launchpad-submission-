import './lib/env.js';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import cors from 'cors';
import type { Server } from 'node:http';
import { getRuntimeConfig } from './runtime/config.js';
import { closePostgres, verifyPostgres } from './runtime/postgres.js';
import { beginDraining, markBootCompleted, unresolvedReservations, activeRequestCount } from './runtime/state.js';
import { markReservationsRecovery, markStaleReservations } from './runtime/admission.js';
import { closePersistence } from './lib/persistence.js';
import { stopSponsorStore } from './lib/sponsorStore.js';
import { observeHttpRequest, refreshOperationalMetrics, startMetricsServer, stopMetricsServer } from './runtime/metrics.js';
import { startRecoveryScheduler, stopRecoveryScheduler } from './runtime/recovery.js';
import { platformJsonBody } from './runtime/raw-body.js';
import { startPlatformAuthCleanup, stopPlatformAuthCleanup } from './runtime/platform-auth-store.js';

const config = getRuntimeConfig();
const app = express();
let server: Server | undefined;
let shuttingDown = false;

app.use(cors({ origin(origin, callback) {
  if (!origin || config.webOrigins.includes(origin)) callback(null, true);
  else callback(new Error('Origin is not allowed by CORS'));
} }));
app.all(['/v1/turn', '/v1/account/credentials', '/v1/account/credentials/*'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).json({ error: 'Not found.', code: 'route_not_available' });
});
for (const path of ['/v1/device/authorizations', '/v1/device/authorizations/cancel', '/v1/oauth/token', '/v1/agent/turn', '/v1/installation/revoke']) {
  app.use(path, platformJsonBody);
}
app.use(express.json({ limit: config.maxBodyBytes }));
const jsonBodyError: ErrorRequestHandler = (error, _req, res, next) => {
  if (!error || typeof error !== 'object' || !('type' in error)) { next(error); return; }
  res.setHeader('Cache-Control', 'no-store');
  if (error.type === 'entity.too.large') {
    res.status(413).json({ error: 'The JSON request body exceeds the configured transport bound.', code: 'request_body_too_large' });
    return;
  }
  if (error.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'The JSON request body is invalid.', code: 'invalid_request' });
    return;
  }
  next(error);
};
app.use(jsonBodyError);
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.once('finish', () => observeHttpRequest(req, res, started));
  next();
});

async function mountRoutes(): Promise<void> {
  const [{ providerRouter }, { turnRouter }, { agentTurnRouter }, { chatRouter }, { sponsorsRouter }, { analyticsRouter }] = await Promise.all([
    import('./routes/provider.js'), import('./routes/turn.js'), import('./routes/agent-turn.js'),
    import('./routes/chat.js'), import('./routes/sponsors.js'), import('./routes/analytics.js'),
  ]);
  app.use('/api', chatRouter, analyticsRouter);
  if (!config.hosted) app.use('/api', sponsorsRouter);
  app.use('/v1', providerRouter, turnRouter);
  app.use(agentTurnRouter);
  if (config.serviceMode) {
    const [{ accountRouter }, { platformAuthRouter }, { ownerRouter }] = await Promise.all([
      import('./routes/account.js'), import('./routes/platform-auth.js'), import('./routes/owner.js'),
    ]);
    app.use('/v1', ownerRouter, platformAuthRouter, accountRouter);
  }
  app.get('/', (_req, res) => res.json({ service: 'AdRouter backend', runtime_profile: config.runtimeProfile }));
}

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  beginDraining();
  stopRecoveryScheduler();
  stopPlatformAuthCleanup();
  await stopSponsorStore();
  console.log(JSON.stringify({ event: 'shutdown_started', signal, active_requests: activeRequestCount() }));
  server?.close();
  const deadline = Date.now() + 115_000;
  while (activeRequestCount() > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  if (config.serviceMode) await markReservationsRecovery(unresolvedReservations());
  await stopMetricsServer();
  closePersistence();
  await closePostgres();
  console.log(JSON.stringify({ event: 'shutdown_complete' }));
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

async function main(): Promise<void> {
  const { healthRouter } = await import('./routes/health.js');
  app.use(healthRouter);
  app.use('/api', healthRouter);
  server = app.listen(config.port, config.launchpadMode ? '127.0.0.1' : '0.0.0.0');
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve);
    server!.once('error', reject);
  });
  if (config.serviceMode) {
    await verifyPostgres();
    await markStaleReservations();
    await refreshOperationalMetrics();
    startRecoveryScheduler();
    startPlatformAuthCleanup();
  }
  await startMetricsServer();
  const { initSponsorStore, getSponsors } = await import('./lib/sponsorStore.js');
  await initSponsorStore();
  await mountRoutes();
  markBootCompleted();
  console.log(JSON.stringify({ event: 'ready', port: config.port, runtime_profile: config.runtimeProfile, campaigns: getSponsors().length }));
}

main().catch(async (error) => {
  console.error('[adrouter] fatal startup error:', error);
  stopRecoveryScheduler();
  stopPlatformAuthCleanup();
  await stopSponsorStore();
  await stopMetricsServer();
  closePersistence();
  await closePostgres();
  process.exit(1);
});
