import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyWorkspacePatch,
  listWorkspaceFiles,
  listWorkspaceFilesPage,
  readWorkspaceTextFile,
  readWorkspaceTextRange,
  resolveWorkspacePath,
  searchWorkspaceText,
  searchWorkspaceTextPage,
  WorkspaceAccessError,
} from '@/runtime/workspace';
import { sha256 } from '@/shared/security';

const roots: string[] = [];
const workspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'adrouter-workspace-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace tools', () => {
  it('blocks protected paths, traversal, and out-of-workspace symlinks', async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), 'adrouter-outside-'));
    roots.push(outside);
    await writeFile(join(root, '.env'), 'TOP_SECRET=value');
    await writeFile(join(outside, 'outside.txt'), 'outside');
    await symlink(join(outside, 'outside.txt'), join(root, 'link.txt'));

    await expect(resolveWorkspacePath(root, '../outside.txt')).rejects.toBeInstanceOf(
      WorkspaceAccessError
    );
    await expect(readWorkspaceTextFile(root, '.env')).rejects.toBeInstanceOf(WorkspaceAccessError);
    await expect(readWorkspaceTextFile(root, 'link.txt')).rejects.toBeInstanceOf(
      WorkspaceAccessError
    );
  });

  it('uses hash-checked atomic exact-block patches and preserves baseline input', async () => {
    const root = await workspace();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'user.ts'), 'export const max = 16;\n');
    const original = await readWorkspaceTextFile(root, 'src/user.ts');

    const result = await applyWorkspacePatch(
      root,
      {
        path: 'src/user.ts',
        expectedBeforeHash: original.hash,
        replacements: [{ original: 'max = 16', replacement: 'max = 32' }],
      },
      { deletionApproved: false }
    );

    expect(result.before).toBe('export const max = 16;\n');
    expect(result.after).toBe('export const max = 32;\n');
    expect(await readFile(join(root, 'src', 'user.ts'), 'utf8')).toBe(result.after);
    await expect(
      applyWorkspacePatch(
        root,
        {
          path: 'src/user.ts',
          expectedBeforeHash: original.hash,
          replacements: [{ original: 'max = 32', replacement: 'max = 40' }],
        },
        { deletionApproved: false }
      )
    ).rejects.toThrow('changed since the agent read it');
  });

  it('lists and searches only safe text files', async () => {
    const root = await workspace();
    await writeFile(join(root, 'README.md'), 'username length must be 32');
    await writeFile(join(root, '.env.local'), 'SECRET=x');
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));

    await expect(listWorkspaceFiles(root)).resolves.toEqual(['README.md', 'binary.bin']);
    await expect(searchWorkspaceText(root, '32')).resolves.toEqual([
      { path: 'README.md', line: 1, column: 25, preview: 'username length must be 32' },
    ]);
    expect(sha256('username length must be 32')).toHaveLength(64);
  });

  it('bounds ranged reads and paginates globbed literal and regex searches', async () => {
    const root = await workspace();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.ts'), 'one\nTarget 1\nthree\nTarget 2\n');
    await writeFile(join(root, 'src', 'b.md'), 'Target ignored by glob\n');

    await expect(
      readWorkspaceTextRange(root, 'src/a.ts', { startLine: 2, maxLines: 2 })
    ).resolves.toMatchObject({ content: 'Target 1\nthree', startLine: 2, endLine: 3 });
    const first = await listWorkspaceFilesPage(root, { path: 'src', limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    await expect(
      listWorkspaceFilesPage(root, { path: 'src', limit: 1, cursor: first.nextCursor ?? undefined })
    ).resolves.toMatchObject({ items: [expect.any(String)] });

    const literal = await searchWorkspaceTextPage(root, {
      query: 'target',
      caseSensitive: false,
      glob: '**/*.ts',
      limit: 1,
    });
    expect(literal.items).toHaveLength(1);
    expect(literal.nextCursor).not.toBeNull();
    await expect(
      searchWorkspaceTextPage(root, { query: 'Target [12]', regex: true, glob: '**/*.ts' })
    ).resolves.toMatchObject({
      items: [
        { path: 'src/a.ts', line: 2 },
        { path: 'src/a.ts', line: 4 },
      ],
    });
  });
});
