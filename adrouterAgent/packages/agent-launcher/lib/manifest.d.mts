export interface TrustedReleaseKey {
  keyId: string;
  algorithm: 'Ed25519';
  publicKey: JsonWebKey;
  channels: Array<'beta' | 'stable'>;
  notBefore: string;
  notAfter: string;
  status: 'active' | 'retired';
}

export interface ReleaseArtifact {
  key: string;
  platform: NodeJS.Platform;
  architectures: string[];
  assetName: string;
  assetUrl: string;
  bytes?: number;
  sha256: string;
  archiveRoot: string;
  executablePath: string;
  verificationMode: string;
  signature?: { type: string; required: boolean; expectedSigner: string | null };
}

export interface ValidatedReleaseManifest {
  schema: 3 | 4;
  distributionMode: string;
  channel?: 'beta' | 'stable';
  releaseVersion: string;
  releaseTag: string;
  minimumAgentVersion?: string;
  issuedAt?: string;
  expiresAt?: string;
  artifacts: ReleaseArtifact[];
  health?: { deadlineSeconds: number; markerProtocol: 1; rollbackRequired: true };
}

export function validateManifest(
  value: unknown,
  options?: {
    trustedKeys?: TrustedReleaseKey[];
    now?: Date | string | number;
    enforceExpiry?: boolean;
  }
): ValidatedReleaseManifest;
export function selectArtifact(
  manifest: ValidatedReleaseManifest,
  platform?: NodeJS.Platform,
  arch?: string
): ReleaseArtifact;
export function releaseManifestSigningBytes(signed: unknown): Buffer;
export function trustedReleaseKeyId(publicJwk: JsonWebKey): string;
export const RELEASE_ARTIFACTS: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
