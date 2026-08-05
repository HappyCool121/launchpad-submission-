import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type {
  GitTaskBaseline,
  OperationCapability,
  OperationManifestV1,
} from '../shared/contracts';
import { OperationManifestV1Schema } from '../shared/contracts';
import { now, sha256 } from '../shared/security';
import { assertNetworkBindingCurrent, createGitPushNetworkBinding } from './network-policy';
import { assertOperationManifest, createOperationManifest } from './operation-manifest';
import { snapshotStructuredTarget, verifyStructuredTargets } from './structured-files';
import { WorkspaceAccessError } from './workspace';

const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_HUNK_PATCH_BYTES = 256 * 1024;
const MAX_HUNK_PATCH_LINES = 254;
const GIT_TIMEOUT_MS = 5 * 60_000;
const BRANCH_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,254}$/;
const REMOTE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

interface GitCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  cancelled: boolean;
  timedOut: boolean;
}

const cappedAppend = (
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>
): { bytes: Buffer<ArrayBufferLike>; truncated: boolean } => {
  const remaining = Math.max(0, MAX_GIT_OUTPUT_BYTES - current.byteLength);
  return {
    bytes: Buffer.concat([current, chunk.subarray(0, remaining)]),
    truncated: chunk.byteLength > remaining,
  };
};

const gitEnvironment = (): NodeJS.ProcessEnv => {
  const allowed = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'ComSpec',
    'SSH_AUTH_SOCK',
    'LANG',
    'LC_ALL',
  ];
  return {
    ...Object.fromEntries(
      allowed.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))
    ),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  };
};

const runGit = async (
  workspace: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    extraConfig?: string[];
    input?: string;
  } = {}
): Promise<GitCommandResult> =>
  await new Promise((resolveRun, rejectRun) => {
    const argv = [
      '-C',
      workspace,
      '-c',
      'core.fsmonitor=false',
      ...(options.extraConfig ?? []),
      ...args,
    ];
    const child = spawn('git', argv, {
      cwd: workspace,
      detached: process.platform !== 'win32',
      env: gitEnvironment(),
      shell: false,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let cancelled = Boolean(options.signal?.aborted);
    let timedOut = false;
    let settled = false;
    const terminate = (): void => {
      const pid = child.pid;
      if (pid && process.platform !== 'win32') {
        try {
          process.kill(-pid, 'SIGTERM');
          return;
        } catch {
          // Fall through to process-local termination.
        }
      }
      child.kill('SIGTERM');
    };
    const abort = (): void => {
      cancelled = true;
      terminate();
    };
    const timeout = setTimeout(
      () => {
        timedOut = true;
        terminate();
      },
      Math.min(Math.max(options.timeoutMs ?? GIT_TIMEOUT_MS, 1), GIT_TIMEOUT_MS)
    );
    timeout.unref();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.input !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input);
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      const next = cappedAppend(stdout, chunk);
      stdout = next.bytes;
      truncated ||= next.truncated;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const next = cappedAppend(stderr, chunk);
      stderr = next.bytes;
      truncated ||= next.truncated;
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      rejectRun(error);
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      resolveRun({
        exitCode,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        truncated,
        cancelled,
        timedOut,
      });
    });
  });

const gitText = async (
  workspace: string,
  args: string[],
  optional = false
): Promise<string | null> => {
  const result = await runGit(workspace, args);
  if (result.exitCode !== 0) {
    if (optional) return null;
    throw new WorkspaceAccessError(result.stderr.trim() || `git ${args[0] ?? ''} failed.`);
  }
  return result.stdout.trim() || null;
};

const validateBranch = async (workspace: string, branch: string): Promise<void> => {
  if (!BRANCH_PATTERN.test(branch) || branch.startsWith('-') || branch.includes('..')) {
    throw new WorkspaceAccessError('The Git branch name is invalid.');
  }
  const result = await runGit(workspace, ['check-ref-format', '--branch', branch]);
  if (result.exitCode !== 0) throw new WorkspaceAccessError('The Git branch name is invalid.');
};

const assertNoExecutableGitFilters = async (workspace: string): Promise<void> => {
  const filters = await runGit(workspace, [
    'config',
    '--get-regexp',
    '^filter\\..*\\.(clean|smudge|process)$',
  ]);
  if (filters.exitCode === 0 && filters.stdout.trim()) {
    throw new WorkspaceAccessError(
      'Structured stage and switch are disabled when executable Git filters are configured.'
    );
  }
  if (filters.exitCode !== 0 && filters.exitCode !== 1) {
    throw new WorkspaceAccessError('Git filter policy could not be inspected safely.');
  }
};

const assertSafePushConfiguration = async (workspace: string): Promise<void> => {
  const rewrites = await runGit(workspace, [
    'config',
    '--get-regexp',
    '^url\\..*\\.(insteadOf|pushInsteadOf)$',
  ]);
  if (rewrites.exitCode === 0 && rewrites.stdout.trim()) {
    throw new WorkspaceAccessError(
      'Structured push is disabled when Git URL rewrite rules are configured.'
    );
  }
  if (rewrites.exitCode !== 0 && rewrites.exitCode !== 1) {
    throw new WorkspaceAccessError('Git URL rewrite policy could not be inspected safely.');
  }
};

export interface GitStateSnapshot {
  workspace: string;
  repositoryRoot: string;
  commonDirectory: string;
  headOid: string | null;
  indexTreeOid: string;
  ref: string | null;
  clean: boolean;
}

export const snapshotGitState = async (workspaceRoot: string): Promise<GitStateSnapshot> => {
  const workspace = await realpath(workspaceRoot);
  const repositoryRootValue = await gitText(workspace, ['rev-parse', '--show-toplevel']);
  if (!repositoryRootValue || !isAbsolute(repositoryRootValue)) {
    throw new WorkspaceAccessError('The workspace is not inside a Git worktree.');
  }
  const repositoryRoot = await realpath(repositoryRootValue);
  const fromRepository = relative(repositoryRoot, workspace);
  if (fromRepository === '..' || fromRepository.startsWith(`..${sep}`)) {
    throw new WorkspaceAccessError('The Git worktree does not contain the workspace.');
  }
  const commonDirectoryValue = await gitText(workspace, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!commonDirectoryValue || !isAbsolute(commonDirectoryValue)) {
    throw new WorkspaceAccessError('The Git common directory is unavailable.');
  }
  const [headOid, ref, index, status] = await Promise.all([
    gitText(workspace, ['rev-parse', '--verify', 'HEAD'], true),
    gitText(workspace, ['symbolic-ref', '--quiet', 'HEAD'], true),
    runGit(workspace, ['ls-files', '--stage', '-z']),
    runGit(workspace, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
  ]);
  if (index.exitCode !== 0 || status.exitCode !== 0) {
    throw new WorkspaceAccessError('The Git index or worktree state is unavailable.');
  }
  return {
    workspace,
    repositoryRoot,
    commonDirectory: await realpath(commonDirectoryValue),
    headOid,
    indexTreeOid: sha256(index.stdout),
    ref,
    clean: status.stdout.length === 0,
  };
};

export const captureGitTaskBaseline = async (input: {
  workspaceRoot: string;
  threadId: string;
  turnId: string;
}): Promise<GitTaskBaseline> => {
  const state = await snapshotGitState(input.workspaceRoot);
  const status = await runGit(state.workspace, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (status.exitCode !== 0) {
    throw new WorkspaceAccessError('The task-start Git status could not be captured.');
  }
  const tokens = status.stdout.split('\0');
  const rawEntries: Array<{ code: string; path: string; originalPath: string | null }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (code.length !== 2 || !path) {
      throw new WorkspaceAccessError('The task-start Git status was malformed.');
    }
    const renamed = code.includes('R') || code.includes('C');
    const originalPath = renamed ? (tokens[index + 1] ?? null) : null;
    if (renamed) index += 1;
    rawEntries.push({ code, path, originalPath });
  }
  const truncated = rawEntries.length > 2_000 || status.truncated;
  const selected = rawEntries.slice(0, 2_000);
  const statusEntries = await Promise.all(
    selected.map(async (entry) => ({
      ...entry,
      hash: await snapshotStructuredTarget(state.workspace, entry.path, true)
        .then((target) => target.beforeHash)
        .catch(() => null),
    }))
  );
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    headOid: state.headOid,
    ref: state.ref,
    indexTreeHash: state.indexTreeOid,
    statusEntries,
    truncated,
    capturedAt: now(),
  };
};

const manifestGitState = (state: GitStateSnapshot): NonNullable<OperationManifestV1['git']> => ({
  headOid: state.headOid,
  indexTreeOid: state.indexTreeOid,
  ref: state.ref,
});

export type GitWriteCapability = Extract<
  OperationCapability,
  'git.branch.create' | 'git.switch' | 'git.stage' | 'git.stage.hunk' | 'git.commit' | 'git.push'
>;

const selectedHunkPatch = async (
  workspace: string,
  path: string,
  requestedHunks: number[]
): Promise<{
  target: Awaited<ReturnType<typeof snapshotStructuredTarget>>;
  patch: string;
  patchDigest: string;
  selectedHunks: number[];
  availableHunks: number;
}> => {
  if (/\0|\r|\n/.test(path)) throw new WorkspaceAccessError('The Git hunk path is invalid.');
  const target = await snapshotStructuredTarget(workspace, path, false);
  if (target.kind !== 'file') {
    throw new WorkspaceAccessError('Hunk staging supports one existing text file at a time.');
  }
  const diff = await runGit(workspace, [
    'diff',
    '--no-ext-diff',
    '--no-renames',
    '--unified=3',
    '--',
    target.path,
  ]);
  if (diff.exitCode !== 0 || diff.truncated) {
    throw new WorkspaceAccessError('The bounded Git hunk diff is unavailable.');
  }
  if (!diff.stdout || /GIT binary patch|Binary files .* differ/.test(diff.stdout)) {
    throw new WorkspaceAccessError('Hunk staging requires a non-empty text diff.');
  }
  const lines = diff.stdout.replace(/\n$/, '').split('\n');
  if (lines.some((line) => Buffer.byteLength(line) > 8_192)) {
    throw new WorkspaceAccessError('A Git hunk line exceeds the safe review bound.');
  }
  const firstHunk = lines.findIndex((line) => line.startsWith('@@ '));
  if (firstHunk < 0) throw new WorkspaceAccessError('The Git diff has no stageable text hunks.');
  const header = lines.slice(0, firstHunk);
  if (
    !header[0]?.startsWith('diff --git ') ||
    !header.some((line) => line.startsWith('--- ')) ||
    !header.some((line) => line.startsWith('+++ '))
  ) {
    throw new WorkspaceAccessError('The Git hunk diff header is invalid.');
  }
  const hunks: string[][] = [];
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith('@@ ')) hunks.push([]);
    const current = hunks.at(-1);
    if (!current) throw new WorkspaceAccessError('The Git hunk diff is malformed.');
    current.push(line);
  }
  const selectedHunks = [...new Set(requestedHunks)].sort((left, right) => left - right);
  if (
    selectedHunks.length === 0 ||
    selectedHunks.length > 128 ||
    selectedHunks.some(
      (ordinal) => !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > hunks.length
    )
  ) {
    throw new WorkspaceAccessError(`Select hunk ordinals between 1 and ${hunks.length}.`);
  }
  const patchLines = [...header, ...selectedHunks.flatMap((ordinal) => hunks[ordinal - 1] ?? [])];
  const patch = `${patchLines.join('\n')}\n`;
  if (patchLines.length > MAX_HUNK_PATCH_LINES || Buffer.byteLength(patch) > MAX_HUNK_PATCH_BYTES) {
    throw new WorkspaceAccessError('The selected Git hunk patch exceeds the safe review bound.');
  }
  return {
    target,
    patch,
    patchDigest: sha256(patch),
    selectedHunks,
    availableHunks: hunks.length,
  };
};

export const reviewedHunkPatch = (manifest: OperationManifestV1): string | null => {
  if (manifest.capability !== 'git.stage.hunk' || !manifest.argv || manifest.argv.length < 3) {
    return null;
  }
  const patch = `${manifest.argv.slice(2).join('\n')}\n`;
  if (sha256(patch) !== manifest.argv[1]) {
    throw new WorkspaceAccessError('The reviewed Git hunk patch digest is invalid.');
  }
  return patch;
};

export const createGitOperationManifest = async (input: {
  capability: GitWriteCapability;
  threadId: string;
  turnId: string;
  workspaceRoot: string;
  branch?: string;
  paths?: string[];
  path?: string;
  hunks?: number[];
  message?: string;
  remote?: string;
  remoteRef?: string;
}): Promise<OperationManifestV1> => {
  const state = await snapshotGitState(input.workspaceRoot);
  let argv: string[];
  let targets: OperationManifestV1['targets'] = [];
  let network: OperationManifestV1['network'] = null;

  if (input.capability === 'git.branch.create') {
    const branch = input.branch ?? '';
    await validateBranch(state.workspace, branch);
    if (!state.headOid) throw new WorkspaceAccessError('An unborn branch has no start commit.');
    if (await gitText(state.workspace, ['show-ref', '--verify', `refs/heads/${branch}`], true)) {
      throw new WorkspaceAccessError('The requested local branch already exists.');
    }
    argv = [branch, state.headOid];
  } else if (input.capability === 'git.switch') {
    const branch = input.branch ?? '';
    await validateBranch(state.workspace, branch);
    if (!state.clean) {
      throw new WorkspaceAccessError('Switching branches requires a clean reviewed worktree.');
    }
    await assertNoExecutableGitFilters(state.workspace);
    const oid = await gitText(state.workspace, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    if (!oid) throw new WorkspaceAccessError('The requested local branch does not exist.');
    argv = [branch, oid];
    targets = [{ path: `refs/heads/${branch}`, kind: 'git-ref', beforeHash: oid }];
  } else if (input.capability === 'git.stage') {
    await assertNoExecutableGitFilters(state.workspace);
    const paths = [...new Set(input.paths ?? [])];
    if (paths.length === 0 || paths.length > 32) {
      throw new WorkspaceAccessError('Stage between one and 32 exact paths at a time.');
    }
    const snapshots = await Promise.all(
      paths.map((path) => snapshotStructuredTarget(state.workspace, path, true))
    );
    targets = snapshots.map((target) => ({
      path: target.path,
      kind: target.kind,
      beforeHash: target.beforeHash,
    }));
    argv = snapshots.map((target) => target.path);
  } else if (input.capability === 'git.stage.hunk') {
    await assertNoExecutableGitFilters(state.workspace);
    const selected = await selectedHunkPatch(state.workspace, input.path ?? '', input.hunks ?? []);
    targets = [
      {
        path: selected.target.path,
        kind: selected.target.kind,
        beforeHash: selected.target.beforeHash,
      },
    ];
    argv = [
      selected.target.path,
      selected.patchDigest,
      ...selected.patch.replace(/\n$/, '').split('\n'),
    ];
  } else if (input.capability === 'git.commit') {
    const message = (input.message ?? '').trim();
    if (!message || message.length > 2_000 || /[\r\n\0]/.test(message)) {
      throw new WorkspaceAccessError('Commit messages must be a bounded single line.');
    }
    const staged = await runGit(state.workspace, ['diff', '--cached', '--quiet']);
    if (staged.exitCode === 0) throw new WorkspaceAccessError('There are no staged changes.');
    if (staged.exitCode !== 1) throw new WorkspaceAccessError('The staged Git state is invalid.');
    argv = [message];
  } else {
    const remote = input.remote ?? '';
    const remoteRef = input.remoteRef ?? '';
    if (!REMOTE_PATTERN.test(remote))
      throw new WorkspaceAccessError('The Git remote name is invalid.');
    await validateBranch(state.workspace, remoteRef.replace(/^refs\/heads\//, ''));
    if (!remoteRef.startsWith('refs/heads/')) {
      throw new WorkspaceAccessError('Push destinations must be an exact branch ref.');
    }
    if (!state.headOid) throw new WorkspaceAccessError('There is no commit to push.');
    await assertSafePushConfiguration(state.workspace);
    const remoteUrl = await gitText(state.workspace, ['remote', 'get-url', '--push', remote]);
    if (!remoteUrl) throw new WorkspaceAccessError('The Git push remote is unavailable.');
    network = await createGitPushNetworkBinding(remoteUrl);
    argv = [remote, `${state.headOid}:${remoteRef}`];
  }

  return createOperationManifest({
    capability: input.capability,
    threadId: input.threadId,
    turnId: input.turnId,
    workspace: state.workspace,
    targets,
    argv,
    network,
    git: manifestGitState(state),
  });
};

const assertGitState = async (manifest: OperationManifestV1): Promise<GitStateSnapshot> => {
  const current = await snapshotGitState(manifest.workspace);
  const expected = manifest.git;
  if (
    !expected ||
    current.headOid !== expected.headOid ||
    current.indexTreeOid !== expected.indexTreeOid ||
    current.ref !== expected.ref
  ) {
    throw new WorkspaceAccessError('The reviewed Git state changed before execution.');
  }
  await verifyStructuredTargets(manifest);
  return current;
};

export const executeGitOperation = async (
  rawManifest: unknown,
  signal?: AbortSignal
): Promise<Record<string, unknown>> => {
  const parsed = OperationManifestV1Schema.parse(rawManifest);
  if (!parsed.capability.startsWith('git.')) {
    throw new WorkspaceAccessError('The manifest is not a Git operation.');
  }
  const manifest = assertOperationManifest(parsed, {
    operationId: parsed.operationId,
    threadId: parsed.threadId,
    turnId: parsed.turnId,
    capability: parsed.capability,
  });
  const state = await assertGitState(manifest);
  const argv = manifest.argv;
  if (!argv) throw new WorkspaceAccessError('The Git operation arguments are unavailable.');
  const hooks = await mkdtemp(join(tmpdir(), 'adrouter-empty-git-hooks-'));
  try {
    let args: string[];
    let input: string | undefined;
    let extraConfig = ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgSign=false'];
    if (manifest.capability === 'git.branch.create') {
      if (argv.length !== 2) throw new WorkspaceAccessError('The branch binding is invalid.');
      await validateBranch(state.workspace, argv[0] ?? '');
      args = ['branch', '--no-track', argv[0] ?? '', argv[1] ?? ''];
    } else if (manifest.capability === 'git.switch') {
      if (argv.length !== 2 || !state.clean) {
        throw new WorkspaceAccessError('The switch binding is invalid or the worktree is dirty.');
      }
      const currentTarget = await gitText(state.workspace, [
        'rev-parse',
        '--verify',
        `refs/heads/${argv[0] ?? ''}`,
      ]);
      if (currentTarget !== argv[1]) {
        throw new WorkspaceAccessError('The reviewed switch target changed.');
      }
      await assertNoExecutableGitFilters(state.workspace);
      args = ['switch', argv[0] ?? ''];
    } else if (manifest.capability === 'git.stage') {
      if (argv.length === 0 || argv.length > 32) {
        throw new WorkspaceAccessError('The stage binding is invalid.');
      }
      await assertNoExecutableGitFilters(state.workspace);
      args = ['add', '--', ...argv];
    } else if (manifest.capability === 'git.stage.hunk') {
      if (
        argv.length < 3 ||
        manifest.targets.length !== 1 ||
        argv[0] !== manifest.targets[0]?.path
      ) {
        throw new WorkspaceAccessError('The hunk stage binding is invalid.');
      }
      await assertNoExecutableGitFilters(state.workspace);
      input = reviewedHunkPatch(manifest) ?? undefined;
      if (!input || Buffer.byteLength(input) > MAX_HUNK_PATCH_BYTES) {
        throw new WorkspaceAccessError('The reviewed Git hunk patch is unavailable.');
      }
      args = ['apply', '--cached', '--whitespace=nowarn', '-'];
    } else if (manifest.capability === 'git.commit') {
      if (argv.length !== 1 || !argv[0] || /[\r\n\0]/.test(argv[0])) {
        throw new WorkspaceAccessError('The commit binding is invalid.');
      }
      args = ['commit', '-m', argv[0]];
    } else if (manifest.capability === 'git.push') {
      const network = manifest.network;
      if (network?.method !== 'GIT_PUSH' || argv.length !== 2) {
        throw new WorkspaceAccessError('The push binding is invalid.');
      }
      await assertSafePushConfiguration(state.workspace);
      const currentRemoteUrl = await gitText(state.workspace, [
        'remote',
        'get-url',
        '--push',
        argv[0] ?? '',
      ]);
      if (!currentRemoteUrl) throw new WorkspaceAccessError('The Git push remote is unavailable.');
      const currentNetwork = await createGitPushNetworkBinding(currentRemoteUrl);
      if (
        currentNetwork.url !== network.url ||
        currentNetwork.host !== network.host ||
        JSON.stringify(currentNetwork.resolvedAddresses) !==
          JSON.stringify(network.resolvedAddresses)
      ) {
        throw new WorkspaceAccessError('The reviewed Git remote or DNS binding changed.');
      }
      await assertNetworkBindingCurrent(network);
      const pinned = network.resolvedAddresses[0];
      if (!pinned) throw new WorkspaceAccessError('The approved Git address is unavailable.');
      extraConfig = [
        ...extraConfig,
        '-c',
        `http.curloptResolve=${network.host}:443:${pinned}`,
        '-c',
        'http.proxy=',
      ];
      args = ['push', '--porcelain', network.url, argv[1] ?? ''];
    } else {
      throw new WorkspaceAccessError('The Git capability is not supported.');
    }
    const result = await runGit(state.workspace, args, {
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
      extraConfig,
      input,
    });
    return {
      argv:
        manifest.capability === 'git.stage.hunk'
          ? ['git', 'apply', '--cached', `<reviewed-patch:${argv[1]}>`]
          : ['git', ...args],
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      cancelled: result.cancelled,
      timedOut: result.timedOut,
      before: manifest.git,
      after:
        manifest.capability === 'git.push'
          ? manifest.git
          : manifestGitState(await snapshotGitState(state.workspace)),
    };
  } finally {
    await rm(hooks, { recursive: true, force: true });
  }
};
