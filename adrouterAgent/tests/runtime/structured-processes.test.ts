import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxedCommandRunner } from '@/runtime/command-runner';
import {
  createScriptOperationManifest,
  executeApprovedScript,
} from '@/runtime/structured-processes';

const directories: string[] = [];
const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('structured package scripts', () => {
  it('binds an exact safe script and executes it through the sandbox runner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'adrouter-script-'));
    directories.push(root);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: 'npm@11', scripts: { test: 'vitest run' } })
    );
    const manifest = await createScriptOperationManifest({
      capability: 'script.run',
      threadId,
      turnId,
      workspaceRoot: root,
      script: 'test',
    });
    const run = vi.fn().mockResolvedValue({
      argv: ['npm', 'run', 'test'],
      exitCode: 0,
      stdout: 'passed\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      cancelled: false,
      durationMs: 10,
    });

    await expect(
      executeApprovedScript(manifest, { run } as unknown as SandboxedCommandRunner)
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'passed\n' });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ['npm', 'run', 'test'],
        cwd: await realpath(root),
        workspaceWriteAllowed: true,
      })
    );
  });

  it('rejects arbitrary safe-tier names and stale package manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'adrouter-script-'));
    directories.push(root);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node test.js', postinstall: 'node install.js' } })
    );
    await expect(
      createScriptOperationManifest({
        capability: 'script.run',
        threadId,
        turnId,
        workspaceRoot: root,
        script: 'postinstall',
      })
    ).rejects.toThrow('limited');
    const manifest = await createScriptOperationManifest({
      capability: 'dependency.lifecycle',
      threadId,
      turnId,
      workspaceRoot: root,
      script: 'postinstall',
    });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { postinstall: 'false' } })
    );

    await expect(
      executeApprovedScript(manifest, { run: vi.fn() } as unknown as SandboxedCommandRunner)
    ).rejects.toThrow('changed');
  });
});
