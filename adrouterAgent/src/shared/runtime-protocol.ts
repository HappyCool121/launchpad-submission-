import { z } from 'zod';
import {
  INSTALLATION_AUTH_PROTOCOL_VERSION,
  MAX_SIGNED_REQUEST_BYTES,
  OPERATION_BROKER_PROTOCOL_VERSION,
} from './constants';
import {
  ApprovalDecisionSchema,
  EventTypeSchema,
  IdSchema,
  JsonObjectSchema,
  OperationManifestV1Schema,
  PermissionModeSchema,
  PromptSourceSchema,
  RouterModelDescriptorSchema,
  RuntimeModeSchema,
  SessionEntrySchema,
  ThinkingLevelSchema,
} from './contracts';

const RuntimeRouterSchema = z.discriminatedUnion('authMode', [
  z.object({
    authMode: z.literal('installation'),
    serverUrl: z.string().url(),
  }),
  z.object({
    authMode: z.literal('custom_bearer'),
    serverUrl: z.string().url(),
    token: z.string().min(1).max(16_384),
  }),
]);

export const RuntimeStartSchema = z.object({
  type: z.literal('start'),
  threadId: IdSchema,
  turnId: IdSchema,
  project: z.object({
    id: IdSchema,
    path: z.string().min(1),
    displayName: z.string().min(1),
    instructions: z.string(),
    repositoryInstructions: z.string(),
    repositoryInstructionFiles: z.array(z.string().min(1).max(500)).max(20),
    bundleInstructions: z.string().max(256 * 1024),
    promptSources: z.array(PromptSourceSchema).max(64),
    permissionMode: PermissionModeSchema,
    delegationEnabled: z.boolean(),
  }),
  model: RouterModelDescriptorSchema,
  thinkingLevel: ThinkingLevelSchema,
  runtimeMode: RuntimeModeSchema,
  sponsoredCompute: z.boolean(),
  router: RuntimeRouterSchema,
  input: z.string().min(1),
  history: z.array(SessionEntrySchema),
  allowedCommands: z.array(z.array(z.string().min(1)).min(1)),
});

export const RuntimeSteerSchema = z.object({ type: z.literal('steer'), input: z.string().min(1) });
export const RuntimeQueueSchema = z.object({
  type: z.literal('queue-follow-up'),
  input: z.string().min(1),
});
export const RuntimeClearQueueSchema = z.object({ type: z.literal('clear-queue') });
export const RuntimeStopSchema = z.object({ type: z.literal('stop') });
export const RuntimeApprovalSchema = z.object({
  type: z.literal('approval'),
  approvalId: IdSchema,
  decision: ApprovalDecisionSchema,
});

export const RuntimeRequestSchema = z.discriminatedUnion('type', [
  RuntimeStartSchema,
  RuntimeSteerSchema,
  RuntimeQueueSchema,
  RuntimeClearQueueSchema,
  RuntimeStopSchema,
  RuntimeApprovalSchema,
]);
export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;

export const RuntimeEventSchema = z.object({
  type: EventTypeSchema,
  turnId: IdSchema.nullable(),
  payload: JsonObjectSchema,
  timestamp: z.string().datetime({ offset: true }),
});
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export const RuntimeAuthRequestSchema = z
  .object({
    kind: z.literal('auth-request'),
    protocolVersion: z.literal(INSTALLATION_AUTH_PROTOCOL_VERSION),
    requestId: IdSchema,
    method: z.enum(['GET', 'POST']),
    path: z.enum(['/v1/profile', '/v1/agent/turn']),
    bodyBase64: z
      .string()
      .max(Math.ceil((MAX_SIGNED_REQUEST_BYTES * 4) / 3) + 8)
      .optional(),
    nonce: z
      .string()
      .min(1)
      .max(1_024)
      .regex(/^[\x21-\x7E]+$/)
      .optional(),
  })
  .superRefine((request, context) => {
    if (request.method === 'GET' && request.bodyBase64 !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Bodyless GET requests cannot carry body bytes.',
      });
    }
    if (request.method === 'GET' && request.path !== '/v1/profile') {
      context.addIssue({
        code: 'custom',
        message: 'Only the profile route supports protected GET.',
      });
    }
    if (request.method === 'POST' && request.bodyBase64 === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Protected POST requests require exact body bytes.',
      });
    }
    if (request.method === 'POST' && request.path !== '/v1/agent/turn') {
      context.addIssue({
        code: 'custom',
        message: 'Only the agent turn route supports protected POST.',
      });
    }
  });
export type RuntimeAuthRequest = z.infer<typeof RuntimeAuthRequestSchema>;

export const RuntimeAuthResponseSchema = z.object({
  kind: z.literal('auth-response'),
  protocolVersion: z.literal(INSTALLATION_AUTH_PROTOCOL_VERSION),
  requestId: IdSchema,
  ok: z.boolean(),
  headers: z
    .object({
      Authorization: z.string().min(1).max(20_000),
      DPoP: z.string().min(1).max(20_000),
      'Content-Digest': z.string().min(1).max(200).optional(),
    })
    .optional(),
  error: z.string().min(1).max(500).optional(),
});
export type RuntimeAuthResponse = z.infer<typeof RuntimeAuthResponseSchema>;

export const RuntimeAuthCancelSchema = z.object({
  kind: z.literal('auth-cancel'),
  protocolVersion: z.literal(INSTALLATION_AUTH_PROTOCOL_VERSION),
  requestId: IdSchema,
});

export const RuntimeOperationRequestSchema = z.object({
  kind: z.literal('operation-request'),
  protocolVersion: z.literal(OPERATION_BROKER_PROTOCOL_VERSION),
  requestId: IdSchema,
  manifest: OperationManifestV1Schema,
});
export type RuntimeOperationRequest = z.infer<typeof RuntimeOperationRequestSchema>;

export const RuntimeOperationResponseSchema = z.object({
  kind: z.literal('operation-response'),
  protocolVersion: z.literal(OPERATION_BROKER_PROTOCOL_VERSION),
  requestId: IdSchema,
  ok: z.boolean(),
  result: JsonObjectSchema.optional(),
  error: z.string().min(1).max(1_000).optional(),
});
export type RuntimeOperationResponse = z.infer<typeof RuntimeOperationResponseSchema>;

export const RuntimeOperationCancelSchema = z.object({
  kind: z.literal('operation-cancel'),
  protocolVersion: z.literal(OPERATION_BROKER_PROTOCOL_VERSION),
  requestId: IdSchema,
});

export const RuntimePortMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('request'), request: RuntimeRequestSchema }),
  z.object({ kind: z.literal('event'), event: RuntimeEventSchema }),
  z.object({ kind: z.literal('ready') }),
  RuntimeAuthRequestSchema,
  RuntimeAuthResponseSchema,
  RuntimeAuthCancelSchema,
  RuntimeOperationRequestSchema,
  RuntimeOperationResponseSchema,
  RuntimeOperationCancelSchema,
]);
export type RuntimePortMessage = z.infer<typeof RuntimePortMessageSchema>;
