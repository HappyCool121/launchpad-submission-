import { markStaleReservations } from './admission.js';
import { getRuntimeConfig } from './config.js';
import { logError, logEvent } from './logging.js';
import { recordRecoveryFailure, refreshOperationalMetrics } from './metrics.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
let stopped = false;

export async function runRecoverySweep(): Promise<void> {
  if (running || stopped) return;
  running = true;
  try {
    const count = await markStaleReservations();
    await refreshOperationalMetrics();
    logEvent('recovery_sweep_complete', { recovery_required: count });
  } catch (error) {
    recordRecoveryFailure();
    logError('recovery_sweep_failed', error);
  } finally { running = false; }
}

export function startRecoveryScheduler(): void {
  const interval = getRuntimeConfig().recoveryIntervalMs;
  if (!interval || timer) return;
  stopped = false;
  timer = setInterval(() => void runRecoverySweep(), interval);
  timer.unref();
}

export function stopRecoveryScheduler(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = undefined;
}
