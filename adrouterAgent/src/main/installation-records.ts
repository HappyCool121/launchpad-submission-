import {
  classifyRouterOrigin,
  DESKTOP_CLIENT_KIND,
  INSTALLATION_AUTH_PROTOCOL_VERSION,
  OFFICIAL_ADROUTER_WEB_ORIGINS,
} from '../shared/constants';
import {
  type Ed25519PrivateJwk,
  jwkThumbprint,
  publicJwkFromPrivate,
  validatePrivateJwk,
} from './platform-auth-crypto';

export const INSTALLATION_SCOPES = ['agent:turn', 'profile:read'] as const;
export type InstallationScope = (typeof INSTALLATION_SCOPES)[number];

export interface InstallationRecord {
  version: typeof INSTALLATION_AUTH_PROTOCOL_VERSION;
  privateJwk: Ed25519PrivateJwk;
  refreshToken: string;
  installationId: string;
  scopes: InstallationScope[];
  origin: string;
  clientKind: typeof DESKTOP_CLIENT_KIND;
  clientVersion: string;
  familyExpiresAt: string;
  displayName: string;
  keyThumbprint: string;
  storageClassification: 'os_encrypted';
}

export interface PendingEnrollmentRecord {
  version: typeof INSTALLATION_AUTH_PROTOCOL_VERSION;
  privateJwk: Ed25519PrivateJwk;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalSeconds: number;
  expiresAt: string;
  nextPollAt: string;
  origin: string;
  clientVersion: string;
  displayName: string;
  sponsoredCompute: boolean;
  scopes: InstallationScope[];
}

const recordValue = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`The encrypted ${name} record is malformed.`);
  }
  return value as Record<string, unknown>;
};

const requiredString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
    throw new Error(`The encrypted installation field ${key} is malformed.`);
  }
  return value;
};

const timestamp = (record: Record<string, unknown>, key: string): string => {
  const value = requiredString(record, key);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`The encrypted installation field ${key} is malformed.`);
  }
  return value;
};

const scopes = (record: Record<string, unknown>): InstallationScope[] => {
  const value = record.scopes;
  if (
    !Array.isArray(value) ||
    value.length !== INSTALLATION_SCOPES.length ||
    !INSTALLATION_SCOPES.every((scope) => value.includes(scope))
  ) {
    throw new Error('The encrypted installation scopes are malformed.');
  }
  return [...INSTALLATION_SCOPES];
};

const httpsUrl = (record: Record<string, unknown>, key: string): string => {
  const value = requiredString(record, key);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`The encrypted installation field ${key} is unsafe.`);
  }
  return value;
};

const officialOrigin = (record: Record<string, unknown>): string => {
  const origin = new URL(requiredString(record, 'origin')).origin;
  if (classifyRouterOrigin(origin) !== 'official') {
    throw new Error('The encrypted installation origin is not an official AdRouter origin.');
  }
  return origin;
};

const officialWebUrl = (record: Record<string, unknown>, key: string): string => {
  const value = httpsUrl(record, key);
  if (!(OFFICIAL_ADROUTER_WEB_ORIGINS as readonly string[]).includes(new URL(value).origin)) {
    throw new Error(`The encrypted installation field ${key} is not an official approval URL.`);
  }
  return value;
};

export const parseInstallationRecord = (value: unknown): InstallationRecord => {
  const record = recordValue(value, 'installation');
  if (
    record.version !== INSTALLATION_AUTH_PROTOCOL_VERSION ||
    record.clientKind !== DESKTOP_CLIENT_KIND ||
    record.storageClassification !== 'os_encrypted'
  ) {
    throw new Error('The encrypted installation record version is unsupported.');
  }
  const privateJwk = validatePrivateJwk(record.privateJwk);
  const keyThumbprint = requiredString(record, 'keyThumbprint');
  if (jwkThumbprint(publicJwkFromPrivate(privateJwk)) !== keyThumbprint) {
    throw new Error('The encrypted installation key thumbprint is inconsistent.');
  }
  return {
    version: INSTALLATION_AUTH_PROTOCOL_VERSION,
    privateJwk,
    refreshToken: requiredString(record, 'refreshToken'),
    installationId: requiredString(record, 'installationId'),
    scopes: scopes(record),
    origin: officialOrigin(record),
    clientKind: DESKTOP_CLIENT_KIND,
    clientVersion: requiredString(record, 'clientVersion'),
    familyExpiresAt: timestamp(record, 'familyExpiresAt'),
    displayName: requiredString(record, 'displayName'),
    keyThumbprint,
    storageClassification: 'os_encrypted',
  };
};

export const parsePendingEnrollmentRecord = (value: unknown): PendingEnrollmentRecord => {
  const record = recordValue(value, 'pending enrollment');
  if (record.version !== INSTALLATION_AUTH_PROTOCOL_VERSION) {
    throw new Error('The encrypted pending enrollment version is unsupported.');
  }
  const intervalSeconds = record.intervalSeconds;
  if (typeof intervalSeconds !== 'number' || intervalSeconds < 1 || intervalSeconds > 30) {
    throw new Error('The encrypted enrollment polling interval is malformed.');
  }
  if (typeof record.sponsoredCompute !== 'boolean') {
    throw new Error('The encrypted enrollment preference is malformed.');
  }
  return {
    version: INSTALLATION_AUTH_PROTOCOL_VERSION,
    privateJwk: validatePrivateJwk(record.privateJwk),
    deviceCode: requiredString(record, 'deviceCode'),
    userCode: requiredString(record, 'userCode'),
    verificationUri: officialWebUrl(record, 'verificationUri'),
    verificationUriComplete: officialWebUrl(record, 'verificationUriComplete'),
    intervalSeconds,
    expiresAt: timestamp(record, 'expiresAt'),
    nextPollAt: timestamp(record, 'nextPollAt'),
    origin: officialOrigin(record),
    clientVersion: requiredString(record, 'clientVersion'),
    displayName: requiredString(record, 'displayName'),
    sponsoredCompute: record.sponsoredCompute,
    scopes: scopes(record),
  };
};
