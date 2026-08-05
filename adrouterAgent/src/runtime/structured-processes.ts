import { access, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { OperationManifestV1 } from '../shared/contracts';
import { OperationManifestV1Schema } from '../shared/contracts';
import { safeRecord } from '../shared/security';
import type { SandboxedCommandRunner } from './command-runner';
import { assertOperationManifest, createOperationManifest } from './operation-manifest';
import { snapshotStructuredTarget, verifyStructuredTargets } from './structured-files';
import { readWorkspaceTextFile, WorkspaceAccessError } from './workspace';

const SAFE_SCRIPT_NAMES = new Set(['test', 'build', 'lint', 'format', 'check', 'typecheck']);
const SCRIPT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/;

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const readPackageJson = async (
  workspace: string
): Promise<{ scripts: Record<string, string>; packageManager: PackageManager }> => {
  const file = await readWorkspaceTextFile(workspace, 'package.json');
  let parsed: Record<string, unknown>;
  try {
    parsed = safeRecord(JSON.parse(file.content));
  } catch {
    throw new WorkspaceAccessError('package.json is not valid JSON.');
  }
  const scriptsValue = safeRecord(parsed.scripts);
  const scripts = Object.fromEntries(
    Object.entries(scriptsValue).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
  const declared = typeof parsed.packageManager === 'string' ? parsed.packageManager : '';
  const manager: PackageManager = declared.startsWith('pnpm@')
    ? 'pnpm'
    : declared.startsWith('yarn@')
      ? 'yarn'
      : declared.startsWith('npm@')
        ? 'npm'
        : (await exists(resolve(workspace, 'pnpm-lock.yaml')))
          ? 'pnpm'
          : (await exists(resolve(workspace, 'yarn.lock')))
            ? 'yarn'
            : 'npm';
  return { scripts, packageManager: manager };
};

const scriptArgv = (manager: PackageManager, script: string): string[] =>
  manager === 'yarn' ? ['yarn', 'run', script] : [manager, 'run', script];

export const createScriptOperationManifest = async (input: {
  capability: 'script.run' | 'dependency.lifecycle';
  threadId: string;
  turnId: string;
  workspaceRoot: string;
  script: string;
}): Promise<OperationManifestV1> => {
  if (!SCRIPT_NAME_PATTERN.test(input.script)) {
    throw new WorkspaceAccessError('The package script name is invalid.');
  }
  if (input.capability === 'script.run' && !SAFE_SCRIPT_NAMES.has(input.script)) {
    throw new WorkspaceAccessError(
      'Structured script execution is limited to test, build, lint, format, check, and typecheck.'
    );
  }
  const workspace = await realpath(input.workspaceRoot);
  const packageJson = await readPackageJson(workspace);
  const packageSnapshot = await snapshotStructuredTarget(workspace, 'package.json');
  if (!packageJson.scripts[input.script]) {
    throw new WorkspaceAccessError(`package.json does not define the ${input.script} script.`);
  }
  return createOperationManifest({
    capability: input.capability,
    threadId: input.threadId,
    turnId: input.turnId,
    workspace,
    targets: [
      {
        path: packageSnapshot.path,
        kind: packageSnapshot.kind,
        beforeHash: packageSnapshot.beforeHash,
      },
    ],
    argv: scriptArgv(packageJson.packageManager, input.script),
  });
};

export const executeApprovedScript = async (
  rawManifest: unknown,
  runner: SandboxedCommandRunner,
  signal?: AbortSignal
): Promise<Record<string, unknown>> => {
  const parsed = OperationManifestV1Schema.parse(rawManifest);
  if (!['script.run', 'dependency.lifecycle'].includes(parsed.capability)) {
    throw new WorkspaceAccessError('The manifest is not a structured script operation.');
  }
  const manifest = assertOperationManifest(parsed, {
    operationId: parsed.operationId,
    threadId: parsed.threadId,
    turnId: parsed.turnId,
    capability: parsed.capability,
  });
  await verifyStructuredTargets(manifest);
  const packageJson = await readPackageJson(manifest.workspace);
  const argv = manifest.argv;
  const script = argv?.[2];
  if (
    !argv ||
    !script ||
    !SCRIPT_NAME_PATTERN.test(script) ||
    !packageJson.scripts[script] ||
    JSON.stringify(argv) !== JSON.stringify(scriptArgv(packageJson.packageManager, script)) ||
    (manifest.capability === 'script.run' && !SAFE_SCRIPT_NAMES.has(script))
  ) {
    throw new WorkspaceAccessError('The approved package script binding is invalid.');
  }
  const result = await runner.run({
    argv,
    cwd: manifest.workspace,
    workspaceWriteAllowed: true,
    timeoutMs: 15 * 60_000,
    signal,
  });
  return {
    argv: result.argv,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    durationMs: result.durationMs,
  };
};
