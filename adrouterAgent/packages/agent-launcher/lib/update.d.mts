import type { TrustedReleaseKey, ValidatedReleaseManifest } from './manifest.mjs';

export interface UpdateCheckResult {
  channel: 'beta' | 'stable';
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  manifest: ValidatedReleaseManifest;
}

export const UPDATE_APPLICATION_ENABLED: false;
export function checkForUpdate(
  currentVersion: string,
  channel: 'beta' | 'stable',
  options?: {
    fetchImpl?: typeof fetch;
    trustedKeys?: TrustedReleaseKey[];
    now?: Date | string | number;
  }
): Promise<UpdateCheckResult>;
export function compareAgentVersions(left: string, right: string): number;
export function updateManifestUrl(channel: 'beta' | 'stable'): string | null;
