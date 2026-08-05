import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BundleService, compareVersions, validateBundlePackage } from '@/main/bundle-service';
import { AppDatabase } from '@/main/database';
import catalog from '@/shared/bundles/catalog.v1.json';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const databaseWithProject = async (): Promise<{
  database: AppDatabase;
  projectId: string;
}> => {
  const directory = await mkdtemp(join(tmpdir(), 'adrouter-bundles-'));
  directories.push(directory);
  const database = new AppDatabase(join(directory, 'agent.sqlite'));
  const project = database.createProject({
    path: '/tmp/bundle-project',
    displayName: 'bundle-project',
    instructions: '',
    permissionMode: 'workspace-write',
    git: null,
  });
  return { database, projectId: project.id };
};

describe('bundled declarative guidance', () => {
  it('validates exact entry and aggregate digests and minimum versions', () => {
    const bundle = catalog.bundles[0];
    if (!bundle) throw new Error('Expected bundled fixture.');
    expect(validateBundlePackage(bundle, '0.1.0-beta.12').manifest.id).toBe(
      'adrouter-safe-development'
    );
    expect(compareVersions('0.1.0-beta.12', '0.1.0-beta.7')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0-beta.12')).toBeGreaterThan(0);

    const changed = structuredClone(bundle);
    const changedEntry = changed.entries[0];
    if (!changedEntry) throw new Error('Expected bundled entry.');
    changedEntry.content = 'changed';
    expect(() => validateBundlePackage(changed, '0.1.0-beta.12')).toThrow('SHA-256');

    const executable = structuredClone(bundle);
    const executableEntry = executable.entries[0];
    const executableMetadata = executable.manifest.entries[0];
    if (!executableEntry || !executableMetadata) throw new Error('Expected bundled entry.');
    executableEntry.path = 'instructions/run.js';
    executableMetadata.path = 'instructions/run.js';
    expect(() => validateBundlePackage(executable, '0.1.0-beta.12')).toThrow('Markdown');

    const future = structuredClone(bundle);
    future.manifest.minimumAgentVersion = '9.0.0';
    expect(() => validateBundlePackage(future, '0.1.0-beta.12')).toThrow('requires Agent');
  });

  it('pins project trust to the exact packaged ID, version, and digest', async () => {
    const { database, projectId } = await databaseWithProject();
    const service = new BundleService(database, '0.1.0-beta.12');
    const available = service.list(projectId)[0];
    if (!available) throw new Error('Expected bundled guidance.');
    expect(available).toMatchObject({ trusted: false, active: false });

    const trusted = service.trust(
      projectId,
      available.id,
      available.version,
      available.aggregateDigest
    );
    expect(trusted).toMatchObject({ trusted: true, active: true, trustReason: null });
    expect(service.promptContent(projectId)).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({ kind: 'bundle', digest: expect.any(String) }),
      ]),
    });
    expect(service.promptContent(projectId).instructions).toContain('Dependency safety');

    database.trustBundle({
      projectId,
      bundleId: available.id,
      bundleVersion: available.version,
      bundleDigest: 'a'.repeat(64),
    });
    expect(service.list(projectId)[0]).toMatchObject({ trusted: true, active: false });
    expect(service.promptContent(projectId)).toEqual({ instructions: '', sources: [] });
    expect(service.revoke(projectId, available.id)).toMatchObject({
      trusted: false,
      active: false,
    });
    database.close();
  });

  it('rejects trust requests that are not in the packaged allowlist', async () => {
    const { database, projectId } = await databaseWithProject();
    const service = new BundleService(database, '0.1.0-beta.12');
    expect(() => service.trust(projectId, 'unknown', '1.0.0', 'a'.repeat(64))).toThrow(
      'exact packaged'
    );
    database.close();
  });
});
