import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandSandbox, SandboxUnavailableError } from '@/runtime/sandbox';

const directories: string[] = [];
const sandboxes: CommandSandbox[] = [];

const runWrapped = async (
  argv: string[],
  cwd: string,
  sandbox: CommandSandbox
): Promise<number | null> => {
  const wrapped = await sandbox.wrap(cwd, argv, undefined, false);
  const executable = wrapped.argv[0];
  if (!executable) {
    throw new Error('Sandbox returned an empty argv.');
  }
  return await new Promise<number | null>((resolveRun, rejectRun) => {
    const child = spawn(executable, wrapped.argv.slice(1), {
      cwd,
      env: wrapped.env,
    });
    child.once('error', rejectRun);
    child.once('close', resolveRun);
  });
};

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.reset()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('operating-system command sandbox', () => {
  it('allows a safe read command but blocks a read-only workspace write', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'adrouter-sandbox-'));
    directories.push(workspace);
    const sandbox = new CommandSandbox();
    sandboxes.push(sandbox);

    try {
      await expect(runWrapped(['pwd'], workspace, sandbox)).resolves.toBe(0);
      await expect(
        runWrapped(
          ['node', '-e', 'require("node:fs").writeFileSync("blocked.txt", "x")'],
          workspace,
          sandbox
        )
      ).resolves.not.toBe(0);
      await expect(access(join(workspace, 'blocked.txt'), constants.F_OK)).rejects.toBeDefined();
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxUnavailableError);
    }
  });
});
