import type { Response } from 'express';
import { safeWriteNdjson } from '../lib/agent-routing.js';
import { getRuntimeConfig } from './config.js';

export function startHeartbeats(res: Response): () => void {
  const timer = setInterval(() => safeWriteNdjson(res, { type: 'heartbeat', timestamp: new Date().toISOString() }), getRuntimeConfig().heartbeatMs);
  timer.unref();
  return () => clearInterval(timer);
}
