import type { NextFunction, Request, Response } from 'express';
import { getRuntimeConfig } from '../runtime/config.js';
import { requireBrowserAuth, requireDeveloper } from '../runtime/auth.js';
import { requireMachineRouteAuth } from '../runtime/machine-auth.js';

export interface LocalProfile {
  id: string;
  displayName: string;
  mode: 'local';
}

export function getLocalProfile(): LocalProfile {
  return {
    id: process.env.ADROUTER_PROFILE_ID ?? 'local-demo',
    displayName: process.env.ADROUTER_PROFILE_NAME ?? 'AdRouter Local Demo',
    mode: 'local',
  };
}

export function getRouterApiKey(): string {
  return process.env.ADROUTER_API_KEY ?? process.env.ROUTER_AUTH_KEY ?? '';
}

export function requireRouterAuth(req: Request, res: Response, next: NextFunction): void {
  if (getRuntimeConfig().serviceMode) {
    res.status(404).json({ error: 'Not found.', code: 'route_not_available' });
    return;
  }
  const expected = getRouterApiKey();
  const authorization = req.headers.authorization ?? '';
  if (!expected || authorization !== `Bearer ${expected}`) {
    res.status(401).json({ error: 'unauthorized', code: 'invalid_api_key' });
    return;
  }
  next();
}

export const requireMachineProfileAuth = requireMachineRouteAuth('profile:read');
export const requireMachineAgentAuth = requireMachineRouteAuth('agent:turn');
/** Hosted WebUI traffic uses a Supabase access token; explicit demo mode keeps its local shared token. */
export function requireWebChatAuth(req: Request, res: Response, next: NextFunction): void {
  if (getRuntimeConfig().serviceMode) {
    void requireBrowserAuth(req, res, () => requireDeveloper(req, res, next));
    return;
  }
  requireRouterAuth(req, res, next);
}
