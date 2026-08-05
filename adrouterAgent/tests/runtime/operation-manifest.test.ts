import { describe, expect, it } from 'vitest';
import {
  assertOperationManifest,
  createOperationManifest,
  OperationBindingError,
} from '@/runtime/operation-manifest';

const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';

describe('immutable operation manifests', () => {
  it('binds exact arguments and rejects tampering', () => {
    const manifest = createOperationManifest({
      capability: 'script.run',
      threadId,
      turnId,
      workspace: '/tmp/project',
      argv: ['npm', 'test'],
    });

    expect(
      assertOperationManifest(manifest, {
        operationId: manifest.operationId,
        threadId,
        turnId,
        capability: 'script.run',
      })
    ).toEqual(manifest);

    expect(() =>
      assertOperationManifest(
        { ...manifest, argv: ['npm', 'publish'] },
        {
          operationId: manifest.operationId,
          threadId,
          turnId,
          capability: 'script.run',
        }
      )
    ).toThrow(OperationBindingError);
  });

  it('rejects identity mismatches and expired approvals', () => {
    const now = new Date('2026-08-02T00:00:00.000Z');
    const manifest = createOperationManifest({
      capability: 'file.delete',
      threadId,
      turnId,
      workspace: '/tmp/project',
      targets: [{ path: 'old.txt', kind: 'file', beforeHash: 'a'.repeat(64) }],
      lifetimeMs: 1_000,
      now,
    });

    expect(() =>
      assertOperationManifest(
        manifest,
        {
          operationId: manifest.operationId,
          threadId: '33333333-3333-4333-8333-333333333333',
          turnId,
          capability: 'file.delete',
        },
        now.getTime()
      )
    ).toThrow('does not match');
    expect(() =>
      assertOperationManifest(
        manifest,
        {
          operationId: manifest.operationId,
          threadId,
          turnId,
          capability: 'file.delete',
        },
        now.getTime() + 1_001
      )
    ).toThrow('expired');
  });
});
