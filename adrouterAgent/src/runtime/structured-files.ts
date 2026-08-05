import { constants } from 'node:fs';
import {
  access,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { type OperationManifestV1, OperationManifestV1Schema } from '../shared/contracts';
import { sha256 } from '../shared/security';
import { assertOperationManifest, createOperationManifest } from './operation-manifest';
import { resolveWorkspacePath, WorkspaceAccessError } from './workspace';

const MAX_OPERATION_BYTES = 10 * 1024 * 1024;
const MAX_OPERATION_ENTRIES = 2_000;
const MAX_RECOVERY_BYTES = 50 * 1024 * 1024;
const MAX_RECOVERY_ENTRIES = 100;
const RECOVERY_DIRECTORY = '.adrouter-recovery';
const RECOVERY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

interface TreeInventory {
  digest: string;
  bytes: number;
  entries: number;
  kind: 'file' | 'directory';
}

const inventoryTree = async (absolute: string): Promise<TreeInventory> => {
  const records: Array<{ path: string; kind: 'file' | 'directory'; digest: string; size: number }> =
    [];
  let bytes = 0;
  const walk = async (path: string, fromRoot: string): Promise<void> => {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new WorkspaceAccessError('Structured file operations do not follow symbolic links.');
    }
    if (metadata.isFile()) {
      bytes += metadata.size;
      if (bytes > MAX_OPERATION_BYTES) {
        throw new WorkspaceAccessError('Structured file operation exceeds the 10 MiB limit.');
      }
      const content = await readFile(path);
      records.push({ path: fromRoot, kind: 'file', digest: sha256(content), size: content.length });
      return;
    }
    if (!metadata.isDirectory()) {
      throw new WorkspaceAccessError('Only regular files and directories may be moved or copied.');
    }
    records.push({ path: fromRoot, kind: 'directory', digest: sha256('directory'), size: 0 });
    const children = await readdir(path, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (records.length >= MAX_OPERATION_ENTRIES) {
        throw new WorkspaceAccessError('Structured file operation contains too many entries.');
      }
      await walk(join(path, child.name), fromRoot ? `${fromRoot}/${child.name}` : child.name);
    }
  };
  await walk(absolute, '');
  const rootKind = records[0]?.kind;
  if (!rootKind) throw new WorkspaceAccessError('The structured operation target is unavailable.');
  return {
    digest: sha256(JSON.stringify(records)),
    bytes,
    entries: records.length,
    kind: rootKind,
  };
};

export interface StructuredTargetSnapshot {
  path: string;
  absolute: string;
  kind: 'file' | 'directory' | 'missing';
  beforeHash: string | null;
  bytes: number;
  entries: number;
}

export const snapshotStructuredTarget = async (
  workspaceRoot: string,
  input: string,
  allowMissing = false,
  allowProtected = false
): Promise<StructuredTargetSnapshot> => {
  const path = await resolveWorkspacePath(workspaceRoot, input, { allowMissing, allowProtected });
  if (!(await pathExists(path.absolute))) {
    return {
      path: path.relative,
      absolute: path.absolute,
      kind: 'missing',
      beforeHash: null,
      bytes: 0,
      entries: 0,
    };
  }
  const inventory = await inventoryTree(path.absolute);
  return {
    path: path.relative,
    absolute: path.absolute,
    kind: inventory.kind,
    beforeHash: inventory.digest,
    bytes: inventory.bytes,
    entries: inventory.entries,
  };
};

export const createStructuredFileManifest = async (input: {
  capability: 'file.copy' | 'file.move' | 'file.delete';
  threadId: string;
  turnId: string;
  workspaceRoot: string;
  source: string;
  destination?: string;
}): Promise<OperationManifestV1> => {
  const workspace = await realpath(input.workspaceRoot);
  const source = await snapshotStructuredTarget(workspace, input.source);
  const destination = input.destination
    ? await snapshotStructuredTarget(workspace, input.destination, true)
    : undefined;
  if (destination && destination.kind !== 'missing') {
    throw new WorkspaceAccessError('Structured copy and move never overwrite an existing target.');
  }
  return createOperationManifest({
    capability: input.capability,
    threadId: input.threadId,
    turnId: input.turnId,
    workspace,
    targets: [source, ...(destination ? [destination] : [])].map((target) => ({
      path: target.path,
      kind: target.kind,
      beforeHash: target.beforeHash,
    })),
  });
};

export const verifyStructuredTargets = async (manifest: OperationManifestV1): Promise<void> => {
  for (const expected of manifest.targets) {
    if (expected.kind === 'git-ref') continue;
    const allowProtected =
      manifest.capability === 'file.restore' && expected.path.startsWith(`${RECOVERY_DIRECTORY}/`);
    const current = await snapshotStructuredTarget(
      manifest.workspace,
      expected.path,
      true,
      allowProtected
    );
    if (current.kind !== expected.kind || current.beforeHash !== expected.beforeHash) {
      throw new WorkspaceAccessError(
        `The reviewed state for ${expected.path} changed before execution.`
      );
    }
  }
};

interface RecoveryRecord {
  version: 1;
  operationId: string;
  capability: 'file.move' | 'file.delete';
  originalPath: string;
  destinationPath: string | null;
  beforeHash: string;
  createdAt: string;
}

const recoveryRoot = (workspace: string): string => resolve(workspace, RECOVERY_DIRECTORY);

const recoveryUsage = async (workspace: string): Promise<{ bytes: number; entries: number }> => {
  const root = recoveryRoot(workspace);
  if (!(await pathExists(root))) return { bytes: 0, entries: 0 };
  let bytes = 0;
  let entries = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, child.name);
      if (child.isDirectory()) await walk(path);
      else if (child.isFile()) {
        entries += 1;
        bytes += (await stat(path)).size;
      }
      if (entries > MAX_RECOVERY_ENTRIES || bytes > MAX_RECOVERY_BYTES) return;
    }
  };
  await walk(root);
  return { bytes, entries };
};

const prepareRecovery = async (
  manifest: OperationManifestV1,
  source: StructuredTargetSnapshot,
  destinationPath: string | null
): Promise<{ directory: string; stored: string; record: RecoveryRecord }> => {
  const usage = await recoveryUsage(manifest.workspace);
  if (
    usage.entries + source.entries + 1 > MAX_RECOVERY_ENTRIES ||
    usage.bytes + source.bytes > MAX_RECOVERY_BYTES
  ) {
    throw new WorkspaceAccessError(
      'The bounded recovery vault is full; recover or remove old entries first.'
    );
  }
  const directory = resolve(recoveryRoot(manifest.workspace), manifest.operationId);
  const relativeDirectory = relative(recoveryRoot(manifest.workspace), directory);
  if (relativeDirectory.startsWith(`..${sep}`) || relativeDirectory === '..') {
    throw new WorkspaceAccessError('Invalid recovery vault target.');
  }
  await mkdir(recoveryRoot(manifest.workspace), { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const record: RecoveryRecord = {
    version: 1,
    operationId: manifest.operationId,
    capability: manifest.capability as RecoveryRecord['capability'],
    originalPath: source.path,
    destinationPath,
    beforeHash: source.beforeHash ?? '',
    createdAt: new Date().toISOString(),
  };
  await writeFile(resolve(directory, 'record.json'), JSON.stringify(record), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return { directory, stored: resolve(directory, basename(source.absolute)), record };
};

const copyExact = async (source: string, destination: string): Promise<void> => {
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    preserveTimestamps: true,
  });
};

export interface StructuredFileResult {
  capability: OperationManifestV1['capability'];
  source: string;
  destination: string | null;
  beforeHash: string;
  recoveryId: string | null;
}

export const executeStructuredFileOperation = async (
  rawManifest: unknown
): Promise<StructuredFileResult> => {
  const parsed = OperationManifestV1Schema.parse(rawManifest);
  const manifest = assertOperationManifest(parsed, {
    operationId: parsed.operationId,
    threadId: parsed.threadId,
    turnId: parsed.turnId,
    capability: parsed.capability,
  });
  if (!['file.copy', 'file.move', 'file.delete'].includes(manifest.capability)) {
    throw new WorkspaceAccessError('The manifest is not a structured file operation.');
  }
  if ((await realpath(manifest.workspace)) !== manifest.workspace) {
    throw new WorkspaceAccessError('The workspace canonical path changed before execution.');
  }
  await verifyStructuredTargets(manifest);
  const sourceTarget = manifest.targets[0];
  if (!sourceTarget || sourceTarget.kind === 'missing' || sourceTarget.kind === 'git-ref') {
    throw new WorkspaceAccessError('Structured file operation requires an existing source.');
  }
  const source = await snapshotStructuredTarget(manifest.workspace, sourceTarget.path);
  const destinationTarget = manifest.targets[1];
  const destination = destinationTarget
    ? await resolveWorkspacePath(manifest.workspace, destinationTarget.path, { allowMissing: true })
    : undefined;

  if (manifest.capability === 'file.copy') {
    if (!destination) throw new WorkspaceAccessError('Copy requires a destination.');
    await mkdir(dirname(destination.absolute), { recursive: true });
    const staging = resolve(
      dirname(destination.absolute),
      `.${basename(destination.absolute)}.adrouter-${manifest.operationId}.tmp`
    );
    try {
      await copyExact(source.absolute, staging);
      await rename(staging, destination.absolute);
    } finally {
      if (await pathExists(staging)) await rm(staging, { recursive: true, force: true });
    }
    return {
      capability: manifest.capability,
      source: source.path,
      destination: destination.relative,
      beforeHash: source.beforeHash ?? '',
      recoveryId: null,
    };
  }

  const recovery = await prepareRecovery(manifest, source, destination?.relative ?? null);
  try {
    if (manifest.capability === 'file.move') {
      if (!destination) throw new WorkspaceAccessError('Move requires a destination.');
      await copyExact(source.absolute, recovery.stored);
      await mkdir(dirname(destination.absolute), { recursive: true });
      await rename(source.absolute, destination.absolute);
    } else {
      await rename(source.absolute, recovery.stored);
    }
  } catch (error) {
    await rm(recovery.directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    capability: manifest.capability,
    source: source.path,
    destination: destination?.relative ?? null,
    beforeHash: source.beforeHash ?? '',
    recoveryId: manifest.operationId,
  };
};

export const createRestoreManifest = async (input: {
  threadId: string;
  turnId: string;
  workspaceRoot: string;
  recoveryId: string;
}): Promise<OperationManifestV1> => {
  if (!RECOVERY_ID_PATTERN.test(input.recoveryId)) {
    throw new WorkspaceAccessError('The recovery identifier is invalid.');
  }
  const workspace = await realpath(input.workspaceRoot);
  const directory = resolve(recoveryRoot(workspace), input.recoveryId);
  const recordPath = relative(workspace, resolve(directory, 'record.json')).split(sep).join('/');
  const recordSnapshot = await snapshotStructuredTarget(workspace, recordPath, false, true);
  const record = JSON.parse(await readFile(recordSnapshot.absolute, 'utf8')) as RecoveryRecord;
  if (record.version !== 1 || record.operationId !== input.recoveryId) {
    throw new WorkspaceAccessError('The recovery record is invalid.');
  }
  const storedPath = relative(workspace, resolve(directory, basename(record.originalPath)))
    .split(sep)
    .join('/');
  const storedSnapshot = await snapshotStructuredTarget(workspace, storedPath, false, true);
  if (storedSnapshot.beforeHash !== record.beforeHash) {
    throw new WorkspaceAccessError('The recovery payload does not match its record.');
  }
  const target = await snapshotStructuredTarget(workspace, record.originalPath, true);
  if (target.kind !== 'missing') {
    throw new WorkspaceAccessError('Recovery never overwrites an existing path.');
  }
  return createOperationManifest({
    capability: 'file.restore',
    threadId: input.threadId,
    turnId: input.turnId,
    workspace,
    targets: [target, recordSnapshot, storedSnapshot].map((snapshot) => ({
      path: snapshot.path,
      kind: snapshot.kind,
      beforeHash: snapshot.beforeHash,
    })),
    argv: [input.recoveryId],
  });
};

export const executeRestoreOperation = async (
  rawManifest: unknown
): Promise<StructuredFileResult> => {
  const parsed = OperationManifestV1Schema.parse(rawManifest);
  const manifest = assertOperationManifest(parsed, {
    operationId: parsed.operationId,
    threadId: parsed.threadId,
    turnId: parsed.turnId,
    capability: 'file.restore',
  });
  const recoveryId = manifest.argv?.[0];
  const target = manifest.targets[0];
  const recordTarget = manifest.targets[1];
  const storedTarget = manifest.targets[2];
  if (
    !recoveryId ||
    !RECOVERY_ID_PATTERN.test(recoveryId) ||
    !target ||
    target.kind !== 'missing' ||
    !recordTarget ||
    !recordTarget.path.startsWith(`${RECOVERY_DIRECTORY}/${recoveryId}/`) ||
    !storedTarget ||
    !storedTarget.path.startsWith(`${RECOVERY_DIRECTORY}/${recoveryId}/`)
  ) {
    throw new WorkspaceAccessError('The restore binding is incomplete.');
  }
  await verifyStructuredTargets(manifest);
  const directory = resolve(recoveryRoot(manifest.workspace), recoveryId);
  const record = JSON.parse(
    await readFile(resolve(directory, 'record.json'), 'utf8')
  ) as RecoveryRecord;
  const stored = resolve(directory, basename(record.originalPath));
  const destination = await resolveWorkspacePath(manifest.workspace, record.originalPath, {
    allowMissing: true,
  });
  const recovered = await inventoryTree(stored);
  if (recovered.digest !== record.beforeHash) {
    throw new WorkspaceAccessError('The recovery payload changed and cannot be restored.');
  }
  await mkdir(dirname(destination.absolute), { recursive: true });
  await rename(stored, destination.absolute);
  await rm(directory, { recursive: true, force: true });
  return {
    capability: 'file.restore',
    source: record.originalPath,
    destination: record.originalPath,
    beforeHash: record.beforeHash,
    recoveryId,
  };
};
