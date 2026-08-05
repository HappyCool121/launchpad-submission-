import { z } from 'zod';

export const IdSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime({ offset: true });
export const JsonObjectSchema = z.record(z.string(), z.unknown());

export const PermissionModeSchema = z.enum(['read-only', 'workspace-write']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ThreadStatusSchema = z.enum([
  'idle',
  'running',
  'awaiting_approval',
  'failed',
  'interrupted',
  'blocked',
]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const TurnStatusSchema = z.enum([
  'queued',
  'preparing',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

export const ThinkingLevelSchema = z.enum(['none', 'medium', 'high']);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const RuntimeModeSchema = z.enum(['auto', 'mock', 'live']);
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

export const SponsorTierSchema = z.enum(['A', 'B', 'C', 'NONE']);
export type SponsorTier = z.infer<typeof SponsorTierSchema>;

export const RouterModelDescriptorSchema = z
  .object({
    id: z.string().min(1).max(300),
    provider: z.string().min(1).max(120),
    modelClass: z.enum(['flash', 'pro']),
    displayName: z.string().min(1).max(200),
    providerLabel: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    thinkingLevels: z.array(ThinkingLevelSchema).min(1).max(3),
    defaultThinkingLevel: ThinkingLevelSchema,
    contextWindow: z.number().int().positive(),
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    configured: z.boolean(),
  })
  .strict()
  .superRefine((model, context) => {
    if (new Set(model.thinkingLevels).size !== model.thinkingLevels.length) {
      context.addIssue({ code: 'custom', message: 'thinkingLevels must be unique' });
    }
    if (!model.thinkingLevels.includes(model.defaultThinkingLevel)) {
      context.addIssue({ code: 'custom', message: 'defaultThinkingLevel must be advertised' });
    }
    if (model.maxInputTokens + model.maxOutputTokens > model.contextWindow) {
      context.addIssue({ code: 'custom', message: 'model token limits exceed contextWindow' });
    }
  });
export type RouterModelDescriptor = z.infer<typeof RouterModelDescriptorSchema>;

export const CatalogSourceSchema = z.enum(['bundled', 'live', 'cache']);
export const CatalogFreshnessSchema = z.enum(['bundled', 'fresh', 'stale']);
export const CatalogCompatibilitySchema = z.enum(['compatible', 'incompatible']);
export const CatalogErrorCodeSchema = z.enum([
  'catalog_unreachable',
  'catalog_http_error',
  'catalog_invalid',
  'catalog_incompatible',
]);
export const RouterCatalogStatusSchema = z.object({
  schemaVersion: z.literal(1).nullable(),
  digest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .nullable(),
  source: CatalogSourceSchema,
  freshness: CatalogFreshnessSchema,
  compatibility: CatalogCompatibilitySchema,
  lastValidatedAt: TimestampSchema.nullable(),
  lastAttemptAt: TimestampSchema.nullable(),
  errorCode: CatalogErrorCodeSchema.nullable(),
});
export type RouterCatalogStatus = z.infer<typeof RouterCatalogStatusSchema>;

export const RouterOriginClassSchema = z.enum(['official', 'loopback', 'custom']);
export const RouterAuthenticationModeSchema = z.enum([
  'unconfigured',
  'installation',
  'custom_bearer',
  'legacy_hosted',
]);
export const InstallationStateSchema = z.enum([
  'none',
  'pending',
  'connected',
  'reconnect_required',
  'upgrade_required',
]);
export const InstallationDiagnosticsSchema = z.object({
  mode: RouterAuthenticationModeSchema,
  state: InstallationStateSchema,
  originClass: RouterOriginClassSchema,
  storageClassification: z.enum(['os_encrypted', 'unavailable']).nullable(),
  signedRequestSupport: z.boolean(),
  refreshHealthy: z.boolean(),
  pendingEnrollment: z.boolean(),
  reconnectRequired: z.boolean(),
  installationIdSuffix: z.string().max(12).nullable(),
  scopes: z.array(z.enum(['agent:turn', 'profile:read'])).max(2),
  familyExpiresAt: TimestampSchema.nullable(),
  minimumClientVersion: z.string().max(100).nullable(),
  policyMode: z.enum(['observe', 'warn', 'enforce']).nullable(),
});
export type InstallationDiagnostics = z.infer<typeof InstallationDiagnosticsSchema>;

export const EnrollmentStateSchema = z.enum([
  'idle',
  'awaiting_sign_in',
  'starting',
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
  'failed',
]);
export const EnrollmentStatusSchema = z.object({
  state: EnrollmentStateSchema,
  userCode: z.string().min(1).max(64).nullable(),
  verificationUri: z.string().url().nullable(),
  verificationUriComplete: z.string().url().nullable(),
  expiresAt: TimestampSchema.nullable(),
  nextPollAt: TimestampSchema.nullable(),
  message: z.string().max(500).nullable(),
});
export type EnrollmentStatus = z.infer<typeof EnrollmentStatusSchema>;

export const GitMetadataSchema = z.object({
  branch: z.string().nullable(),
  changeCount: z.number().int().nonnegative(),
  isDirty: z.boolean(),
  remote: z.string().nullable(),
});

export const ProjectSchema = z.object({
  id: IdSchema,
  path: z.string().min(1),
  displayName: z.string().min(1).max(120),
  instructions: z.string().max(100_000),
  repositoryInstructions: z.string().max(200_000),
  repositoryInstructionFiles: z.array(z.string().min(1).max(500)).max(20),
  permissionMode: PermissionModeSchema,
  delegationEnabled: z.boolean(),
  git: GitMetadataSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

const SemanticVersionSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

export const BundleEntryKindSchema = z.enum(['instruction', 'skill', 'prompt']);
export const BundleEntryMetadataV1Schema = z
  .object({
    kind: BundleEntryKindSchema,
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    title: z.string().min(1).max(120),
    path: z.string().min(1).max(240),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const BundleEntryV1Schema = BundleEntryMetadataV1Schema.extend({
  content: z
    .string()
    .min(1)
    .max(64 * 1024),
}).strict();
export const BundleManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    version: SemanticVersionSchema,
    minimumAgentVersion: SemanticVersionSchema,
    entries: z.array(BundleEntryMetadataV1Schema).min(1).max(32),
    aggregateDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const BundlePackageV1Schema = z
  .object({
    manifest: BundleManifestV1Schema,
    entries: z.array(BundleEntryV1Schema).min(1).max(32),
  })
  .strict()
  .superRefine((bundle, context) => {
    const totalBytes = bundle.entries.reduce(
      (total, entry) => total + new TextEncoder().encode(entry.content).byteLength,
      0
    );
    if (totalBytes > 256 * 1024) {
      context.addIssue({ code: 'custom', message: 'bundle content exceeds 256 KiB' });
    }
  });
export type BundlePackageV1 = z.infer<typeof BundlePackageV1Schema>;

export const BundleSummarySchema = z
  .object({
    id: z.string(),
    version: SemanticVersionSchema,
    minimumAgentVersion: SemanticVersionSchema,
    aggregateDigest: z.string().regex(/^[0-9a-f]{64}$/),
    entries: z.array(BundleEntryMetadataV1Schema),
    trusted: z.boolean(),
    active: z.boolean(),
    trustReason: z.string().max(500).nullable(),
  })
  .strict();
export type BundleSummary = z.infer<typeof BundleSummarySchema>;

export const BundleTrustSchema = z
  .object({
    projectId: IdSchema,
    bundleId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    bundleVersion: SemanticVersionSchema,
    bundleDigest: z.string().regex(/^[0-9a-f]{64}$/),
    trustedAt: TimestampSchema,
  })
  .strict();
export type BundleTrust = z.infer<typeof BundleTrustSchema>;

export const PromptSourceSchema = z
  .object({
    kind: z.enum(['repository', 'custom', 'bundle']),
    label: z.string().min(1).max(240),
    digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();
export type PromptSource = z.infer<typeof PromptSourceSchema>;

export const AutomationScopeSchema = z.enum([
  'diagnostics:read',
  'tasks:read',
  'tasks:write',
  'approvals:resolve',
]);
export type AutomationScope = z.infer<typeof AutomationScopeSchema>;
export const AutomationClientSchema = z
  .object({
    id: IdSchema,
    displayName: z.string().min(1).max(120),
    publicKey: z.string().min(40).max(500),
    publicKeyFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    scopes: z.array(AutomationScopeSchema).min(1).max(4),
    createdAt: TimestampSchema,
    lastUsedAt: TimestampSchema.nullable(),
    revokedAt: TimestampSchema.nullable(),
  })
  .strict();
export type AutomationClient = z.infer<typeof AutomationClientSchema>;

export const AutomationPairingSchema = z
  .object({
    id: IdSchema,
    displayName: z.string().min(1).max(120),
    publicKeyFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    comparisonCode: z.string().regex(/^\d{3}-\d{3}$/),
    scopes: z.array(AutomationScopeSchema).min(1).max(4),
    status: z.enum(['pending', 'approved', 'denied', 'expired']),
    expiresAt: TimestampSchema,
    clientId: IdSchema.nullable(),
  })
  .strict();
export type AutomationPairing = z.infer<typeof AutomationPairingSchema>;

export const ThreadSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  parentThreadId: IdSchema.nullable(),
  forkedFromCheckpointId: IdSchema.nullable(),
  title: z.string().min(1).max(240),
  label: z.string().trim().min(1).max(120).nullable(),
  model: z.string().min(1).max(300),
  thinkingLevel: ThinkingLevelSchema,
  status: ThreadStatusSchema,
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Thread = z.infer<typeof ThreadSchema>;

export const TurnSchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  input: z.string().min(1).max(200_000),
  model: z.string().min(1).max(300),
  thinkingLevel: ThinkingLevelSchema,
  kind: z.enum(['agent', 'compaction']).default('agent'),
  status: TurnStatusSchema,
  error: z.string().nullable(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const EventTypeSchema = z.enum([
  'thread.lifecycle',
  'turn.lifecycle',
  'message.user',
  'message.delta',
  'message.complete',
  'thinking.delta',
  'tool.activity',
  'tool.result',
  'command.output',
  'approval.request',
  'approval.resolved',
  'file.change',
  'diff.change',
  'operation.completed',
  'sponsor.update',
  'settlement',
  'compaction',
  'context.budget',
  'queue.update',
  'session.checkpoint',
  'retry',
  'runtime.crash',
  'final.evidence',
  'diagnostic',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventSchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  turnId: IdSchema.nullable(),
  sequence: z.number().int().positive(),
  type: EventTypeSchema,
  timestamp: TimestampSchema,
  payload: JsonObjectSchema,
});
export type JournalEvent = z.infer<typeof EventSchema>;

export const ContextBudgetSnapshotSchema = z
  .object({
    estimatedTokens: z.number().int().nonnegative(),
    maxInputTokens: z.number().int().positive(),
    compactionThreshold: z.number().int().positive(),
    reserveTokens: z.number().int().nonnegative(),
    status: z.enum(['ok', 'near_limit', 'overflow']),
    source: z.enum(['estimate', 'router_usage', 'compaction']),
  })
  .strict();
export type ContextBudgetSnapshot = z.infer<typeof ContextBudgetSnapshotSchema>;

export const SessionEntryKindSchema = z.enum([
  'user_message',
  'assistant_message',
  'tool_result',
  'compaction',
  'context_anchor',
]);
export const SessionEntrySchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  turnId: IdSchema.nullable(),
  sourceEventId: IdSchema,
  ordinal: z.number().int().positive(),
  kind: SessionEntryKindSchema,
  timestamp: TimestampSchema,
  payload: JsonObjectSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SessionEntry = z.infer<typeof SessionEntrySchema>;

export const SessionCheckpointSchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  turnId: IdSchema,
  sourceEventId: IdSchema,
  entryOrdinal: z.number().int().nonnegative(),
  contextDigest: z.string().regex(/^[0-9a-f]{64}$/),
  safe: z.literal(true),
  createdAt: TimestampSchema,
});
export type SessionCheckpoint = z.infer<typeof SessionCheckpointSchema>;

export const GitTaskBaselineSchema = z
  .object({
    threadId: IdSchema,
    turnId: IdSchema,
    headOid: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .nullable(),
    ref: z.string().min(1).max(1_024).nullable(),
    indexTreeHash: z.string().regex(/^[0-9a-f]{64}$/),
    statusEntries: z
      .array(
        z
          .object({
            code: z.string().length(2),
            path: z.string().min(1).max(4_096),
            originalPath: z.string().min(1).max(4_096).nullable(),
            hash: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .nullable(),
          })
          .strict()
      )
      .max(2_000),
    truncated: z.boolean(),
    capturedAt: TimestampSchema,
  })
  .strict();
export type GitTaskBaseline = z.infer<typeof GitTaskBaselineSchema>;

export const SessionExportEntryV1Schema = z
  .object({
    kind: SessionEntryKindSchema,
    timestamp: TimestampSchema,
    payload: JsonObjectSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const SessionExportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    exportedAt: TimestampSchema,
    project: z.object({ displayName: z.string().min(1).max(120) }).strict(),
    task: z
      .object({
        title: z.string().min(1).max(240),
        label: z.string().min(1).max(120).nullable(),
        model: z.string().min(1).max(300),
        thinkingLevel: ThinkingLevelSchema,
        sourceStatus: ThreadStatusSchema,
      })
      .strict(),
    entries: z.array(SessionExportEntryV1Schema).max(20_000),
    checkpoints: z
      .array(
        z
          .object({
            entryOrdinal: z.number().int().nonnegative(),
            contextDigest: z.string().regex(/^[0-9a-f]{64}$/),
            createdAt: TimestampSchema,
          })
          .strict()
      )
      .max(5_000),
    billing: z
      .object({
        displayOnly: z.literal(true),
        totals: z
          .object({
            cost: z.number().nonnegative(),
            subsidy: z.number().nonnegative(),
            paid: z.number().nonnegative(),
            totalTokens: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SessionExportV1 = z.infer<typeof SessionExportV1Schema>;

export const SessionHtmlExportSchema = z
  .object({
    filename: z.string().min(1).max(120),
    html: z
      .string()
      .min(1)
      .max(12 * 1024 * 1024),
  })
  .strict();
export type SessionHtmlExport = z.infer<typeof SessionHtmlExportSchema>;

export const SessionImportPreviewSchema = z
  .object({
    previewId: IdSchema,
    format: z.enum(['agent-json', 'adrouter-cli-v3-jsonl']),
    sourceName: z.string().min(1).max(240),
    title: z.string().min(1).max(240),
    model: z.string().min(1).max(300),
    thinkingLevel: ThinkingLevelSchema,
    entries: z.number().int().nonnegative().max(20_000),
    messages: z.number().int().nonnegative().max(20_000),
    warnings: z.array(z.string().min(1).max(500)).max(20),
    expiresAt: TimestampSchema,
  })
  .strict();
export type SessionImportPreview = z.infer<typeof SessionImportPreviewSchema>;

export const OperationCapabilitySchema = z.enum([
  'file.copy',
  'file.move',
  'file.delete',
  'file.restore',
  'dependency.preview',
  'dependency.apply',
  'dependency.lifecycle',
  'script.run',
  'git.branch.create',
  'git.switch',
  'git.stage',
  'git.stage.hunk',
  'git.commit',
  'git.push',
  'network.fetch',
  'delegation.start',
]);
export type OperationCapability = z.infer<typeof OperationCapabilitySchema>;

export const OperationManifestV1Schema = z
  .object({
    version: z.literal(1),
    operationId: IdSchema,
    capability: OperationCapabilitySchema,
    threadId: IdSchema,
    turnId: IdSchema,
    workspace: z.string().min(1).max(4_096),
    targets: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4_096),
            kind: z.enum(['file', 'directory', 'missing', 'git-ref']),
            beforeHash: z
              .string()
              .regex(/^[0-9a-f]{40,64}$/)
              .nullable(),
          })
          .strict()
      )
      .max(2_000),
    argv: z.array(z.string().min(1).max(8_192)).max(256).nullable(),
    network: z
      .object({
        method: z.enum(['GET', 'HEAD', 'GIT_PUSH']),
        url: z.string().url().max(8_192),
        host: z.string().min(1).max(253),
        resolvedAddresses: z
          .array(
            z
              .string()
              .min(2)
              .max(64)
              .regex(/^[0-9a-fA-F:.]+$/)
          )
          .min(1)
          .max(16),
        maxResponseBytes: z
          .number()
          .int()
          .positive()
          .max(10 * 1024 * 1024),
      })
      .strict()
      .nullable(),
    git: z
      .object({
        headOid: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/)
          .nullable(),
        indexTreeOid: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/)
          .nullable(),
        ref: z.string().min(1).max(1_024).nullable(),
      })
      .strict()
      .nullable(),
    policyVersion: z.literal(1),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    binding: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((manifest, context) => {
    const lifetime = Date.parse(manifest.expiresAt) - Date.parse(manifest.createdAt);
    if (lifetime <= 0 || lifetime > 15 * 60_000) {
      context.addIssue({ code: 'custom', message: 'operation manifest lifetime is invalid' });
    }
    if (
      manifest.capability === 'network.fetch' &&
      (!manifest.network || !['GET', 'HEAD'].includes(manifest.network.method))
    ) {
      context.addIssue({ code: 'custom', message: 'network.fetch requires a GET or HEAD binding' });
    }
    if (manifest.capability === 'git.push' && manifest.network?.method !== 'GIT_PUSH') {
      context.addIssue({ code: 'custom', message: 'git.push requires an exact network binding' });
    }
    if (!['network.fetch', 'git.push'].includes(manifest.capability) && manifest.network !== null) {
      context.addIssue({
        code: 'custom',
        message: 'this operation capability cannot bind a network target',
      });
    }
    if (manifest.capability.startsWith('git.') && manifest.git === null) {
      context.addIssue({ code: 'custom', message: 'Git operations require Git before-state' });
    }
  });
export type OperationManifestV1 = z.infer<typeof OperationManifestV1Schema>;

export const ApprovalKindSchema = z.enum([
  'command',
  'file-delete',
  'file-mutation',
  'structured-operation',
  'network-operation',
  'git-operation',
  'dependency-operation',
  'delegation',
]);
export const ApprovalDecisionSchema = z.enum(['allow-once', 'allow-thread', 'deny']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]).default(1),
  id: IdSchema,
  threadId: IdSchema,
  turnId: IdSchema,
  kind: ApprovalKindSchema,
  argv: z.array(z.string()).min(1).nullable(),
  path: z.string().nullable(),
  cwd: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  reason: z.string(),
  operationManifest: OperationManifestV1Schema.nullable().default(null),
  expiresAt: TimestampSchema.nullable().default(null),
  decision: ApprovalDecisionSchema.nullable(),
  createdAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
export type ApprovalInput = z.input<typeof ApprovalSchema>;

export const ApprovalV2Schema = ApprovalSchema.extend({
  version: z.literal(2),
  operationManifest: OperationManifestV1Schema,
  expiresAt: TimestampSchema,
}).superRefine((approval, context) => {
  if (approval.id !== approval.operationManifest.operationId) {
    context.addIssue({ code: 'custom', message: 'approval ID must bind the operation ID' });
  }
  if (approval.threadId !== approval.operationManifest.threadId) {
    context.addIssue({ code: 'custom', message: 'approval thread does not match the operation' });
  }
  if (approval.turnId !== approval.operationManifest.turnId) {
    context.addIssue({ code: 'custom', message: 'approval turn does not match the operation' });
  }
  if (approval.expiresAt !== approval.operationManifest.expiresAt) {
    context.addIssue({ code: 'custom', message: 'approval expiry does not match the operation' });
  }
});
export type ApprovalV2 = z.infer<typeof ApprovalV2Schema>;

export const GitWorkflowCapabilitySchema = z.enum([
  'git.branch.create',
  'git.switch',
  'git.stage',
  'git.stage.hunk',
  'git.commit',
  'git.push',
]);
export const GitWorkflowPreviewInputSchema = z
  .object({
    threadId: IdSchema,
    capability: GitWorkflowCapabilitySchema,
    branch: z.string().min(1).max(255).optional(),
    paths: z.array(z.string().min(1).max(4_096)).min(1).max(32).optional(),
    path: z.string().min(1).max(4_096).optional(),
    hunks: z.array(z.number().int().positive().max(2_000)).min(1).max(128).optional(),
    message: z.string().trim().min(1).max(2_000).optional(),
    remote: z.string().min(1).max(128).optional(),
    remoteRef: z.string().min(1).max(255).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      ['git.branch.create', 'git.switch'].includes(input.capability) &&
      (!input.branch ||
        input.paths ||
        input.path ||
        input.hunks ||
        input.message ||
        input.remote ||
        input.remoteRef)
    ) {
      context.addIssue({ code: 'custom', message: 'branch operation arguments are invalid' });
    }
    if (
      input.capability === 'git.stage' &&
      (!input.paths ||
        input.branch ||
        input.path ||
        input.hunks ||
        input.message ||
        input.remote ||
        input.remoteRef)
    ) {
      context.addIssue({ code: 'custom', message: 'stage operation arguments are invalid' });
    }
    if (
      input.capability === 'git.stage.hunk' &&
      (!input.path ||
        !input.hunks ||
        input.branch ||
        input.paths ||
        input.message ||
        input.remote ||
        input.remoteRef)
    ) {
      context.addIssue({ code: 'custom', message: 'hunk stage arguments are invalid' });
    }
    if (
      input.capability === 'git.commit' &&
      (!input.message ||
        input.branch ||
        input.paths ||
        input.path ||
        input.hunks ||
        input.remote ||
        input.remoteRef)
    ) {
      context.addIssue({ code: 'custom', message: 'commit operation arguments are invalid' });
    }
    if (
      input.capability === 'git.push' &&
      (!input.remote ||
        !input.remoteRef ||
        input.branch ||
        input.paths ||
        input.path ||
        input.hunks ||
        input.message)
    ) {
      context.addIssue({ code: 'custom', message: 'push operation arguments are invalid' });
    }
  });
export const GitWorkflowPreviewSchema = z
  .object({
    manifest: OperationManifestV1Schema,
    risk: z.enum(['medium', 'high']),
    reason: z.string().min(1).max(2_000),
    patchPreview: z
      .string()
      .max(256 * 1024)
      .nullable()
      .default(null),
  })
  .strict();
export type GitWorkflowPreview = z.infer<typeof GitWorkflowPreviewSchema>;
export const GitWorkflowResolveInputSchema = z
  .object({
    operationId: IdSchema,
    decision: z.enum(['allow-once', 'deny']),
  })
  .strict();
export const GitWorkflowResultSchema = z
  .object({ approval: ApprovalSchema, result: JsonObjectSchema.nullable() })
  .strict();

export const SponsorSchema = z.object({
  routerTurnId: z.string().min(1).max(300).nullable().default(null),
  tier: SponsorTierSchema,
  sponsorName: z.string().min(1).max(120).nullable(),
  headline: z.string().max(240).nullable(),
  body: z.string().max(1_000).nullable(),
  url: z
    .string()
    .url()
    .refine((url) => new URL(url).protocol === 'https:', 'Expected HTTPS URL')
    .nullable(),
  reason: z.string().max(1_000).default(''),
  provisionalSavings: z.number().nonnegative().default(0),
  subsidyPercent: z.number().min(0).max(100),
});
export type Sponsor = z.infer<typeof SponsorSchema>;

export const SettlementSchema = z.object({
  routerTurnId: z.string().min(1).max(300),
  cost: z.number().nonnegative(),
  subsidy: z.number().nonnegative(),
  paid: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  inferencePurpose: z.string().max(240).default('agent'),
  sponsor: SponsorSchema.nullable(),
  timestamp: TimestampSchema,
});
export type Settlement = z.infer<typeof SettlementSchema>;

export const FileStatusSchema = z.enum(['modified', 'created', 'deleted', 'reverted', 'conflict']);
export const DiffFileSchema = z.object({
  path: z.string().min(1),
  status: FileStatusSchema,
  original: z.string(),
  current: z.string(),
  baselineHash: z.string().nullable(),
  latestAgentHash: z.string().nullable(),
  currentHash: z.string().nullable(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const RouterConfigurationSchema = z.object({
  serverUrl: z.string(),
  sponsoredCompute: z.boolean(),
  tokenStored: z.boolean(),
  configured: z.boolean(),
  models: z.array(RouterModelDescriptorSchema),
  catalog: RouterCatalogStatusSchema,
  selectedModel: z.string().min(1).max(300).nullable(),
  selectedThinkingLevel: ThinkingLevelSchema,
  lastCheckedAt: TimestampSchema.nullable(),
  authentication: InstallationDiagnosticsSchema,
});
export type RouterConfiguration = z.infer<typeof RouterConfigurationSchema>;
export const SignOutResultSchema = z.object({
  configuration: RouterConfigurationSchema,
  remoteRevocationConfirmed: z.boolean(),
});
export type SignOutResult = z.infer<typeof SignOutResultSchema>;

export const RouterDiagnosticsSchema = z.object({
  health: z.boolean(),
  authenticated: z.boolean(),
  mode: z.enum(['live', 'mock', 'unknown']),
  models: z.array(RouterModelDescriptorSchema),
  catalog: RouterCatalogStatusSchema,
  modelsStale: z.boolean(),
  checkedAt: TimestampSchema,
  error: z.string().nullable(),
  authentication: InstallationDiagnosticsSchema,
});
export type RouterDiagnostics = z.infer<typeof RouterDiagnosticsSchema>;

export const RouterConfigurationInputSchema = z.object({
  serverUrl: z.string().url(),
  token: z.string().min(1).max(16_384),
  sponsoredCompute: z.boolean(),
});

export const EnrollmentStartInputSchema = z.object({
  serverUrl: z.string().url(),
  sponsoredCompute: z.boolean(),
  displayName: z.string().trim().min(1).max(120).default('AdRouter Agent'),
});

export const CustomRouterConfigurationInputSchema = RouterConfigurationInputSchema.refine(
  (input) => {
    const url = new URL(input.serverUrl);
    return (
      url.origin !== 'https://api.adrouter.co' && url.origin !== 'https://api-staging.adrouter.co'
    );
  },
  'Official AdRouter origins require installation authentication.'
);

export const RouterTestInputSchema = z.object({
  serverUrl: z.string().url(),
  token: z.string().min(1).max(16_384),
});

export const ProjectOpenInputSchema = z.object({
  path: z.string().min(1).optional(),
});
export const ProjectIdInputSchema = z.object({ id: IdSchema });
export const ProjectUpdateInputSchema = z.object({
  id: IdSchema,
  displayName: z.string().min(1).max(120).optional(),
  instructions: z.string().max(100_000).optional(),
  permissionMode: PermissionModeSchema.optional(),
  delegationEnabled: z.boolean().optional(),
});
export const BundleListInputSchema = z.object({ projectId: IdSchema });
export const BundleTrustInputSchema = z
  .object({
    projectId: IdSchema,
    bundleId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    version: SemanticVersionSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const BundleRevokeInputSchema = z
  .object({
    projectId: IdSchema,
    bundleId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  })
  .strict();
export const AutomationPairingInputSchema = z.object({ pairingId: IdSchema }).strict();
export const AutomationClientInputSchema = z.object({ clientId: IdSchema }).strict();
export const AutomationEndpointSchema = z
  .object({
    protocolVersion: z.literal(1),
    endpoint: z.string().min(1).max(4_096),
    kind: z.enum(['unix-socket', 'named-pipe']),
  })
  .strict();

export const ThreadCreateInputSchema = z.object({
  projectId: IdSchema,
  title: z.string().min(1).max(240),
  model: z.string().min(1).max(300),
  thinkingLevel: ThinkingLevelSchema.default('medium'),
});
export const ThreadListInputSchema = z.object({ projectId: IdSchema });
export const ThreadIdInputSchema = z.object({ id: IdSchema });
export const ThreadSearchInputSchema = z
  .object({ projectId: IdSchema, query: z.string().trim().min(1).max(200) })
  .strict();
export const ThreadLabelInputSchema = z
  .object({ id: IdSchema, label: z.string().trim().min(1).max(120).nullable() })
  .strict();
export const ThreadForkInputSchema = z
  .object({ checkpointId: IdSchema, title: z.string().trim().min(1).max(240).optional() })
  .strict();
export const SessionExportInputSchema = z
  .object({ threadId: IdSchema, includeBilling: z.boolean().default(false) })
  .strict();
export const SessionImportInputSchema = z
  .object({ projectId: IdSchema, session: SessionExportV1Schema })
  .strict();
export const SessionHtmlExportInputSchema = z.object({ threadId: IdSchema }).strict();
export const SessionImportPreviewInputSchema = z
  .object({
    projectId: IdSchema,
    sourceName: z.string().trim().min(1).max(240),
    content: z
      .string()
      .min(1)
      .max(10 * 1024 * 1024),
  })
  .strict();
export const SessionImportConfirmInputSchema = z.object({ previewId: IdSchema }).strict();
export const SessionCopyLastInputSchema = z.object({ threadId: IdSchema }).strict();

export const RouterPreferencesInputSchema = z.object({
  model: z.string().min(1).max(300),
  thinkingLevel: ThinkingLevelSchema,
});

export const TurnStartInputSchema = z.object({
  threadId: IdSchema,
  input: z.string().min(1).max(200_000),
  model: z.string().min(1).max(300),
  thinkingLevel: ThinkingLevelSchema,
  runtimeMode: RuntimeModeSchema.default('auto'),
});
export const TurnMessageInputSchema = z.object({
  threadId: IdSchema,
  input: z.string().min(1).max(200_000),
});
export const TurnStopInputSchema = z.object({ threadId: IdSchema });
export const TurnCompactInputSchema = z.object({ threadId: IdSchema });
export const TurnClearQueueInputSchema = z.object({ threadId: IdSchema });
export const ApprovalResolveInputSchema = z.object({
  approvalId: IdSchema,
  decision: ApprovalDecisionSchema,
});

export const ReviewDiffInputSchema = z.object({
  threadId: IdSchema,
  path: z.string().min(1).optional(),
});
export const ReviewRevertFileInputSchema = z.object({
  threadId: IdSchema,
  path: z.string().min(1),
});
export const ReviewRevertAllInputSchema = z.object({ threadId: IdSchema });
export const ReviewAcceptInputSchema = z.object({ threadId: IdSchema });
export const ReviewOpenFileInputSchema = z.object({ threadId: IdSchema, path: z.string().min(1) });

export const EventsSubscribeInputSchema = z.object({ threadId: IdSchema });
export const EventsUnsubscribeInputSchema = z.object({ subscriptionId: IdSchema });

export const OkSchema = z.object({ ok: z.literal(true) });
export const SubscriptionSchema = z.object({ subscriptionId: IdSchema });
export const ApplicationInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  platform: z.string().min(1),
  architecture: z.string().min(1),
  sandbox: z.object({
    status: z.enum(['ready', 'setup-required', 'unsupported']),
    detail: z.string().min(1),
    setupCommands: z.array(z.string().min(1)),
  }),
});
export type ApplicationInfo = z.infer<typeof ApplicationInfoSchema>;
export const RevertResultSchema = z.object({
  reverted: z.array(z.string()),
  conflicts: z.array(z.string()),
});

export const ThreadDetailSchema = z.object({
  thread: ThreadSchema,
  turns: z.array(TurnSchema),
  events: z.array(EventSchema),
  approvals: z.array(ApprovalSchema),
  checkpoints: z.array(SessionCheckpointSchema),
  gitBaseline: GitTaskBaselineSchema.nullable(),
  contextBudget: ContextBudgetSnapshotSchema.nullable(),
});

export const IpcSchemas = {
  'configuration.get': { input: z.object({}), output: RouterConfigurationSchema },
  'configuration.save': {
    input: CustomRouterConfigurationInputSchema,
    output: RouterConfigurationSchema,
  },
  'configuration.testRouter': { input: RouterTestInputSchema, output: RouterDiagnosticsSchema },
  'configuration.status': { input: z.object({}), output: RouterDiagnosticsSchema },
  'configuration.signOut': { input: z.object({}), output: SignOutResultSchema },
  'configuration.startEnrollment': {
    input: EnrollmentStartInputSchema,
    output: EnrollmentStatusSchema,
  },
  'configuration.continueEnrollment': { input: z.object({}), output: EnrollmentStatusSchema },
  'configuration.enrollmentStatus': { input: z.object({}), output: EnrollmentStatusSchema },
  'configuration.cancelEnrollment': { input: z.object({}), output: EnrollmentStatusSchema },
  'configuration.openEnrollment': { input: z.object({}), output: OkSchema },
  'configuration.copyEnrollmentLink': { input: z.object({}), output: OkSchema },
  'configuration.updatePreferences': {
    input: RouterPreferencesInputSchema,
    output: RouterConfigurationSchema,
  },
  'projects.open': { input: ProjectOpenInputSchema, output: ProjectSchema },
  'projects.list': { input: z.object({}), output: z.array(ProjectSchema) },
  'projects.get': { input: ProjectIdInputSchema, output: ProjectSchema },
  'projects.update': { input: ProjectUpdateInputSchema, output: ProjectSchema },
  'projects.remove': { input: ProjectIdInputSchema, output: OkSchema },
  'bundles.list': { input: BundleListInputSchema, output: z.array(BundleSummarySchema) },
  'bundles.trust': { input: BundleTrustInputSchema, output: BundleSummarySchema },
  'bundles.revoke': { input: BundleRevokeInputSchema, output: BundleSummarySchema },
  'automation.endpoint': { input: z.object({}), output: AutomationEndpointSchema },
  'automation.pairings': { input: z.object({}), output: z.array(AutomationPairingSchema) },
  'automation.approvePairing': {
    input: AutomationPairingInputSchema,
    output: AutomationPairingSchema,
  },
  'automation.denyPairing': {
    input: AutomationPairingInputSchema,
    output: AutomationPairingSchema,
  },
  'automation.clients': { input: z.object({}), output: z.array(AutomationClientSchema) },
  'automation.revokeClient': {
    input: AutomationClientInputSchema,
    output: AutomationClientSchema,
  },
  'threads.create': { input: ThreadCreateInputSchema, output: ThreadSchema },
  'threads.list': { input: ThreadListInputSchema, output: z.array(ThreadSchema) },
  'threads.search': { input: ThreadSearchInputSchema, output: z.array(ThreadSchema) },
  'threads.get': { input: ThreadIdInputSchema, output: ThreadDetailSchema },
  'threads.label': { input: ThreadLabelInputSchema, output: ThreadSchema },
  'threads.continue': { input: ThreadIdInputSchema, output: ThreadSchema },
  'threads.fork': { input: ThreadForkInputSchema, output: ThreadSchema },
  'threads.archive': { input: ThreadIdInputSchema, output: ThreadSchema },
  'threads.delete': { input: ThreadIdInputSchema, output: OkSchema },
  'sessions.export': { input: SessionExportInputSchema, output: SessionExportV1Schema },
  'sessions.exportHtml': {
    input: SessionHtmlExportInputSchema,
    output: SessionHtmlExportSchema,
  },
  'sessions.previewImport': {
    input: SessionImportPreviewInputSchema,
    output: SessionImportPreviewSchema,
  },
  'sessions.confirmImport': {
    input: SessionImportConfirmInputSchema,
    output: ThreadSchema,
  },
  'sessions.copyLast': { input: SessionCopyLastInputSchema, output: OkSchema },
  'sessions.import': { input: SessionImportInputSchema, output: ThreadSchema },
  'git.preview': { input: GitWorkflowPreviewInputSchema, output: GitWorkflowPreviewSchema },
  'git.resolve': { input: GitWorkflowResolveInputSchema, output: GitWorkflowResultSchema },
  'turns.start': { input: TurnStartInputSchema, output: TurnSchema },
  'turns.steer': { input: TurnMessageInputSchema, output: OkSchema },
  'turns.queueFollowUp': { input: TurnMessageInputSchema, output: OkSchema },
  'turns.compact': { input: TurnCompactInputSchema, output: TurnSchema },
  'turns.clearQueue': { input: TurnClearQueueInputSchema, output: OkSchema },
  'turns.stop': { input: TurnStopInputSchema, output: OkSchema },
  'approvals.resolve': { input: ApprovalResolveInputSchema, output: ApprovalSchema },
  'review.getDiff': { input: ReviewDiffInputSchema, output: z.array(DiffFileSchema) },
  'review.revertFile': { input: ReviewRevertFileInputSchema, output: RevertResultSchema },
  'review.revertAll': { input: ReviewRevertAllInputSchema, output: RevertResultSchema },
  'review.accept': { input: ReviewAcceptInputSchema, output: OkSchema },
  'review.openFile': { input: ReviewOpenFileInputSchema, output: OkSchema },
  'events.subscribe': { input: EventsSubscribeInputSchema, output: SubscriptionSchema },
  'events.unsubscribe': { input: EventsUnsubscribeInputSchema, output: OkSchema },
  'app.getInfo': { input: z.object({}), output: ApplicationInfoSchema },
  'app.getVersion': { input: z.object({}), output: z.object({ version: z.string() }) },
  'app.getPlatform': { input: z.object({}), output: z.object({ platform: z.string() }) },
} as const;

export type IpcMethod = keyof typeof IpcSchemas;

export type InferIpcInput<T extends IpcMethod> = z.infer<(typeof IpcSchemas)[T]['input']>;
export type InferIpcOutput<T extends IpcMethod> = z.infer<(typeof IpcSchemas)[T]['output']>;

export interface AdrouterApi {
  configuration: {
    get(): Promise<RouterConfiguration>;
    save(input: z.input<typeof RouterConfigurationInputSchema>): Promise<RouterConfiguration>;
    testRouter(input: z.input<typeof RouterTestInputSchema>): Promise<RouterDiagnostics>;
    status(): Promise<RouterDiagnostics>;
    signOut(): Promise<SignOutResult>;
    startEnrollment(input: z.input<typeof EnrollmentStartInputSchema>): Promise<EnrollmentStatus>;
    continueEnrollment(): Promise<EnrollmentStatus>;
    enrollmentStatus(): Promise<EnrollmentStatus>;
    cancelEnrollment(): Promise<EnrollmentStatus>;
    openEnrollment(): Promise<{ ok: true }>;
    copyEnrollmentLink(): Promise<{ ok: true }>;
    updatePreferences(
      input: z.input<typeof RouterPreferencesInputSchema>
    ): Promise<RouterConfiguration>;
  };
  projects: {
    open(input?: z.input<typeof ProjectOpenInputSchema>): Promise<Project>;
    list(): Promise<Project[]>;
    get(input: z.input<typeof ProjectIdInputSchema>): Promise<Project>;
    update(input: z.input<typeof ProjectUpdateInputSchema>): Promise<Project>;
    remove(input: z.input<typeof ProjectIdInputSchema>): Promise<{ ok: true }>;
  };
  bundles: {
    list(input: z.input<typeof BundleListInputSchema>): Promise<BundleSummary[]>;
    trust(input: z.input<typeof BundleTrustInputSchema>): Promise<BundleSummary>;
    revoke(input: z.input<typeof BundleRevokeInputSchema>): Promise<BundleSummary>;
  };
  automation: {
    endpoint(): Promise<z.infer<typeof AutomationEndpointSchema>>;
    pairings(): Promise<AutomationPairing[]>;
    approvePairing(input: z.input<typeof AutomationPairingInputSchema>): Promise<AutomationPairing>;
    denyPairing(input: z.input<typeof AutomationPairingInputSchema>): Promise<AutomationPairing>;
    clients(): Promise<AutomationClient[]>;
    revokeClient(input: z.input<typeof AutomationClientInputSchema>): Promise<AutomationClient>;
  };
  threads: {
    create(input: z.input<typeof ThreadCreateInputSchema>): Promise<Thread>;
    list(input: z.input<typeof ThreadListInputSchema>): Promise<Thread[]>;
    search(input: z.input<typeof ThreadSearchInputSchema>): Promise<Thread[]>;
    get(input: z.input<typeof ThreadIdInputSchema>): Promise<z.infer<typeof ThreadDetailSchema>>;
    label(input: z.input<typeof ThreadLabelInputSchema>): Promise<Thread>;
    continue(input: z.input<typeof ThreadIdInputSchema>): Promise<Thread>;
    fork(input: z.input<typeof ThreadForkInputSchema>): Promise<Thread>;
    archive(input: z.input<typeof ThreadIdInputSchema>): Promise<Thread>;
    delete(input: z.input<typeof ThreadIdInputSchema>): Promise<{ ok: true }>;
  };
  sessions: {
    export(input: z.input<typeof SessionExportInputSchema>): Promise<SessionExportV1>;
    exportHtml(input: z.input<typeof SessionHtmlExportInputSchema>): Promise<SessionHtmlExport>;
    previewImport(
      input: z.input<typeof SessionImportPreviewInputSchema>
    ): Promise<SessionImportPreview>;
    confirmImport(input: z.input<typeof SessionImportConfirmInputSchema>): Promise<Thread>;
    copyLast(input: z.input<typeof SessionCopyLastInputSchema>): Promise<{ ok: true }>;
    import(input: z.input<typeof SessionImportInputSchema>): Promise<Thread>;
  };
  git: {
    preview(input: z.input<typeof GitWorkflowPreviewInputSchema>): Promise<GitWorkflowPreview>;
    resolve(
      input: z.input<typeof GitWorkflowResolveInputSchema>
    ): Promise<z.infer<typeof GitWorkflowResultSchema>>;
  };
  turns: {
    start(input: z.input<typeof TurnStartInputSchema>): Promise<Turn>;
    steer(input: z.input<typeof TurnMessageInputSchema>): Promise<{ ok: true }>;
    queueFollowUp(input: z.input<typeof TurnMessageInputSchema>): Promise<{ ok: true }>;
    compact(input: z.input<typeof TurnCompactInputSchema>): Promise<Turn>;
    clearQueue(input: z.input<typeof TurnClearQueueInputSchema>): Promise<{ ok: true }>;
    stop(input: z.input<typeof TurnStopInputSchema>): Promise<{ ok: true }>;
  };
  approvals: {
    resolve(input: z.input<typeof ApprovalResolveInputSchema>): Promise<Approval>;
  };
  review: {
    getDiff(input: z.input<typeof ReviewDiffInputSchema>): Promise<DiffFile[]>;
    revertFile(
      input: z.input<typeof ReviewRevertFileInputSchema>
    ): Promise<z.infer<typeof RevertResultSchema>>;
    revertAll(
      input: z.input<typeof ReviewRevertAllInputSchema>
    ): Promise<z.infer<typeof RevertResultSchema>>;
    accept(input: z.input<typeof ReviewAcceptInputSchema>): Promise<{ ok: true }>;
    openFile(input: z.input<typeof ReviewOpenFileInputSchema>): Promise<{ ok: true }>;
  };
  events: {
    subscribe(
      input: z.input<typeof EventsSubscribeInputSchema>,
      listener: (event: JournalEvent) => void
    ): Promise<string>;
    unsubscribe(input: z.input<typeof EventsUnsubscribeInputSchema>): Promise<{ ok: true }>;
  };
  app: {
    getInfo(): Promise<ApplicationInfo>;
    getVersion(): Promise<{ version: string }>;
    getPlatform(): Promise<{ platform: string }>;
  };
}
