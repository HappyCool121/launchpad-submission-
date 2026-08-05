import type { AdPayload, RuntimeMode, Settlement } from '../lib/types.js';
import type { Principal } from './auth.js';
import type { Admission } from './admission.js';

export interface AuthService {
  authenticateApiCredential(bearer: string): Promise<Principal>;
  authenticateBrowserJwt(bearer: string): Promise<Principal>;
}

export interface PersistenceService {
  insertEvent(ad: AdPayload, meta: { client?: string; provider: string; model: string; runtimeMode: RuntimeMode; reservationId?: string }): Promise<void>;
  markImpressionQueued(turnId: string): Promise<void>;
  settleEvent(turnId: string, settlement: Settlement): Promise<void>;
  failEvent(turnId: string): Promise<void>;
}

export interface AdmissionService {
  reserve(principal: Principal, model: string, estimatedInputTokens: number, maxOutputTokens: number): Promise<Admission>;
  settle(admission: Admission, settlement: Settlement): Promise<void>;
  markRecoveryRequired(admission: Admission): Promise<void>;
}

export interface HealthService {
  live(): boolean;
  ready(): boolean;
  diagnostics(principal: Principal): Promise<Record<string, unknown>>;
}
