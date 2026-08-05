import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRestoreManifest,
  createStructuredFileManifest,
  executeRestoreOperation,
  executeStructuredFileOperation,
} from '@/runtime/structured-files';

const directories: string[] = [];
const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';

const workspace = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'adrouter-structured-files-'));
  directories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('structured file operations', () => {
  it('copies only the reviewed source state without overwriting', async () => {
    const root = await workspace();
    await writeFile(join(root, 'source.txt'), 'reviewed\n');
    const manifest = await createStructuredFileManifest({
      capability: 'file.copy',
      threadId,
      turnId,
      workspaceRoot: root,
      source: 'source.txt',
      destination: 'nested/copy.txt',
    });

    await executeStructuredFileOperation(manifest);
    await expect(readFile(join(root, 'nested/copy.txt'), 'utf8')).resolves.toBe('reviewed\n');
    await expect(executeStructuredFileOperation(manifest)).rejects.toThrow('changed');
  });

  it('fails closed when a reviewed source changes', async () => {
    const root = await workspace();
    await writeFile(join(root, 'source.txt'), 'before\n');
    const manifest = await createStructuredFileManifest({
      capability: 'file.move',
      threadId,
      turnId,
      workspaceRoot: root,
      source: 'source.txt',
      destination: 'destination.txt',
    });
    await writeFile(join(root, 'source.txt'), 'after\n');

    await expect(executeStructuredFileOperation(manifest)).rejects.toThrow('changed');
  });

  it('deletes into a bounded vault and restores a hash-bound payload', async () => {
    const root = await workspace();
    await writeFile(join(root, 'source.txt'), 'recover me\n');
    const deletion = await createStructuredFileManifest({
      capability: 'file.delete',
      threadId,
      turnId,
      workspaceRoot: root,
      source: 'source.txt',
    });
    const deleted = await executeStructuredFileOperation(deletion);
    expect(deleted.recoveryId).toBe(deletion.operationId);
    await expect(readFile(join(root, 'source.txt'), 'utf8')).rejects.toThrow();

    const restore = await createRestoreManifest({
      threadId,
      turnId,
      workspaceRoot: root,
      recoveryId: deletion.operationId,
    });
    await executeRestoreOperation(restore);
    await expect(readFile(join(root, 'source.txt'), 'utf8')).resolves.toBe('recover me\n');
  });

  it('rejects traversal, vault traversal, and symbolic-link sources', async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, 'outside.txt'), 'outside\n');

    await expect(
      createStructuredFileManifest({
        capability: 'file.delete',
        threadId,
        turnId,
        workspaceRoot: root,
        source: '../outside.txt',
      })
    ).rejects.toThrow('traversal');
    await expect(
      createRestoreManifest({
        threadId,
        turnId,
        workspaceRoot: root,
        recoveryId: '../../outside-record-0000000000000000',
      })
    ).rejects.toThrow('identifier');

    if (process.platform !== 'win32') {
      await symlink(join(outside, 'outside.txt'), join(root, 'linked.txt'));
      await expect(
        createStructuredFileManifest({
          capability: 'file.copy',
          threadId,
          turnId,
          workspaceRoot: root,
          source: 'linked.txt',
          destination: 'copy.txt',
        })
      ).rejects.toThrow(/Symlinks|symbolic links/);
    }
  });
});
