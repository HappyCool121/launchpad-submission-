import {
  app,
  clipboard,
  type IpcMainInvokeEvent,
  ipcMain,
  shell,
  type WebContents,
} from 'electron';
import { sandboxReadiness } from '../runtime/platform';
import {
  ApprovalSchema,
  type IpcMethod,
  IpcSchemas,
  type JournalEvent,
  ThreadDetailSchema,
} from '../shared/contracts';
import { createId } from '../shared/security';
import type { BundleService } from './bundle-service';
import type { ConfigurationStore } from './configuration-store';
import type { AppDatabase } from './database';
import type { GitWorkflowService } from './git-workflow-service';
import type { InstallationAuthManager } from './installation-auth';
import type { LocalRpcServer } from './local-rpc-server';
import type { RepositoryService } from './repository-service';
import type { ReviewService } from './review-service';
import type { RuntimeSupervisor } from './runtime-supervisor';
import type { SessionService } from './session-service';
import type { TaskService } from './task-service';

const PUBLIC_RELEASE_VERSION = '0.1.0-beta.12';

interface Subscription {
  id: string;
  webContents: WebContents;
  threadId: string;
}

export class EventSubscriptions {
  private readonly subscriptions = new Map<string, Subscription>();

  public subscribe(webContents: WebContents, threadId: string): string {
    const id = createId();
    this.subscriptions.set(id, { id, webContents, threadId });
    webContents.once('destroyed', () => this.removeByWebContents(webContents));
    return id;
  }

  public unsubscribe(webContents: WebContents, id: string): boolean {
    const subscription = this.subscriptions.get(id);
    if (!subscription || subscription.webContents !== webContents) {
      return false;
    }
    this.subscriptions.delete(id);
    return true;
  }

  public publish(event: JournalEvent): void {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.threadId === event.threadId && !subscription.webContents.isDestroyed()) {
        subscription.webContents.send('adrouter:event', {
          subscriptionId: subscription.id,
          event,
        });
      }
    }
  }

  private removeByWebContents(webContents: WebContents): void {
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.webContents === webContents) {
        this.subscriptions.delete(id);
      }
    }
  }
}

const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) {
    throw new Error('Rejected IPC from a non-main renderer frame.');
  }
  const url = new URL(frame.url);
  if (url.protocol !== 'app:' || url.hostname !== 'renderer') {
    throw new Error('Rejected IPC from an untrusted renderer frame.');
  }
};

type Handler = (input: unknown, event: IpcMainInvokeEvent) => Promise<unknown> | unknown;

const register = (method: IpcMethod, handler: Handler): void => {
  ipcMain.handle(`adrouter:${method}`, async (event, rawInput) => {
    assertTrustedSender(event);
    const schemas = IpcSchemas[method];
    const input = schemas.input.parse(rawInput);
    const result = await handler(input, event);
    return schemas.output.parse(result);
  });
};

export interface IpcDependencies {
  database: AppDatabase;
  configuration: ConfigurationStore;
  repositories: RepositoryService;
  review: ReviewService;
  supervisor: RuntimeSupervisor;
  installationAuth: InstallationAuthManager;
  bundles: BundleService;
  tasks: TaskService;
  automation: LocalRpcServer;
  sessions: SessionService;
  gitWorkflows: GitWorkflowService;
}

export const registerIpcHandlers = (dependencies: IpcDependencies): EventSubscriptions => {
  const {
    automation,
    bundles,
    configuration,
    database,
    installationAuth,
    gitWorkflows,
    repositories,
    review,
    sessions,
    supervisor,
    tasks,
  } = dependencies;
  const subscriptions = new EventSubscriptions();

  register('configuration.get', () => configuration.get());
  register('configuration.save', (raw) =>
    configuration.save(IpcSchemas['configuration.save'].input.parse(raw))
  );
  register('configuration.testRouter', (raw) =>
    configuration.test(IpcSchemas['configuration.testRouter'].input.parse(raw))
  );
  register('configuration.status', () => installationAuth.diagnostics());
  register('configuration.signOut', () => {
    if (supervisor.hasTasks) {
      throw new Error('Stop all active or queued agent tasks before signing out.');
    }
    return installationAuth.signOut();
  });
  register('configuration.startEnrollment', async (raw) => {
    const status = await installationAuth.startEnrollment(
      IpcSchemas['configuration.startEnrollment'].input.parse(raw)
    );
    try {
      await shell.openExternal(await installationAuth.enrollmentUrl());
      return status;
    } catch {
      return installationAuth.noteBrowserOpenFailure();
    }
  });
  register('configuration.continueEnrollment', () => installationAuth.continueEnrollment());
  register('configuration.enrollmentStatus', () => installationAuth.enrollmentStatus());
  register('configuration.cancelEnrollment', () => installationAuth.cancelEnrollment());
  register('configuration.openEnrollment', async () => {
    try {
      await shell.openExternal(await installationAuth.enrollmentUrl());
    } catch {
      throw new Error('The browser could not be opened. Copy the link and open it manually.');
    }
    return { ok: true };
  });
  register('configuration.copyEnrollmentLink', async () => {
    try {
      clipboard.writeText(await installationAuth.enrollmentUrl());
    } catch {
      throw new Error('The enrollment link could not be copied.');
    }
    return { ok: true };
  });
  register('configuration.updatePreferences', (raw) =>
    configuration.updatePreferences(IpcSchemas['configuration.updatePreferences'].input.parse(raw))
  );

  register('projects.open', async (raw) => {
    const input = IpcSchemas['projects.open'].input.parse(raw);
    return repositories.open(input.path);
  });
  register('projects.list', () => database.listProjects());
  register('projects.get', (raw) => {
    const project = database.getProject(IpcSchemas['projects.get'].input.parse(raw).id);
    if (!project) {
      throw new Error('Project not found.');
    }
    return project;
  });
  register('projects.update', (raw) => {
    const input = IpcSchemas['projects.update'].input.parse(raw);
    return database.updateProject(input.id, {
      displayName: input.displayName,
      instructions: input.instructions,
      permissionMode: input.permissionMode,
      delegationEnabled: input.delegationEnabled,
    });
  });
  register('projects.remove', (raw) => {
    database.removeProject(IpcSchemas['projects.remove'].input.parse(raw).id);
    return { ok: true };
  });

  register('bundles.list', (raw) => {
    const input = IpcSchemas['bundles.list'].input.parse(raw);
    return bundles.list(input.projectId);
  });
  register('bundles.trust', (raw) => {
    const input = IpcSchemas['bundles.trust'].input.parse(raw);
    return bundles.trust(input.projectId, input.bundleId, input.version, input.digest);
  });
  register('bundles.revoke', (raw) => {
    const input = IpcSchemas['bundles.revoke'].input.parse(raw);
    return bundles.revoke(input.projectId, input.bundleId);
  });

  register('automation.endpoint', () => ({
    protocolVersion: 1 as const,
    endpoint: automation.endpoint,
    kind: process.platform === 'win32' ? ('named-pipe' as const) : ('unix-socket' as const),
  }));
  register('automation.pairings', () => automation.listPendingPairings());
  register('automation.approvePairing', (raw) =>
    automation.approvePairing(IpcSchemas['automation.approvePairing'].input.parse(raw).pairingId)
  );
  register('automation.denyPairing', (raw) =>
    automation.denyPairing(IpcSchemas['automation.denyPairing'].input.parse(raw).pairingId)
  );
  register('automation.clients', () => database.listAutomationClients());
  register('automation.revokeClient', (raw) =>
    database.revokeAutomationClient(IpcSchemas['automation.revokeClient'].input.parse(raw).clientId)
  );

  register('threads.create', (raw) => {
    const input = IpcSchemas['threads.create'].input.parse(raw);
    return database.createThread({
      projectId: input.projectId,
      title: input.title,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
    });
  });
  register('threads.list', (raw) =>
    database.listThreads(IpcSchemas['threads.list'].input.parse(raw).projectId)
  );
  register('threads.search', (raw) => {
    const input = IpcSchemas['threads.search'].input.parse(raw);
    return database.searchThreads(input.projectId, input.query);
  });
  register('threads.get', (raw) =>
    ThreadDetailSchema.parse(
      database.getThreadDetail(IpcSchemas['threads.get'].input.parse(raw).id)
    )
  );
  register('threads.label', (raw) => {
    const input = IpcSchemas['threads.label'].input.parse(raw);
    return database.labelThread(input.id, input.label);
  });
  register('threads.continue', (raw) => {
    const id = IpcSchemas['threads.continue'].input.parse(raw).id;
    if (supervisor.hasThread(id)) throw new Error('The task runtime is still active.');
    return database.continueInterruptedThread(id);
  });
  register('threads.fork', (raw) => {
    const input = IpcSchemas['threads.fork'].input.parse(raw);
    return sessions.fork(input.checkpointId, input.title);
  });
  register('threads.archive', (raw) =>
    database.archiveThread(IpcSchemas['threads.archive'].input.parse(raw).id)
  );
  register('threads.delete', (raw) => {
    const id = IpcSchemas['threads.delete'].input.parse(raw).id;
    if (supervisor.hasThread(id)) throw new Error('A running or queued task cannot be deleted.');
    database.deleteThread(id);
    return { ok: true };
  });

  register('sessions.export', (raw) => {
    const input = IpcSchemas['sessions.export'].input.parse(raw);
    return sessions.export(input.threadId, input.includeBilling);
  });
  register('sessions.exportHtml', (raw) => {
    const input = IpcSchemas['sessions.exportHtml'].input.parse(raw);
    return sessions.exportHtml(input.threadId);
  });
  register('sessions.previewImport', (raw) => {
    const input = IpcSchemas['sessions.previewImport'].input.parse(raw);
    return sessions.previewImport(input.projectId, input.sourceName, input.content);
  });
  register('sessions.confirmImport', (raw) => {
    const input = IpcSchemas['sessions.confirmImport'].input.parse(raw);
    return sessions.confirmImport(input.previewId);
  });
  register('sessions.copyLast', (raw) => {
    const input = IpcSchemas['sessions.copyLast'].input.parse(raw);
    clipboard.writeText(sessions.lastAssistantText(input.threadId));
    return { ok: true } as const;
  });
  register('sessions.import', (raw) => {
    const input = IpcSchemas['sessions.import'].input.parse(raw);
    return sessions.import(input.projectId, input.session);
  });
  register('git.preview', (raw) =>
    gitWorkflows.preview(IpcSchemas['git.preview'].input.parse(raw))
  );
  register('git.resolve', (raw) => {
    const input = IpcSchemas['git.resolve'].input.parse(raw);
    return gitWorkflows.resolve(input.operationId, input.decision);
  });

  register('turns.start', async (raw) => {
    return tasks.start(IpcSchemas['turns.start'].input.parse(raw));
  });
  register('turns.steer', (raw) => {
    const input = IpcSchemas['turns.steer'].input.parse(raw);
    supervisor.steer(input.threadId, input.input);
    return { ok: true };
  });
  register('turns.queueFollowUp', (raw) => {
    const input = IpcSchemas['turns.queueFollowUp'].input.parse(raw);
    supervisor.queueFollowUp(input.threadId, input.input);
    return { ok: true };
  });
  register('turns.compact', async (raw) => {
    return tasks.compact(IpcSchemas['turns.compact'].input.parse(raw).threadId);
  });
  register('turns.clearQueue', (raw) => {
    supervisor.clearQueue(IpcSchemas['turns.clearQueue'].input.parse(raw).threadId);
    return { ok: true };
  });
  register('turns.stop', (raw) => {
    tasks.stop(IpcSchemas['turns.stop'].input.parse(raw).threadId);
    return { ok: true };
  });

  register('approvals.resolve', (raw) => {
    const input = IpcSchemas['approvals.resolve'].input.parse(raw);
    return ApprovalSchema.parse(tasks.resolveApproval(input.approvalId, input.decision));
  });

  register('review.getDiff', (raw) => {
    const input = IpcSchemas['review.getDiff'].input.parse(raw);
    return review.getDiff(input.threadId, input.path);
  });
  register('review.revertFile', (raw) =>
    review.revertFile(
      IpcSchemas['review.revertFile'].input.parse(raw).threadId,
      IpcSchemas['review.revertFile'].input.parse(raw).path
    )
  );
  register('review.revertAll', (raw) =>
    review.revertAll(IpcSchemas['review.revertAll'].input.parse(raw).threadId)
  );
  register('review.accept', (raw) => {
    review.accept(IpcSchemas['review.accept'].input.parse(raw).threadId);
    return { ok: true };
  });
  register('review.openFile', (raw) => {
    const input = IpcSchemas['review.openFile'].input.parse(raw);
    return review.openFile(input.threadId, input.path).then(() => ({ ok: true }));
  });

  register('events.subscribe', (raw, event) => {
    const input = IpcSchemas['events.subscribe'].input.parse(raw);
    return { subscriptionId: subscriptions.subscribe(event.sender, input.threadId) };
  });
  register('events.unsubscribe', (raw, event) => {
    const input = IpcSchemas['events.unsubscribe'].input.parse(raw);
    if (!subscriptions.unsubscribe(event.sender, input.subscriptionId)) {
      throw new Error('Subscription not found.');
    }
    return { ok: true };
  });

  register('app.getInfo', () => ({
    name: app.getName(),
    version: PUBLIC_RELEASE_VERSION,
    platform: process.platform,
    architecture: process.arch,
    sandbox: sandboxReadiness(),
  }));
  register('app.getVersion', () => ({ version: PUBLIC_RELEASE_VERSION }));
  register('app.getPlatform', () => ({ platform: process.platform }));

  return subscriptions;
};
