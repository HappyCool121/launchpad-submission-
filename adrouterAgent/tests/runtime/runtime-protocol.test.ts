import { describe, expect, it } from 'vitest';
import { RuntimeAuthRequestSchema, RuntimeAuthResponseSchema } from '@/shared/runtime-protocol';

const base = {
  kind: 'auth-request' as const,
  protocolVersion: 1 as const,
  requestId: '11111111-1111-4111-8111-111111111111',
};

describe('runtime installation-auth protocol', () => {
  it('allows only bodyless profile GET and exact-body agent POST signing requests', () => {
    expect(
      RuntimeAuthRequestSchema.safeParse({
        ...base,
        method: 'GET',
        path: '/v1/profile',
      }).success
    ).toBe(true);
    expect(
      RuntimeAuthRequestSchema.safeParse({
        ...base,
        method: 'POST',
        path: '/v1/agent/turn',
        bodyBase64: Buffer.from('{"exact":true}').toString('base64'),
      }).success
    ).toBe(true);
    for (const invalid of [
      { ...base, method: 'GET', path: '/v1/profile', bodyBase64: '' },
      { ...base, method: 'GET', path: '/v1/agent/turn' },
      { ...base, method: 'POST', path: '/v1/agent/turn' },
      { ...base, method: 'POST', path: '/v1/profile', bodyBase64: 'e30=' },
    ]) {
      expect(RuntimeAuthRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('permits a digest only when the main-process signer returns one', () => {
    expect(
      RuntimeAuthResponseSchema.safeParse({
        kind: 'auth-response',
        protocolVersion: 1,
        requestId: base.requestId,
        ok: true,
        headers: { Authorization: 'DPoP access', DPoP: 'proof' },
      }).success
    ).toBe(true);
    expect(
      RuntimeAuthResponseSchema.safeParse({
        kind: 'auth-response',
        protocolVersion: 1,
        requestId: base.requestId,
        ok: true,
        headers: {
          Authorization: 'DPoP access',
          DPoP: 'proof',
          'Content-Digest': 'sha-256=:fixture:',
        },
      }).success
    ).toBe(true);
  });
});
