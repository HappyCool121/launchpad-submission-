import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '@/main/database';
import { SessionService } from '@/main/session-service';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'adrouter-session-service-'));
  directories.push(directory);
  const database = new AppDatabase(join(directory, 'agent.sqlite'));
  const project = database.createProject({
    path: join(directory, 'source-project'),
    displayName: 'source-project',
    instructions: '',
    permissionMode: 'workspace-write',
    git: null,
  });
  const thread = database.createThread({
    projectId: project.id,
    title: 'Durable task',
    label: 'release',
    model: 'deepseek-v4-flash',
    thinkingLevel: 'medium',
  });
  const turn = database.createTurn(thread.id, 'Inspect the source');
  database.appendEvent(thread.id, turn.id, 'message.user', {
    text:
      `Inspect ${project.path}/src/index.ts and /opt/internal/tool with ` +
      `C:\\work\\private.txt and token=ghp_abcdefghijklmnopqrstuvwxyz012345`,
  });
  database.appendEvent(thread.id, turn.id, 'message.complete', {
    text: 'The relative source is ready.',
    content: [{ type: 'text', text: 'The relative source is ready.' }],
    model: 'deepseek-v4-flash',
    usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14 },
  });
  database.appendEvent(thread.id, turn.id, 'session.checkpoint', { safe: true });
  return { database, project, thread, turn, service: new SessionService(database) };
};

describe('durable session workflows', () => {
  it('exports sponsor-free redacted context and imports it without executing', async () => {
    const { database, project, thread, service } = await setup();
    database.addRouterOutcome(thread.id, null, {
      routerTurnId: 'router-1',
      cost: 1,
      subsidy: 0.25,
      paid: 0.75,
      cacheRead: 0,
      cacheWrite: 0,
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      inferencePurpose: 'agent',
      sponsor: null,
      timestamp: new Date().toISOString(),
    });
    const exported = service.export(thread.id, true);
    const encoded = JSON.stringify(exported);
    expect(encoded).not.toContain(project.path);
    expect(encoded).not.toContain('/opt/internal/tool');
    expect(encoded).not.toContain('C:\\work\\private.txt');
    expect(encoded).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(exported.billing).toMatchObject({ displayOnly: true, totals: { paid: 0.75 } });
    expect(exported.entries.some((entry) => Object.hasOwn(entry.payload, 'sponsor'))).toBe(false);

    const destination = database.createProject({
      path: join(project.path, '..', 'destination-project'),
      displayName: 'destination-project',
      instructions: '',
      permissionMode: 'workspace-write',
      git: null,
    });
    const imported = service.import(destination.id, exported);
    expect(imported).toMatchObject({
      projectId: destination.id,
      status: 'idle',
      label: 'release · imported',
    });
    expect(database.listTurns(imported.id)).toEqual([]);
    expect(database.listSessionEntries(imported.id)).toHaveLength(exported.entries.length);
    expect(database.listEvents(imported.id).at(-1)?.payload.message).toMatch(/No task was resumed/);
    database.close();
  });

  it('rejects tampered imports and sponsor-shaped model context', async () => {
    const { database, project, thread, service } = await setup();
    const exported = service.export(thread.id);
    const tampered = structuredClone(exported);
    const tamperedEntry = tampered.entries[0];
    if (!tamperedEntry) throw new Error('Expected an exported entry.');
    tamperedEntry.payload = { text: 'changed' };
    expect(() => service.import(project.id, tampered)).toThrow(/integrity check/);

    const sponsorShaped = structuredClone(exported);
    const sponsorEntry = sponsorShaped.entries[0];
    if (!sponsorEntry) throw new Error('Expected an exported entry.');
    sponsorEntry.payload = { sponsor: 'must not enter context' };
    expect(() => service.import(project.id, sponsorShaped)).toThrow(/sponsor-shaped/);
    database.close();
  });

  it('forks an immutable safe checkpoint into an independent descendant', async () => {
    const { database, thread, service } = await setup();
    const checkpoint = database.listSessionCheckpoints(thread.id)[0];
    if (!checkpoint) throw new Error('Expected a checkpoint.');
    const fork = service.fork(checkpoint.id, 'Alternative approach');
    expect(fork).toMatchObject({
      parentThreadId: thread.id,
      forkedFromCheckpointId: checkpoint.id,
      title: 'Alternative approach',
      status: 'idle',
    });
    const sourceCount = database.listSessionEntries(thread.id).length;
    expect(database.listSessionEntries(fork.id)).toHaveLength(checkpoint.entryOrdinal);
    database.appendEvent(fork.id, null, 'message.user', { text: 'Only in the fork' });
    expect(database.listSessionEntries(thread.id)).toHaveLength(sourceCount);
    expect(
      database.searchThreads(thread.projectId, 'Only in the fork').map((item) => item.id)
    ).toEqual([fork.id]);
    database.close();
  });

  it('exports inert self-contained HTML and confirms only the active CLI v3 branch once', async () => {
    const { database, project, thread, service } = await setup();
    const html = service.exportHtml(thread.id);
    expect(html.html).toContain("default-src 'none'");
    expect(html.html).toContain('The relative source is ready.');
    expect(html.html).not.toContain('<script');

    const timestamp = new Date().toISOString();
    const cli = [
      { type: 'session', version: 3, timestamp },
      {
        type: 'message',
        id: 'root',
        parentId: null,
        timestamp,
        message: { role: 'user', content: 'Imported request' },
      },
      {
        type: 'message',
        id: 'leaf',
        parentId: 'root',
        timestamp,
        message: { role: 'assistant', content: 'Imported response', model: 'mimo-v2.5' },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n');
    const preview = service.previewImport(project.id, 'cli-session.jsonl', cli);
    expect(preview).toMatchObject({ format: 'adrouter-cli-v3-jsonl', entries: 2, messages: 2 });
    const imported = service.confirmImport(preview.previewId);
    expect(imported.status).toBe('idle');
    expect(database.listTurns(imported.id)).toEqual([]);
    expect(() => service.confirmImport(preview.previewId)).toThrow(/expired/);
    database.close();
  });
});
