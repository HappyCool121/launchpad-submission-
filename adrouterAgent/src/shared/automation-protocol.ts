import { z } from 'zod';
import { LOCAL_RPC_PROTOCOL_VERSION } from './constants';
import { AutomationScopeSchema, IdSchema, JsonObjectSchema, TimestampSchema } from './contracts';
import { sha256 } from './security';

export const LocalRpcMethodSchema = z.enum([
  'diagnostics.get',
  'projects.list',
  'tasks.start',
  'tasks.list',
  'tasks.get',
  'tasks.events',
  'tasks.steer',
  'tasks.queueFollowUp',
  'tasks.compact',
  'tasks.fork',
  'tasks.export',
  'exports.read',
  'tasks.stop',
  'approvals.list',
  'approvals.resolve',
]);
export type LocalRpcMethod = z.infer<typeof LocalRpcMethodSchema>;

export const LocalRpcPairRequestSchema = z
  .object({
    version: z.literal(LOCAL_RPC_PROTOCOL_VERSION),
    requestId: IdSchema,
    method: z.literal('pair.request'),
    params: z
      .object({
        displayName: z.string().trim().min(1).max(120),
        publicKey: z
          .string()
          .min(40)
          .max(500)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        scopes: z.array(AutomationScopeSchema).min(1).max(4),
      })
      .strict(),
  })
  .strict();

export const LocalRpcPairStatusRequestSchema = z
  .object({
    version: z.literal(LOCAL_RPC_PROTOCOL_VERSION),
    requestId: IdSchema,
    method: z.literal('pair.status'),
    params: z.object({ pairingId: IdSchema }).strict(),
  })
  .strict();

export const LocalRpcSignedRequestSchema = z
  .object({
    version: z.literal(LOCAL_RPC_PROTOCOL_VERSION),
    requestId: IdSchema,
    clientId: IdSchema,
    method: LocalRpcMethodSchema,
    params: JsonObjectSchema,
    paramsDigest: z.string().regex(/^[0-9a-f]{64}$/),
    nonce: z
      .string()
      .min(22)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    timestamp: TimestampSchema,
    signature: z
      .string()
      .min(80)
      .max(200)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type LocalRpcSignedRequest = z.infer<typeof LocalRpcSignedRequestSchema>;

export const LocalRpcRequestSchema = z.union([
  LocalRpcPairRequestSchema,
  LocalRpcPairStatusRequestSchema,
  LocalRpcSignedRequestSchema,
]);
export type LocalRpcRequest = z.infer<typeof LocalRpcRequestSchema>;

export const LocalRpcResponseSchema = z
  .object({
    version: z.literal(LOCAL_RPC_PROTOCOL_VERSION),
    requestId: IdSchema.nullable(),
    ok: z.boolean(),
    result: JsonObjectSchema.optional(),
    error: z
      .object({ code: z.string().min(1).max(100), message: z.string().min(1).max(500) })
      .strict()
      .optional(),
  })
  .strict();
export type LocalRpcResponse = z.infer<typeof LocalRpcResponseSchema>;

export const localRpcMethodScope: Record<LocalRpcMethod, z.infer<typeof AutomationScopeSchema>> = {
  'diagnostics.get': 'diagnostics:read',
  'projects.list': 'tasks:read',
  'tasks.start': 'tasks:write',
  'tasks.list': 'tasks:read',
  'tasks.get': 'tasks:read',
  'tasks.events': 'tasks:read',
  'tasks.steer': 'tasks:write',
  'tasks.queueFollowUp': 'tasks:write',
  'tasks.compact': 'tasks:write',
  'tasks.fork': 'tasks:write',
  'tasks.export': 'tasks:read',
  'exports.read': 'tasks:read',
  'tasks.stop': 'tasks:write',
  'approvals.list': 'tasks:read',
  'approvals.resolve': 'approvals:resolve',
};

export const canonicalizeLocalRpc = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeLocalRpc);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, canonicalizeLocalRpc(nested)])
  );
};

export const localRpcParamsDigest = (params: Record<string, unknown>): string =>
  sha256(JSON.stringify(canonicalizeLocalRpc(params)));

export const localRpcSigningPayload = (
  request: Omit<LocalRpcSignedRequest, 'params' | 'signature'>
): string => JSON.stringify(canonicalizeLocalRpc(request));
