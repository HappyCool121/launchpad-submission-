import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxedCommandRunner } from '@/runtime/command-runner';
import {
  createDependencyApplyManifest,
  createDependencyPreviewManifest,
  DependencyOperationBroker,
} from '@/runtime/dependency-operations';

const directories: string[] = [];
const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const setup = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'adrouter-dependency-'));
  directories.push(root);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      scripts: { postinstall: 'node install.js' },
      dependencies: {},
    })
  );
  return root;
};

const previewRunner = (mutateOtherField = false): SandboxedCommandRunner =>
  ({
    run: vi.fn(async (input: { cwd: string; argv: string[] }) => {
      const path = join(input.cwd, 'package.json');
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      parsed.dependencies = { example: '1.2.3' };
      if (mutateOtherField) parsed.name = 'unexpected';
      await writeFile(path, JSON.stringify(parsed));
      await writeFile(join(input.cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
      return {
        argv: input.argv,
        exitCode: 0,
        stdout: 'offline preview complete\n',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        cancelled: false,
        durationMs: 5,
      };
    }),
  }) as unknown as SandboxedCommandRunner;

describe('dependency preview and apply', () => {
  it('previews in a mirror and applies exact manifest/lock bytes with no lifecycle', async () => {
    const root = await setup();
    const runner = previewRunner();
    const broker = new DependencyOperationBroker(runner);
    const previewManifest = await createDependencyPreviewManifest({
      threadId,
      turnId,
      workspaceRoot: root,
      manager: 'npm',
      action: 'add',
      packageSpec: 'example@1.2.3',
    });
    const preview = await broker.preview(previewManifest);

    expect(preview.dependencyChanges).toEqual([
      {
        section: 'dependencies',
        name: 'example',
        before: null,
        after: '1.2.3',
      },
    ]);
    expect(preview.command).toContain('--ignore-scripts');
    expect(preview.command).toContain('--offline');
    await expect(readFile(join(root, 'package-lock.json'))).rejects.toThrow();

    const apply = createDependencyApplyManifest({ threadId, turnId, preview });
    await expect(broker.apply(apply)).resolves.toMatchObject({
      applied: ['package.json', 'package-lock.json'],
      lifecycleScriptsExecuted: false,
    });
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toMatchObject({
      name: 'fixture',
      scripts: { postinstall: 'node install.js' },
      dependencies: { example: '1.2.3' },
    });
    await expect(broker.apply(apply)).rejects.toThrow('does not match');
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      cwd: expect.not.stringContaining(await realpath(root)),
      workspaceWriteAllowed: true,
    });
  });

  it('rejects stale workspace state and unrelated package.json mutations', async () => {
    const root = await setup();
    const broker = new DependencyOperationBroker(previewRunner());
    const manifest = await createDependencyPreviewManifest({
      threadId,
      turnId,
      workspaceRoot: root,
      manager: 'npm',
      action: 'add',
      packageSpec: 'example@1.2.3',
    });
    const preview = await broker.preview(manifest);
    const apply = createDependencyApplyManifest({ threadId, turnId, preview });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'changed' }));
    await expect(broker.apply(apply)).rejects.toThrow('changed');

    const otherRoot = await setup();
    const unsafeBroker = new DependencyOperationBroker(previewRunner(true));
    const unsafeManifest = await createDependencyPreviewManifest({
      threadId,
      turnId,
      workspaceRoot: otherRoot,
      manager: 'npm',
      action: 'add',
      packageSpec: 'example@1.2.3',
    });
    await expect(unsafeBroker.preview(unsafeManifest)).rejects.toThrow('outside');
  });

  it('rejects path, URL, and Git dependency specifications', async () => {
    const root = await setup();
    for (const packageSpec of ['../outside', 'file:../outside', 'https://example.com/a.tgz']) {
      await expect(
        createDependencyPreviewManifest({
          threadId,
          turnId,
          workspaceRoot: root,
          manager: 'npm',
          action: 'add',
          packageSpec,
        })
      ).rejects.toThrow('registry');
    }
  });
});
