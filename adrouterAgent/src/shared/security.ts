import { createHash, randomUUID } from 'node:crypto';

const SPONSOR_KEYS = new Set([
  'ad',
  'ads',
  'advertiser',
  'sponsor',
  'sponsorship',
  'settlement',
  'subsidy',
  'economics',
]);

export const now = (): string => new Date().toISOString();
export const createId = (): string => randomUUID();

export const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

export const safeRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
};

/** Removes economics-only fields before a value may be sent to an agent model or tool. */
export const removeSponsorData = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(removeSponsorData);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SPONSOR_KEYS.has(key.toLowerCase()))
      .map(([key, child]) => [key, removeSponsorData(child)])
  );
};

export const containsSponsorKey = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(containsSponsorKey);
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => SPONSOR_KEYS.has(key.toLowerCase()) || containsSponsorKey(child)
  );
};

export const isSafeExternalUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};
