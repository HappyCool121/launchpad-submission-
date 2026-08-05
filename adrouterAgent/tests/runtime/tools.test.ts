import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxedCommandRunner } from '@/runtime/command-runner';
import { createDesktopTools } from '@/runtime/tools';
import { sha256 } from '@/shared/security';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('desktop tool approvals', () => {
  it('omits command and Git tools when sandbox setup is unavailable', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'adrouter-tools-'));
    directories.push(workspace);
    const tools = createDesktopTools({
      workspaceRoot: workspace,
      permissionMode: 'workspace-write',
      threadId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222',
      commandRunner: {} as SandboxedCommandRunner,
      commandsEnabled: false,
      requestApproval: vi.fn(),
      emit: vi.fn(),
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_files',
      'read_file',
      'search_text',
      'apply_patch',
      'copy_path',
      'move_path',
      'delete_path',
      'restore_path',
      'fetch_url',
      'preview_dependency_change',
      'apply_dependency_preview',
      'run_project_script',
      'run_lifecycle_script',
      'git_create_branch',
      'git_switch_branch',
      'git_stage_paths',
      'git_commit',
      'git_push',
    ]);
  });

  it('asks again for every general command and every file mutation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'adrouter-tools-'));
    directories.push(workspace);
    await writeFile(join(workspace, 'file.txt'), 'old\n');
    const requestApproval = vi
      .fn()
      .mockResolvedValueOnce('allow-once')
      .mockResolvedValueOnce('allow-once')
      .mockResolvedValueOnce('deny')
      .mockResolvedValueOnce('allow-once');
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      cancelled: false,
      durationMs: 1,
    }));
    const tools = createDesktopTools({
      workspaceRoot: workspace,
      permissionMode: 'workspace-write',
      threadId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222',
      commandRunner: { run } as unknown as SandboxedCommandRunner,
      requestApproval,
      emit: vi.fn(),
    });
    const command = tools.find((tool) => tool.name === 'run_command');
    const patch = tools.find((tool) => tool.name === 'apply_patch');
    if (!command || !patch) throw new Error('Expected desktop tools were not registered.');

    await command.execute('command-1', { argv: ['pwd'] });
    await command.execute('command-2', { argv: ['pwd'] });
    expect(run).toHaveBeenCalledTimes(2);
    expect(requestApproval).toHaveBeenCalledTimes(2);

    const patchInput = {
      path: 'file.txt',
      expectedBeforeHash: sha256('old\n'),
      replacements: [{ original: 'old', replacement: 'new' }],
    };
    await patch.execute('patch-1', patchInput);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('old\n');
    await patch.execute('patch-2', patchInput);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('new\n');
    expect(requestApproval).toHaveBeenCalledTimes(4);
  });

  it('tags command chunks with the canonical tool call and emits no duplicate lifecycle records', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'adrouter-tool-events-'));
    directories.push(workspace);
    const emit = vi.fn();
    const run = vi.fn(async (input: Parameters<SandboxedCommandRunner['run']>[0]) => {
      input.onOutput?.({ stream: 'stdout', chunk: 'hello\n' });
      return {
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        cancelled: false,
        durationMs: 1,
      };
    });
    const command = createDesktopTools({
      workspaceRoot: workspace,
      permissionMode: 'workspace-write',
      threadId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222',
      commandRunner: { run } as unknown as SandboxedCommandRunner,
      requestApproval: vi.fn().mockResolvedValue('allow-once'),
      emit,
    }).find((tool) => tool.name === 'run_command');
    if (!command) throw new Error('Expected command tool.');

    await command.execute('command-42', { argv: ['pwd'] });

    expect(emit).toHaveBeenCalledWith('command.output', {
      toolCallId: 'command-42',
      name: 'run_command',
      argv: ['pwd'],
      stream: 'stdout',
      chunk: 'hello\n',
    });
    expect(
      emit.mock.calls.some(([type]) => type === 'tool.activity' || type === 'tool.result')
    ).toBe(false);
  });
});
