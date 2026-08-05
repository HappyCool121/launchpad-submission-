import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { OperationManifestV1 } from '../shared/contracts';
import { OperationManifestV1Schema } from '../shared/contracts';
import { createId, safeRecord, sha256 } from '../shared/security';
import type { SandboxedCommandRunner } from './command-runner';
import { assertOperationManifest, createOperationManifest } from './operation-manifest';
import { snapshotStructuredTarget, verifyStructuredTargets } from './structured-files';
import type { PackageManager } from './structured-processes';
import { WorkspaceAccessError } from './workspace';

const MAX_DEPENDENCY_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PROPOSALS = 16;
const PROPOSAL_LIFETIME_MS = 15 * 60_000;
const PACKAGE_SPEC_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[~^]?[a-z0-9][a-z0-9._+~-]*)?$/i;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;

const DependencyTargetSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    kind: z.enum(['file', 'missing']),
    beforeHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();

export const DependencyPreviewResultSchema = z
  .object({
    previewId: z.uuid(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    workspace: z.string().min(1).max(4_096),
    manager: z.enum(['npm', 'pnpm', 'yarn']),
    action: z.enum(['add', 'remove']),
    packageSpec: z.string().min(1).max(300),
    targets: z.array(DependencyTargetSchema).min(2).max(2),
    changes: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4_096),
            beforeHash: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .nullable(),
            afterHash: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .nullable(),
            beforeBytes: z.number().int().nonnegative().max(MAX_DEPENDENCY_FILE_BYTES),
            afterBytes: z.number().int().nonnegative().max(MAX_DEPENDENCY_FILE_BYTES),
          })
          .strict()
      )
      .min(1)
      .max(2),
    dependencyChanges: z.array(
      z
        .object({
          section: z.enum([
            'dependencies',
            'devDependencies',
            'optionalDependencies',
            'peerDependencies',
          ]),
          name: z.string(),
          before: z.string().nullable(),
          after: z.string().nullable(),
        })
        .strict()
    ),
    command: z.array(z.string()).min(2).max(16),
    commandOutput: z
      .object({
        stdout: z.string().max(1024 * 1024),
        stderr: z.string().max(1024 * 1024),
        truncated: z.boolean(),
      })
      .strict(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type DependencyPreviewResult = z.infer<typeof DependencyPreviewResultSchema>;

const lockPath = (manager: PackageManager): string =>
  manager === 'pnpm' ? 'pnpm-lock.yaml' : manager === 'yarn' ? 'yarn.lock' : 'package-lock.json';

const packageCommand = (input: {
  manager: PackageManager;
  action: 'add' | 'remove';
  packageSpec: string;
  dev: boolean;
}): string[] => {
  const { manager, action, packageSpec, dev } = input;
  if (manager === 'npm') {
    return [
      'npm',
      action === 'add' ? 'install' : 'uninstall',
      packageSpec,
      '--package-lock-only',
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
      ...(dev && action === 'add' ? ['--save-dev'] : []),
    ];
  }
  if (manager === 'pnpm') {
    return [
      'pnpm',
      action,
      packageSpec,
      '--lockfile-only',
      '--ignore-scripts',
      '--offline',
      ...(dev && action === 'add' ? ['--save-dev'] : []),
    ];
  }
  return [
    'yarn',
    action,
    packageSpec,
    '--ignore-scripts',
    '--offline',
    ...(dev && action === 'add' ? ['--dev'] : []),
  ];
};

const inferCommand = (
  argv: string[]
): { manager: PackageManager; action: 'add' | 'remove'; packageSpec: string } => {
  const manager = argv[0];
  const rawAction = argv[1];
  const packageSpec = argv[2] ?? '';
  if (!['npm', 'pnpm', 'yarn'].includes(manager ?? '')) {
    throw new WorkspaceAccessError('The dependency package manager is invalid.');
  }
  const action =
    rawAction === 'install' || rawAction === 'add'
      ? 'add'
      : rawAction === 'uninstall' || rawAction === 'remove'
        ? 'remove'
        : undefined;
  if (!action) throw new WorkspaceAccessError('The dependency action is invalid.');
  if (
    !(action === 'remove' ? PACKAGE_NAME_PATTERN : PACKAGE_SPEC_PATTERN).test(packageSpec) ||
    packageSpec.includes('..')
  ) {
    throw new WorkspaceAccessError('Only bounded registry package names and versions are allowed.');
  }
  const expected = packageCommand({
    manager: manager as PackageManager,
    action,
    packageSpec,
    dev: argv.includes(manager === 'yarn' ? '--dev' : '--save-dev'),
  });
  if (JSON.stringify(expected) !== JSON.stringify(argv)) {
    throw new WorkspaceAccessError('The dependency preview command binding is invalid.');
  }
  return { manager: manager as PackageManager, action, packageSpec };
};

export const createDependencyPreviewManifest = async (input: {
  threadId: string;
  turnId: string;
  workspaceRoot: string;
  manager: PackageManager;
  action: 'add' | 'remove';
  packageSpec: string;
  dev?: boolean;
}): Promise<OperationManifestV1> => {
  if (
    !(input.action === 'remove' ? PACKAGE_NAME_PATTERN : PACKAGE_SPEC_PATTERN).test(
      input.packageSpec
    ) ||
    input.packageSpec.includes('..')
  ) {
    throw new WorkspaceAccessError('Only bounded registry package names and versions are allowed.');
  }
  const workspace = await realpath(input.workspaceRoot);
  const targets = await Promise.all([
    snapshotStructuredTarget(workspace, 'package.json'),
    snapshotStructuredTarget(workspace, lockPath(input.manager), true),
  ]);
  return createOperationManifest({
    capability: 'dependency.preview',
    threadId: input.threadId,
    turnId: input.turnId,
    workspace,
    targets: targets.map((target) => ({
      path: target.path,
      kind: target.kind,
      beforeHash: target.beforeHash,
    })),
    argv: packageCommand({ ...input, dev: input.dev ?? false }),
  });
};

export const createDependencyApplyManifest = (input: {
  threadId: string;
  turnId: string;
  preview: DependencyPreviewResult;
}): OperationManifestV1 => {
  const preview = DependencyPreviewResultSchema.parse(input.preview);
  if (Date.parse(preview.expiresAt) <= Date.now()) {
    throw new WorkspaceAccessError('The dependency preview expired.');
  }
  return createOperationManifest({
    capability: 'dependency.apply',
    threadId: input.threadId,
    turnId: input.turnId,
    workspace: preview.workspace,
    targets: preview.targets,
    argv: [preview.previewId, preview.digest],
  });
};

const readBoundedFile = async (path: string, optional = false): Promise<Buffer | null> => {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new WorkspaceAccessError('Dependency manifests must be regular files.');
    }
    if (metadata.size > MAX_DEPENDENCY_FILE_BYTES) {
      throw new WorkspaceAccessError('A dependency manifest exceeds the 5 MiB limit.');
    }
    return await readFile(path);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const dependencyMap = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(safeRecord(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );

const canonicalJson = (value: unknown): string => {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!candidate || typeof candidate !== 'object') return candidate;
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)])
    );
  };
  return JSON.stringify(normalize(value));
};

const inspectPackageChange = (
  beforeBytes: Buffer,
  afterBytes: Buffer
): DependencyPreviewResult['dependencyChanges'] => {
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  try {
    before = safeRecord(JSON.parse(beforeBytes.toString('utf8')));
    after = safeRecord(JSON.parse(afterBytes.toString('utf8')));
  } catch {
    throw new WorkspaceAccessError('The dependency preview produced invalid package.json data.');
  }
  const dependencySections = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ] as const;
  const beforeWithoutDependencies = { ...before };
  const afterWithoutDependencies = { ...after };
  for (const section of dependencySections) {
    delete beforeWithoutDependencies[section];
    delete afterWithoutDependencies[section];
  }
  if (canonicalJson(beforeWithoutDependencies) !== canonicalJson(afterWithoutDependencies)) {
    throw new WorkspaceAccessError(
      'The package manager changed fields outside the approved dependency sections.'
    );
  }
  return dependencySections.flatMap((section) => {
    const oldValues = dependencyMap(before[section]);
    const newValues = dependencyMap(after[section]);
    return [...new Set([...Object.keys(oldValues), ...Object.keys(newValues)])]
      .sort()
      .flatMap((name) =>
        oldValues[name] === newValues[name]
          ? []
          : [
              {
                section,
                name,
                before: oldValues[name] ?? null,
                after: newValues[name] ?? null,
              },
            ]
      );
  });
};

interface StoredProposal {
  result: DependencyPreviewResult;
  files: Array<{ path: string; before: Buffer | null; after: Buffer | null; mode: number }>;
  threadId: string;
  turnId: string;
}

const proposalDigest = (input: Omit<DependencyPreviewResult, 'digest' | 'commandOutput'>): string =>
  sha256(JSON.stringify(input));

const writeAtomically = async (path: string, bytes: Buffer | null, mode: number): Promise<void> => {
  if (bytes === null) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
  const temporary = resolve(dirname(path), `.${basename(path)}.adrouter-dependency-${createId()}`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

export class DependencyOperationBroker {
  private readonly proposals = new Map<string, StoredProposal>();

  public constructor(private readonly runner: SandboxedCommandRunner) {}

  private prune(): void {
    const current = Date.now();
    for (const [id, proposal] of this.proposals) {
      if (Date.parse(proposal.result.expiresAt) <= current) this.proposals.delete(id);
    }
  }

  public async preview(
    rawManifest: unknown,
    signal?: AbortSignal
  ): Promise<DependencyPreviewResult> {
    this.prune();
    if (this.proposals.size >= MAX_PROPOSALS) {
      throw new WorkspaceAccessError('Too many dependency previews are awaiting a decision.');
    }
    const parsed = OperationManifestV1Schema.parse(rawManifest);
    const manifest = assertOperationManifest(parsed, {
      operationId: parsed.operationId,
      threadId: parsed.threadId,
      turnId: parsed.turnId,
      capability: 'dependency.preview',
    });
    await verifyStructuredTargets(manifest);
    const argv = manifest.argv;
    if (!argv) throw new WorkspaceAccessError('The dependency preview arguments are missing.');
    const command = inferCommand(argv);
    const expectedLock = lockPath(command.manager);
    if (
      manifest.targets.length !== 2 ||
      manifest.targets[0]?.path !== 'package.json' ||
      manifest.targets[1]?.path !== expectedLock
    ) {
      throw new WorkspaceAccessError('The dependency preview targets are invalid.');
    }

    const mirror = await mkdtemp(join(tmpdir(), 'adrouter-dependency-preview-'));
    try {
      const files = await Promise.all(
        manifest.targets.map(async (target) => {
          const source = resolve(manifest.workspace, target.path);
          const before = await readBoundedFile(source, target.kind === 'missing');
          if (before)
            await writeFile(resolve(mirror, target.path), before, { flag: 'wx', mode: 0o600 });
          const mode = before ? (await lstat(source)).mode & 0o777 : 0o600;
          return { path: target.path, before, after: null as Buffer | null, mode };
        })
      );
      const run = await this.runner.run({
        argv,
        cwd: mirror,
        workspaceWriteAllowed: true,
        timeoutMs: 5 * 60_000,
        signal,
      });
      if (run.cancelled || run.timedOut || run.exitCode !== 0) {
        throw new WorkspaceAccessError(
          `Dependency preview failed safely in its temporary mirror: ${(run.stderr || run.stdout).slice(0, 2_000)}`
        );
      }
      for (const file of files) {
        file.after = await readBoundedFile(
          resolve(mirror, file.path),
          file.path !== 'package.json'
        );
      }
      const packageFile = files[0];
      if (!packageFile?.before || !packageFile.after) {
        throw new WorkspaceAccessError('The dependency preview did not preserve package.json.');
      }
      const dependencyChanges = inspectPackageChange(packageFile.before, packageFile.after);
      if (dependencyChanges.length === 0) {
        throw new WorkspaceAccessError('The dependency preview produced no dependency change.');
      }
      const previewId = createId();
      const expiresAt = new Date(Date.now() + PROPOSAL_LIFETIME_MS).toISOString();
      const changes = files.map((file) => ({
        path: file.path,
        beforeHash: file.before ? sha256(file.before) : null,
        afterHash: file.after ? sha256(file.after) : null,
        beforeBytes: file.before?.byteLength ?? 0,
        afterBytes: file.after?.byteLength ?? 0,
      }));
      const unsigned = {
        previewId,
        workspace: manifest.workspace,
        manager: command.manager,
        action: command.action,
        packageSpec: command.packageSpec,
        targets: manifest.targets.map(({ path, kind, beforeHash }) => ({
          path,
          kind: kind as 'file' | 'missing',
          beforeHash,
        })),
        changes,
        dependencyChanges,
        command: argv,
        expiresAt,
      };
      const result = DependencyPreviewResultSchema.parse({
        ...unsigned,
        digest: proposalDigest(unsigned),
        commandOutput: {
          stdout: run.stdout,
          stderr: run.stderr,
          truncated: run.stdoutTruncated || run.stderrTruncated,
        },
      });
      this.proposals.set(previewId, {
        result,
        files,
        threadId: manifest.threadId,
        turnId: manifest.turnId,
      });
      return result;
    } finally {
      await rm(mirror, { recursive: true, force: true });
    }
  }

  public async apply(rawManifest: unknown): Promise<Record<string, unknown>> {
    this.prune();
    const parsed = OperationManifestV1Schema.parse(rawManifest);
    const manifest = assertOperationManifest(parsed, {
      operationId: parsed.operationId,
      threadId: parsed.threadId,
      turnId: parsed.turnId,
      capability: 'dependency.apply',
    });
    const previewId = manifest.argv?.[0];
    const digest = manifest.argv?.[1];
    if (!previewId || !digest) {
      throw new WorkspaceAccessError('The dependency apply binding is incomplete.');
    }
    const proposal = previewId ? this.proposals.get(previewId) : undefined;
    if (
      !proposal ||
      proposal.threadId !== manifest.threadId ||
      proposal.turnId !== manifest.turnId ||
      proposal.result.digest !== digest ||
      proposal.result.workspace !== manifest.workspace ||
      JSON.stringify(proposal.result.targets) !== JSON.stringify(manifest.targets)
    ) {
      throw new WorkspaceAccessError('The dependency apply request does not match its preview.');
    }
    await verifyStructuredTargets(manifest);
    const applied: string[] = [];
    try {
      for (const file of proposal.files) {
        await writeAtomically(resolve(manifest.workspace, file.path), file.after, file.mode);
        applied.push(file.path);
      }
    } catch (error) {
      for (const file of proposal.files) {
        if (!applied.includes(file.path)) continue;
        await writeAtomically(resolve(manifest.workspace, file.path), file.before, file.mode).catch(
          () => undefined
        );
      }
      throw error;
    }
    this.proposals.delete(previewId);
    return {
      previewId,
      digest,
      applied,
      lifecycleScriptsExecuted: false,
    };
  }
}
