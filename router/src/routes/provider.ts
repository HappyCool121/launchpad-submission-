import { Router } from 'express';
import { listModels } from '../lib/modelRegistry.js';
import { getLocalProfile, requireMachineProfileAuth } from '../lib/profile.js';
import { getRuntimeConfig } from '../runtime/config.js';
import { principalFrom } from '../runtime/auth.js';

export const providerRouter = Router();

providerRouter.get('/models', (_req, res) => {
  res.json({ models: listModels() });
});

providerRouter.get('/profile', requireMachineProfileAuth, (_req, res) => {
  if (getRuntimeConfig().serviceMode) {
    const principal = principalFrom(res);
    res.json({ id: principal.userId, role: principal.role, status: principal.status, auth_source: principal.authSource,
      installation: principal.installationId ? {
        id: principal.installationId,
        client_kind: principal.clientKind,
        client_version: principal.clientVersion,
        scopes: principal.scopes,
        storage_class: principal.storageClass,
        access_token_expires_at: principal.accessTokenExpiresAt,
        minimum_version: principal.minimumClientVersion,
        policy_mode: principal.clientPolicyMode,
        attested: false,
      } : undefined,
      mode: 'service' });
    return;
  }
  const profile = getLocalProfile();
  res.json({ id: profile.id, display_name: profile.displayName, mode: profile.mode });
});
