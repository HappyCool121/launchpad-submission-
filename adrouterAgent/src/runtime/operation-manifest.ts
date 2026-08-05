import type { OperationCapability, OperationManifestV1 } from '../shared/contracts';
import { OperationManifestV1Schema } from '../shared/contracts';
import { createId, sha256 } from '../shared/security';

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, canonicalize(nested)])
  );
};

export const operationManifestBinding = (manifest: Omit<OperationManifestV1, 'binding'>): string =>
  sha256(JSON.stringify(canonicalize(manifest)));

export interface CreateOperationManifestInput {
  capability: OperationCapability;
  threadId: string;
  turnId: string;
  workspace: string;
  targets?: OperationManifestV1['targets'];
  argv?: string[] | null;
  network?: OperationManifestV1['network'];
  git?: OperationManifestV1['git'];
  lifetimeMs?: number;
  now?: Date;
}

export const createOperationManifest = (
  input: CreateOperationManifestInput
): OperationManifestV1 => {
  const created = input.now ?? new Date();
  const lifetimeMs = Math.min(Math.max(input.lifetimeMs ?? 5 * 60_000, 1_000), 15 * 60_000);
  const unsigned: Omit<OperationManifestV1, 'binding'> = {
    version: 1,
    operationId: createId(),
    capability: input.capability,
    threadId: input.threadId,
    turnId: input.turnId,
    workspace: input.workspace,
    targets: input.targets ?? [],
    argv: input.argv ?? null,
    network: input.network ?? null,
    git: input.git ?? null,
    policyVersion: 1,
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + lifetimeMs).toISOString(),
  };
  return OperationManifestV1Schema.parse({
    ...unsigned,
    binding: operationManifestBinding(unsigned),
  });
};

export class OperationBindingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OperationBindingError';
  }
}

export const assertOperationManifest = (
  value: unknown,
  expected: Pick<OperationManifestV1, 'operationId' | 'threadId' | 'turnId' | 'capability'>,
  currentTime = Date.now()
): OperationManifestV1 => {
  const manifest = OperationManifestV1Schema.parse(value);
  if (
    manifest.operationId !== expected.operationId ||
    manifest.threadId !== expected.threadId ||
    manifest.turnId !== expected.turnId ||
    manifest.capability !== expected.capability
  ) {
    throw new OperationBindingError('The approved operation binding does not match the request.');
  }
  if (Date.parse(manifest.expiresAt) <= currentTime) {
    throw new OperationBindingError('The operation approval expired before execution.');
  }
  const { binding, ...unsigned } = manifest;
  if (binding !== operationManifestBinding(unsigned)) {
    throw new OperationBindingError('The operation approval binding was modified.');
  }
  return manifest;
};
