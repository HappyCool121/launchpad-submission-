import catalogJson from '../shared/bundles/catalog.v1.json';
import {
  type BundlePackageV1,
  BundlePackageV1Schema,
  type BundleSummary,
  type PromptSource,
} from '../shared/contracts';
import { sha256 } from '../shared/security';
import type { AppDatabase } from './database';

const AGGREGATE_CONTENT_LIMIT = 256 * 1024;
const SAFE_PATH = /^[a-z0-9][a-z0-9._/-]*\.md$/;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)])
  );
};

const aggregateDigest = (bundle: BundlePackageV1): string => {
  const { aggregateDigest: _digest, ...unsigned } = bundle.manifest;
  return sha256(JSON.stringify(canonicalize(unsigned)));
};

const parseVersion = (value: string): { core: number[]; prerelease: string[] } => {
  const [core = '', prerelease = ''] = value.split('-', 2);
  return {
    core: core.split('.').map(Number),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
};

export const compareVersions = (leftValue: string, rightValue: string): number => {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === rightPart) continue;
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined)
      return Math.sign(leftNumber - rightNumber);
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
};

export const validateBundlePackage = (raw: unknown, agentVersion: string): BundlePackageV1 => {
  const bundle = BundlePackageV1Schema.parse(raw);
  if (compareVersions(agentVersion, bundle.manifest.minimumAgentVersion) < 0) {
    throw new Error(
      `Bundle ${bundle.manifest.id} requires Agent ${bundle.manifest.minimumAgentVersion} or newer.`
    );
  }
  if (bundle.entries.length !== bundle.manifest.entries.length) {
    throw new Error('Bundle entry metadata does not match its packaged content.');
  }
  const seenPaths = new Set<string>();
  let contentBytes = 0;
  for (const [index, entry] of bundle.entries.entries()) {
    const metadata = bundle.manifest.entries[index];
    const expectedPrefix = `${entry.kind === 'instruction' ? 'instructions' : `${entry.kind}s`}/`;
    if (
      !SAFE_PATH.test(entry.path) ||
      entry.path.includes('..') ||
      entry.path.includes('\\') ||
      !entry.path.startsWith(expectedPrefix) ||
      seenPaths.has(entry.path)
    ) {
      throw new Error(`Bundle entry path ${entry.path} is not a unique declarative Markdown path.`);
    }
    seenPaths.add(entry.path);
    if (entry.content.includes('\0') || entry.content.startsWith('#!')) {
      throw new Error(`Bundle entry ${entry.path} contains executable or binary content.`);
    }
    contentBytes += new TextEncoder().encode(entry.content).byteLength;
    if (entry.digest !== sha256(entry.content)) {
      throw new Error(`Bundle entry ${entry.path} failed its SHA-256 check.`);
    }
    const { content: _content, ...entryMetadata } = entry;
    if (JSON.stringify(entryMetadata) !== JSON.stringify(metadata)) {
      throw new Error(`Bundle entry ${entry.path} metadata changed from its manifest.`);
    }
  }
  if (contentBytes > AGGREGATE_CONTENT_LIMIT) throw new Error('Bundle content is too large.');
  if (aggregateDigest(bundle) !== bundle.manifest.aggregateDigest) {
    throw new Error(`Bundle ${bundle.manifest.id} failed its aggregate digest check.`);
  }
  return bundle;
};

const CatalogSchema = BundlePackageV1Schema.array().min(1).max(64);

export class BundleService {
  private readonly bundles: BundlePackageV1[];

  public constructor(
    private readonly database: AppDatabase,
    agentVersion: string
  ) {
    const raw = catalogJson as unknown as { schemaVersion?: unknown; bundles?: unknown };
    if (raw.schemaVersion !== 1) throw new Error('The bundled extension catalog is incompatible.');
    this.bundles = CatalogSchema.parse(raw.bundles).map((bundle) =>
      validateBundlePackage(bundle, agentVersion)
    );
    if (new Set(this.bundles.map((bundle) => bundle.manifest.id)).size !== this.bundles.length) {
      throw new Error('The bundled extension catalog contains duplicate IDs.');
    }
  }

  public list(projectId: string): BundleSummary[] {
    if (!this.database.getProject(projectId)) throw new Error('Project not found.');
    const trusts = new Map(
      this.database.listBundleTrust(projectId).map((trust) => [trust.bundleId, trust])
    );
    return this.bundles.map((bundle) => {
      const manifest = bundle.manifest;
      const trust = trusts.get(manifest.id);
      const exact =
        trust?.bundleVersion === manifest.version &&
        trust.bundleDigest === manifest.aggregateDigest;
      return {
        id: manifest.id,
        version: manifest.version,
        minimumAgentVersion: manifest.minimumAgentVersion,
        aggregateDigest: manifest.aggregateDigest,
        entries: manifest.entries,
        trusted: Boolean(trust),
        active: exact,
        trustReason: !trust
          ? 'Not trusted for this project.'
          : exact
            ? null
            : 'The packaged version or digest changed and requires a new approval.',
      };
    });
  }

  public trust(
    projectId: string,
    bundleId: string,
    version: string,
    digest: string
  ): BundleSummary {
    const bundle = this.bundles.find((candidate) => candidate.manifest.id === bundleId);
    if (
      !bundle ||
      bundle.manifest.version !== version ||
      bundle.manifest.aggregateDigest !== digest
    ) {
      throw new Error('Only the exact packaged bundle version and digest can be trusted.');
    }
    this.database.trustBundle({
      projectId,
      bundleId,
      bundleVersion: version,
      bundleDigest: digest,
    });
    const summary = this.list(projectId).find((candidate) => candidate.id === bundleId);
    if (!summary) throw new Error('Trusted bundle could not be loaded.');
    return summary;
  }

  public revoke(projectId: string, bundleId: string): BundleSummary {
    this.database.revokeBundleTrust(projectId, bundleId);
    const summary = this.list(projectId).find((candidate) => candidate.id === bundleId);
    if (!summary) throw new Error('Bundle not found.');
    return summary;
  }

  public promptContent(projectId: string): {
    instructions: string;
    sources: PromptSource[];
  } {
    const activeIds = new Set(
      this.list(projectId)
        .filter((bundle) => bundle.active)
        .map((bundle) => bundle.id)
    );
    const entries = this.bundles
      .filter((bundle) => activeIds.has(bundle.manifest.id))
      .flatMap((bundle) => bundle.entries.map((entry) => ({ bundle: bundle.manifest, entry })));
    return {
      instructions: entries
        .map(
          ({ bundle, entry }) =>
            `Bundled declarative ${entry.kind} (${bundle.id}@${bundle.version}, ${entry.title}):\n${entry.content}`
        )
        .join('\n\n'),
      sources: entries.map(({ bundle, entry }) => ({
        kind: 'bundle',
        label: `${bundle.id}@${bundle.version}: ${entry.title}`,
        digest: entry.digest,
      })),
    };
  }
}
