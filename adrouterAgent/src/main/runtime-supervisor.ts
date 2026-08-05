import { type UtilityProcess, utilityProcess } from 'electron';
import {
  INSTALLATION_AUTH_PROTOCOL_VERSION,
  MAX_SIGNED_REQUEST_BYTES,
  OPERATION_BROKER_PROTOCOL_VERSION,
} from '../shared/constants';
import {
  type ApprovalDecision,
  ApprovalSchema,
  ApprovalV2Schema,
  type EventType,
  type JournalEvent,
  type RouterModelDescriptor,
  type SessionEntry,
  SettlementSchema,
  type TurnStatus,
} from '../shared/contracts';
import {
  type RuntimeAuthRequest,
  type RuntimeEvent,
  type RuntimeOperationRequest,
  type RuntimePortMessage,
  RuntimePortMessageSchema,
  type RuntimeRequest,
} from '../shared/runtime-protocol';
import { now, safeRecord } from '../shared/security';
import type { BundleService } from './bundle-service';
import type { RuntimeRouterConfiguration } from './configuration-store';
import type { AppDatabase } from './database';
import type { InstallationAuthManager } from './installation-auth';
import { OperationBroker } from './operation-broker';
import { type RuntimeLease, RuntimeScheduler, resolveRuntimeLease } from './runtime-scheduler';

const terminalStatuses = new Set<TurnStatus>(['completed', 'failed', 'cancelled', 'interrupted']);
const MAX_AUTH_REQUESTS_PER_RUNTIME = 2;

interface ActiveRuntime {
  threadId: string;
  turnId: string;
  child: UtilityProcess;
  closing: boolean;
  exited: boolean;
  ready: Promise<void>;
  markReady: () => void;
  authMode: RuntimeRouterConfiguration['authMode'];
  authControllers: Map<string, AbortController>;
  operationControllers: Map<string, AbortController>;
}

interface PendingRuntime {
  input: StartRuntimeInput;
  router: RuntimeRouterConfiguration;
  lease: RuntimeLease;
}

export interface StartRuntimeInput {
  threadId: string;
  turnId: string;
  input: string;
  model: RouterModelDescriptor;
  thinkingLevel: 'none' | 'medium' | 'high';
  runtimeMode: 'auto' | 'mock' | 'live';
  history: SessionEntry[];
}

export class RuntimeSupervisor {
  private readonly active = new Map<string, ActiveRuntime>();
  private readonly pending = new Map<string, PendingRuntime>();
  private delegationHandler?: (
    manifest: Parameters<OperationBroker['execute']>[0]
  ) => Promise<Record<string, unknown>>;

  public constructor(
    private readonly database: AppDatabase,
    private readonly runtimePath: string,
    private readonly emitJournalEvent: (event: JournalEvent) => void,
    private readonly installationAuth?: InstallationAuthManager,
    private readonly operationBroker = new OperationBroker(),
    private readonly scheduler = new RuntimeScheduler(),
    private readonly bundleService?: BundleService
  ) {}

  public get activeThreadId(): string | undefined {
    return this.active.keys().next().value ?? this.pending.keys().next().value;
  }

  public get activeThreadIds(): string[] {
    return [...this.active.keys(), ...this.pending.keys()];
  }

  public get hasTasks(): boolean {
    return this.active.size > 0 || this.pending.size > 0;
  }

  public get runtimeStatus(): {
    capacity: number;
    active: number;
    queued: number;
    activeThreadIds: string[];
  } {
    return {
      capacity: this.scheduler.capacity,
      active: this.active.size,
      queued: this.pending.size,
      activeThreadIds: this.activeThreadIds,
    };
  }

  public hasThread(threadId: string): boolean {
    return this.active.has(threadId) || this.pending.has(threadId);
  }

  public setDelegationHandler(
    handler: (
      manifest: Parameters<OperationBroker['execute']>[0]
    ) => Promise<Record<string, unknown>>
  ): void {
    if (this.delegationHandler) throw new Error('The delegation handler is already configured.');
    this.delegationHandler = handler;
  }

  public async start(input: StartRuntimeInput, router: RuntimeRouterConfiguration): Promise<void> {
    if (this.hasThread(input.threadId)) {
      throw new Error('This task already has an active or queued runtime.');
    }
    const thread = this.database.getThread(input.threadId);
    if (!thread) {
      throw new Error('Thread not found.');
    }
    const project = this.database.getProject(thread.projectId);
    if (!project) {
      throw new Error('Project not found.');
    }

    const lease = await resolveRuntimeLease(input.turnId, project.path, project.permissionMode);
    const pending: PendingRuntime = { input, router, lease };
    this.pending.set(input.threadId, pending);
    try {
      this.scheduler.enqueue({
        ...lease,
        start: () => this.launch(pending),
        cancelled: () => {
          if (this.pending.get(input.threadId) === pending) this.pending.delete(input.threadId);
        },
        failed: (error) => this.handleLaunchFailure(pending, error),
      });
    } catch (error) {
      this.pending.delete(input.threadId);
      throw error;
    }
  }

  private async launch(pending: PendingRuntime): Promise<void> {
    const { input, router } = pending;
    if (this.pending.get(input.threadId) !== pending) {
      throw new Error('The queued task is no longer available.');
    }
    const thread = this.database.getThread(input.threadId);
    if (!thread) throw new Error('Thread not found.');
    const project = this.database.getProject(thread.projectId);
    if (!project) throw new Error('Project not found.');
    const bundlePrompt = this.bundleService?.promptContent(project.id) ?? {
      instructions: '',
      sources: [],
    };
    this.pending.delete(input.threadId);

    const child = utilityProcess.fork(this.runtimePath, [], {
      serviceName: 'AdRouter Agent Runtime',
      stdio: 'ignore',
    });
    let markReady = (): void => undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const active: ActiveRuntime = {
      threadId: input.threadId,
      turnId: input.turnId,
      child,
      closing: false,
      exited: false,
      ready,
      markReady,
      authMode: router.authMode,
      authControllers: new Map(),
      operationControllers: new Map(),
    };
    this.active.set(input.threadId, active);

    child.on('message', (message) => {
      void this.handlePortMessage(active, message).catch((error) =>
        this.handleCrash(active, error)
      );
    });
    child.once('error', (error) => this.handleCrash(active, error));
    child.once('exit', (code) => {
      active.exited = true;
      if (active.closing) {
        this.scheduler.release(active.turnId);
        return;
      }
      if (!active.closing) {
        this.handleCrash(active, new Error(`The agent runtime exited with code ${code}.`));
      }
    });
    await Promise.race([
      active.ready,
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('The isolated agent runtime did not become ready.')),
          10_000
        );
        timeout.unref();
      }),
    ]);
    child.postMessage({
      kind: 'request',
      request: {
        type: 'start',
        threadId: input.threadId,
        turnId: input.turnId,
        project: {
          id: project.id,
          path: project.path,
          displayName: project.displayName,
          instructions: project.instructions,
          repositoryInstructions: project.repositoryInstructions,
          repositoryInstructionFiles: project.repositoryInstructionFiles,
          bundleInstructions: bundlePrompt.instructions,
          promptSources: [
            ...project.repositoryInstructionFiles.map((path) => ({
              kind: 'repository' as const,
              label: path,
              digest: null,
            })),
            ...(project.instructions
              ? [{ kind: 'custom' as const, label: 'Project instructions', digest: null }]
              : []),
            ...bundlePrompt.sources,
          ],
          permissionMode: project.permissionMode,
          delegationEnabled: project.delegationEnabled,
        },
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        runtimeMode: input.runtimeMode,
        sponsoredCompute: router.sponsoredCompute,
        router:
          router.authMode === 'installation'
            ? { authMode: 'installation', serverUrl: router.serverUrl }
            : {
                authMode: 'custom_bearer',
                serverUrl: router.serverUrl,
                token: router.token,
              },
        input: input.input,
        history: input.history,
        allowedCommands: [],
      },
    } satisfies RuntimePortMessage);
  }

  public steer(threadId: string, input: string): void {
    this.send(this.getActive(threadId), { type: 'steer', input });
  }

  public queueFollowUp(threadId: string, input: string): void {
    this.send(this.getActive(threadId), {
      type: 'queue-follow-up',
      input,
    });
  }

  public clearQueue(threadId: string): void {
    this.send(this.getActive(threadId), { type: 'clear-queue' });
  }

  public stop(threadId: string): void {
    const pending = this.pending.get(threadId);
    if (pending) {
      this.pending.delete(threadId);
      this.scheduler.cancel(pending.input.turnId);
      this.finishPending(pending, 'cancelled', null);
      return;
    }
    const active = this.getActive(threadId);
    this.rejectPendingApprovals(active, 'The task was stopped.');
    this.send(active, { type: 'stop' });
    setTimeout(() => {
      if (this.isCurrent(active)) {
        this.finish(active, 'cancelled', null);
      }
    }, 5_000).unref();
  }

  public resolveApproval(approvalId: string, decision: ApprovalDecision): void {
    const approval = this.database.getApproval(approvalId);
    if (!approval) {
      throw new Error('Approval not found.');
    }
    this.send(this.getActive(approval.threadId), {
      type: 'approval',
      approvalId,
      decision,
    });
  }

  public assertApprovalActive(approvalId: string): void {
    const approval = this.database.getApproval(approvalId);
    if (!approval || approval.decision) {
      throw new Error('Approval is not pending.');
    }
    const active = this.getActive(approval.threadId);
    if (active.turnId !== approval.turnId) {
      throw new Error('Approval does not belong to the active turn.');
    }
  }

  private getActive(threadId: string): ActiveRuntime {
    const active = this.active.get(threadId);
    if (!active) {
      throw new Error('This thread has no active agent runtime.');
    }
    return active;
  }

  private isCurrent(active: ActiveRuntime): boolean {
    return this.active.get(active.threadId) === active;
  }

  private send(active: ActiveRuntime, request: RuntimeRequest): void {
    active.child.postMessage({ kind: 'request', request } satisfies RuntimePortMessage);
  }

  private async handlePortMessage(active: ActiveRuntime, raw: unknown): Promise<void> {
    const message = RuntimePortMessageSchema.parse(raw);
    if (message.kind === 'ready') {
      active.markReady();
      return;
    }
    if (message.kind === 'auth-request') {
      await this.handleAuthRequest(active, message);
      return;
    }
    if (message.kind === 'auth-cancel') {
      active.authControllers.get(message.requestId)?.abort();
      active.authControllers.delete(message.requestId);
      return;
    }
    if (message.kind === 'operation-request') {
      await this.handleOperationRequest(active, message);
      return;
    }
    if (message.kind === 'operation-cancel') {
      active.operationControllers.get(message.requestId)?.abort();
      active.operationControllers.delete(message.requestId);
      return;
    }
    if (message.kind !== 'event') {
      return;
    }
    await this.handleRuntimeEvent(active, message.event);
  }

  private async handleAuthRequest(
    active: ActiveRuntime,
    request: RuntimeAuthRequest
  ): Promise<void> {
    if (
      !this.isCurrent(active) ||
      active.closing ||
      active.authMode !== 'installation' ||
      !this.installationAuth ||
      active.authControllers.size >= MAX_AUTH_REQUESTS_PER_RUNTIME
    ) {
      this.sendAuthFailure(active, request.requestId, 'Installation signing is unavailable.');
      return;
    }
    const body =
      request.bodyBase64 === undefined ? undefined : Buffer.from(request.bodyBase64, 'base64');
    if (
      (body?.byteLength ?? 0) > MAX_SIGNED_REQUEST_BYTES ||
      (body !== undefined && body.toString('base64') !== request.bodyBase64)
    ) {
      this.sendAuthFailure(active, request.requestId, 'The signing request body is invalid.');
      return;
    }
    const controller = new AbortController();
    active.authControllers.set(request.requestId, controller);
    try {
      const headers = await this.installationAuth.authorize({
        method: request.method,
        path: request.path,
        body,
        nonce: request.nonce,
        signal: controller.signal,
      });
      if (this.isCurrent(active) && !active.closing && !controller.signal.aborted) {
        active.child.postMessage({
          kind: 'auth-response',
          protocolVersion: INSTALLATION_AUTH_PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          headers,
        } satisfies RuntimePortMessage);
      }
    } catch {
      if (!controller.signal.aborted) {
        this.sendAuthFailure(
          active,
          request.requestId,
          'The protected router request was not authorized.'
        );
      }
    } finally {
      active.authControllers.delete(request.requestId);
    }
  }

  private sendAuthFailure(active: ActiveRuntime, requestId: string, error: string): void {
    if (!this.isCurrent(active) || active.closing) return;
    active.child.postMessage({
      kind: 'auth-response',
      protocolVersion: INSTALLATION_AUTH_PROTOCOL_VERSION,
      requestId,
      ok: false,
      error,
    } satisfies RuntimePortMessage);
  }

  private async handleOperationRequest(
    active: ActiveRuntime,
    request: RuntimeOperationRequest
  ): Promise<void> {
    if (
      !this.isCurrent(active) ||
      active.closing ||
      request.manifest.threadId !== active.threadId ||
      request.manifest.turnId !== active.turnId ||
      active.operationControllers.size >= 2
    ) {
      this.sendOperationFailure(active, request.requestId, 'Structured operation is unavailable.');
      return;
    }
    try {
      this.database.consumeOperationApproval(
        request.manifest.operationId,
        request.manifest.binding
      );
    } catch {
      this.sendOperationFailure(
        active,
        request.requestId,
        'The allow-once operation approval is invalid, expired, or already consumed.'
      );
      return;
    }
    const controller = new AbortController();
    active.operationControllers.set(request.requestId, controller);
    try {
      const result =
        request.manifest.capability === 'delegation.start'
          ? await this.executeDelegation(request.manifest, controller.signal)
          : await this.operationBroker.execute(request.manifest, controller.signal);
      if (this.isCurrent(active) && !active.closing && !controller.signal.aborted) {
        active.child.postMessage({
          kind: 'operation-response',
          protocolVersion: OPERATION_BROKER_PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          result,
        } satisfies RuntimePortMessage);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.sendOperationFailure(
          active,
          request.requestId,
          error instanceof Error ? error.message : 'The structured operation failed.'
        );
      }
    } finally {
      active.operationControllers.delete(request.requestId);
    }
  }

  private async executeDelegation(
    manifest: Parameters<OperationBroker['execute']>[0],
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) throw new Error('The delegated task request was cancelled.');
    if (!this.delegationHandler) throw new Error('Delegated tasks are unavailable.');
    return this.delegationHandler(manifest);
  }

  private sendOperationFailure(active: ActiveRuntime, requestId: string, error: string): void {
    if (!this.isCurrent(active) || active.closing) return;
    active.child.postMessage({
      kind: 'operation-response',
      protocolVersion: OPERATION_BROKER_PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: error.slice(0, 1_000),
    } satisfies RuntimePortMessage);
  }

  private async handleRuntimeEvent(
    active: ActiveRuntime,
    runtimeEvent: RuntimeEvent
  ): Promise<void> {
    if (!this.isCurrent(active)) {
      return;
    }
    const payload = safeRecord(runtimeEvent.payload);
    if (runtimeEvent.type === 'approval.request') {
      const approval = ApprovalSchema.parse({
        ...payload,
        id: payload.id,
        threadId: active.threadId,
        turnId: active.turnId,
        decision: null,
        resolvedAt: null,
      });
      this.database.createApproval(
        approval.version === 2 ? ApprovalV2Schema.parse(approval) : approval
      );
    }
    if (runtimeEvent.type === 'file.change') {
      this.database.recordFileMutation({
        threadId: active.threadId,
        path: String(payload.path),
        status: String(payload.status),
        beforeBase64: typeof payload.beforeBase64 === 'string' ? payload.beforeBase64 : null,
        afterBase64: typeof payload.afterBase64 === 'string' ? payload.afterBase64 : null,
        beforeHash: typeof payload.beforeHash === 'string' ? payload.beforeHash : null,
        afterHash: typeof payload.afterHash === 'string' ? payload.afterHash : null,
      });
      delete payload.beforeBase64;
      delete payload.afterBase64;
    }
    if (runtimeEvent.type === 'settlement') {
      const settlement = SettlementSchema.parse(payload);
      if (!this.database.addRouterOutcome(active.threadId, active.turnId, settlement)) {
        return;
      }
    }
    if (runtimeEvent.type === 'turn.lifecycle') {
      const status = payload.status as TurnStatus;
      const error = typeof payload.error === 'string' ? payload.error : null;
      this.database.updateTurnStatus(active.turnId, status, error);
      this.emitLastEvent(active.threadId);
      if (status === 'awaiting_approval') {
        this.setThreadStatus(active.threadId, 'awaiting_approval');
      } else if (status === 'preparing' || status === 'running') {
        this.setThreadStatus(active.threadId, 'running');
      } else if (terminalStatuses.has(status)) {
        this.finish(active, status, error);
      }
      return;
    }

    const event = this.database.appendEvent(
      active.threadId,
      runtimeEvent.turnId,
      runtimeEvent.type as EventType,
      payload
    );
    this.emitJournalEvent(event);
  }

  private setThreadStatus(
    threadId: string,
    status: 'idle' | 'running' | 'awaiting_approval' | 'failed'
  ): void {
    this.database.updateThreadStatus(threadId, status);
    this.emitLastEvent(threadId);
  }

  private handleLaunchFailure(pending: PendingRuntime, error: unknown): void {
    const active = this.active.get(pending.input.threadId);
    if (active?.turnId === pending.input.turnId) {
      this.handleCrash(active, error);
      return;
    }
    if (this.pending.get(pending.input.threadId) === pending) {
      this.pending.delete(pending.input.threadId);
    }
    const turn = this.database.getTurn(pending.input.turnId);
    if (!turn || terminalStatuses.has(turn.status)) return;
    const event = this.database.appendEvent(
      pending.input.threadId,
      pending.input.turnId,
      'runtime.crash',
      {
        error: error instanceof Error ? error.message : String(error),
        timestamp: now(),
      }
    );
    this.emitJournalEvent(event);
    this.finishPending(
      pending,
      'failed',
      'The isolated agent runtime could not be started safely.'
    );
  }

  private finishPending(
    pending: PendingRuntime,
    status: Extract<TurnStatus, 'failed' | 'cancelled' | 'interrupted'>,
    error: string | null
  ): void {
    const { threadId, turnId } = pending.input;
    const turn = this.database.getTurn(turnId);
    if (!turn || terminalStatuses.has(turn.status)) return;
    this.database.updateTurnStatus(turnId, status, error);
    this.emitLastEvent(threadId);
    this.setThreadStatus(threadId, status === 'failed' ? 'failed' : 'idle');
    const evidence = this.database.appendEvent(
      threadId,
      turnId,
      'final.evidence',
      this.database.buildEvidence(threadId, turnId)
    );
    this.emitJournalEvent(evidence);
  }

  private finish(active: ActiveRuntime, status: TurnStatus, error: string | null): void {
    if (!this.isCurrent(active)) {
      return;
    }
    this.rejectPendingApprovals(
      active,
      status === 'cancelled'
        ? 'The task was cancelled.'
        : 'The agent runtime ended before this approval was resolved.'
    );
    const turn = this.database.getTurn(active.turnId);
    if (turn?.status !== status) {
      this.database.updateTurnStatus(active.turnId, status, error);
      this.emitLastEvent(active.threadId);
    }
    this.setThreadStatus(active.threadId, status === 'failed' ? 'failed' : 'idle');
    const evidence = this.database.appendEvent(
      active.threadId,
      active.turnId,
      'final.evidence',
      this.database.buildEvidence(active.threadId, active.turnId)
    );
    this.emitJournalEvent(evidence);
    active.closing = true;
    for (const controller of active.authControllers.values()) controller.abort();
    active.authControllers.clear();
    for (const controller of active.operationControllers.values()) controller.abort();
    active.operationControllers.clear();
    active.child.kill();
    this.active.delete(active.threadId);
    if (active.exited) this.scheduler.release(active.turnId);
  }

  private rejectPendingApprovals(active: ActiveRuntime, reason: string): void {
    for (const approval of this.database.denyPendingApprovalsForTurn(active.turnId)) {
      const event = this.database.appendEvent(active.threadId, active.turnId, 'approval.resolved', {
        approvalId: approval.id,
        decision: 'deny',
        reason,
      });
      this.emitJournalEvent(event);
    }
  }

  private handleCrash(active: ActiveRuntime, error: unknown): void {
    if (!this.isCurrent(active)) {
      return;
    }
    const event = this.database.appendEvent(active.threadId, active.turnId, 'runtime.crash', {
      error: error instanceof Error ? error.message : String(error),
      timestamp: now(),
    });
    this.emitJournalEvent(event);
    this.finish(active, 'interrupted', 'The isolated agent runtime stopped unexpectedly.');
  }

  private emitLastEvent(threadId: string): void {
    const event = this.database.listEvents(threadId).at(-1);
    if (event) {
      this.emitJournalEvent(event);
    }
  }
}
