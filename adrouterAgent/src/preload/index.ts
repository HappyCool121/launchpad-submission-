import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import {
  type AdrouterApi,
  ApprovalResolveInputSchema,
  AutomationClientInputSchema,
  AutomationClientSchema,
  AutomationEndpointSchema,
  AutomationPairingInputSchema,
  AutomationPairingSchema,
  BundleListInputSchema,
  BundleRevokeInputSchema,
  BundleSummarySchema,
  BundleTrustInputSchema,
  EnrollmentStartInputSchema,
  EnrollmentStatusSchema,
  EventSchema,
  EventsSubscribeInputSchema,
  EventsUnsubscribeInputSchema,
  GitWorkflowPreviewInputSchema,
  GitWorkflowPreviewSchema,
  GitWorkflowResolveInputSchema,
  GitWorkflowResultSchema,
  IdSchema,
  type IpcMethod,
  IpcSchemas,
  type JournalEvent,
  ProjectIdInputSchema,
  ProjectOpenInputSchema,
  ProjectUpdateInputSchema,
  ReviewAcceptInputSchema,
  ReviewDiffInputSchema,
  ReviewOpenFileInputSchema,
  ReviewRevertAllInputSchema,
  ReviewRevertFileInputSchema,
  RouterConfigurationInputSchema,
  RouterConfigurationSchema,
  RouterDiagnosticsSchema,
  RouterPreferencesInputSchema,
  RouterTestInputSchema,
  SessionCopyLastInputSchema,
  SessionExportInputSchema,
  SessionExportV1Schema,
  SessionHtmlExportInputSchema,
  SessionHtmlExportSchema,
  SessionImportConfirmInputSchema,
  SessionImportInputSchema,
  SessionImportPreviewInputSchema,
  SessionImportPreviewSchema,
  SubscriptionSchema,
  ThreadCreateInputSchema,
  ThreadDetailSchema,
  ThreadForkInputSchema,
  ThreadIdInputSchema,
  ThreadLabelInputSchema,
  ThreadListInputSchema,
  ThreadSchema,
  ThreadSearchInputSchema,
  TurnClearQueueInputSchema,
  TurnCompactInputSchema,
  TurnMessageInputSchema,
  TurnSchema,
  TurnStartInputSchema,
  TurnStopInputSchema,
} from '../shared/contracts';

const invoke = async (method: IpcMethod, rawInput: unknown): Promise<unknown> => {
  const schemas = IpcSchemas[method];
  const input = schemas.input.parse(rawInput);
  const response = await ipcRenderer.invoke(`adrouter:${method}`, input);
  return schemas.output.parse(response);
};

const eventListeners = new Map<string, (event: JournalEvent) => void>();
const SubscribedEventSchema = z.object({ subscriptionId: IdSchema, event: EventSchema });
ipcRenderer.on('adrouter:event', (_event, raw) => {
  const parsed = SubscribedEventSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  eventListeners.get(parsed.data.subscriptionId)?.(parsed.data.event);
});

const api: AdrouterApi = {
  configuration: {
    get: async () => RouterConfigurationSchema.parse(await invoke('configuration.get', {})),
    save: async (input) =>
      RouterConfigurationSchema.parse(
        await invoke('configuration.save', RouterConfigurationInputSchema.parse(input))
      ),
    testRouter: async (input) =>
      RouterDiagnosticsSchema.parse(
        await invoke('configuration.testRouter', RouterTestInputSchema.parse(input))
      ),
    status: async () => RouterDiagnosticsSchema.parse(await invoke('configuration.status', {})),
    signOut: async () =>
      IpcSchemas['configuration.signOut'].output.parse(await invoke('configuration.signOut', {})),
    startEnrollment: async (input) =>
      EnrollmentStatusSchema.parse(
        await invoke('configuration.startEnrollment', EnrollmentStartInputSchema.parse(input))
      ),
    continueEnrollment: async () =>
      EnrollmentStatusSchema.parse(await invoke('configuration.continueEnrollment', {})),
    enrollmentStatus: async () =>
      EnrollmentStatusSchema.parse(await invoke('configuration.enrollmentStatus', {})),
    cancelEnrollment: async () =>
      EnrollmentStatusSchema.parse(await invoke('configuration.cancelEnrollment', {})),
    openEnrollment: async () =>
      IpcSchemas['configuration.openEnrollment'].output.parse(
        await invoke('configuration.openEnrollment', {})
      ),
    copyEnrollmentLink: async () =>
      IpcSchemas['configuration.copyEnrollmentLink'].output.parse(
        await invoke('configuration.copyEnrollmentLink', {})
      ),
    updatePreferences: async (input) =>
      RouterConfigurationSchema.parse(
        await invoke('configuration.updatePreferences', RouterPreferencesInputSchema.parse(input))
      ),
  },
  projects: {
    open: async (input = {}) =>
      IpcSchemas['projects.open'].output.parse(
        await invoke('projects.open', ProjectOpenInputSchema.parse(input))
      ),
    list: async () => IpcSchemas['projects.list'].output.parse(await invoke('projects.list', {})),
    get: async (input) =>
      IpcSchemas['projects.get'].output.parse(
        await invoke('projects.get', ProjectIdInputSchema.parse(input))
      ),
    update: async (input) =>
      IpcSchemas['projects.update'].output.parse(
        await invoke('projects.update', ProjectUpdateInputSchema.parse(input))
      ),
    remove: async (input) =>
      IpcSchemas['projects.remove'].output.parse(
        await invoke('projects.remove', ProjectIdInputSchema.parse(input))
      ),
  },
  bundles: {
    list: async (input) =>
      z
        .array(BundleSummarySchema)
        .parse(await invoke('bundles.list', BundleListInputSchema.parse(input))),
    trust: async (input) =>
      BundleSummarySchema.parse(await invoke('bundles.trust', BundleTrustInputSchema.parse(input))),
    revoke: async (input) =>
      BundleSummarySchema.parse(
        await invoke('bundles.revoke', BundleRevokeInputSchema.parse(input))
      ),
  },
  automation: {
    endpoint: async () => AutomationEndpointSchema.parse(await invoke('automation.endpoint', {})),
    pairings: async () =>
      z.array(AutomationPairingSchema).parse(await invoke('automation.pairings', {})),
    approvePairing: async (input) =>
      AutomationPairingSchema.parse(
        await invoke('automation.approvePairing', AutomationPairingInputSchema.parse(input))
      ),
    denyPairing: async (input) =>
      AutomationPairingSchema.parse(
        await invoke('automation.denyPairing', AutomationPairingInputSchema.parse(input))
      ),
    clients: async () =>
      z.array(AutomationClientSchema).parse(await invoke('automation.clients', {})),
    revokeClient: async (input) =>
      AutomationClientSchema.parse(
        await invoke('automation.revokeClient', AutomationClientInputSchema.parse(input))
      ),
  },
  threads: {
    create: async (input) =>
      IpcSchemas['threads.create'].output.parse(
        await invoke('threads.create', ThreadCreateInputSchema.parse(input))
      ),
    list: async (input) =>
      IpcSchemas['threads.list'].output.parse(
        await invoke('threads.list', ThreadListInputSchema.parse(input))
      ),
    search: async (input) =>
      IpcSchemas['threads.search'].output.parse(
        await invoke('threads.search', ThreadSearchInputSchema.parse(input))
      ),
    get: async (input) =>
      ThreadDetailSchema.parse(await invoke('threads.get', ThreadIdInputSchema.parse(input))),
    label: async (input) =>
      ThreadSchema.parse(await invoke('threads.label', ThreadLabelInputSchema.parse(input))),
    continue: async (input) =>
      ThreadSchema.parse(await invoke('threads.continue', ThreadIdInputSchema.parse(input))),
    fork: async (input) =>
      ThreadSchema.parse(await invoke('threads.fork', ThreadForkInputSchema.parse(input))),
    archive: async (input) =>
      ThreadSchema.parse(await invoke('threads.archive', ThreadIdInputSchema.parse(input))),
    delete: async (input) =>
      IpcSchemas['threads.delete'].output.parse(
        await invoke('threads.delete', ThreadIdInputSchema.parse(input))
      ),
  },
  sessions: {
    export: async (input) =>
      SessionExportV1Schema.parse(
        await invoke('sessions.export', SessionExportInputSchema.parse(input))
      ),
    exportHtml: async (input) =>
      SessionHtmlExportSchema.parse(
        await invoke('sessions.exportHtml', SessionHtmlExportInputSchema.parse(input))
      ),
    previewImport: async (input) =>
      SessionImportPreviewSchema.parse(
        await invoke('sessions.previewImport', SessionImportPreviewInputSchema.parse(input))
      ),
    confirmImport: async (input) =>
      ThreadSchema.parse(
        await invoke('sessions.confirmImport', SessionImportConfirmInputSchema.parse(input))
      ),
    copyLast: async (input) =>
      IpcSchemas['sessions.copyLast'].output.parse(
        await invoke('sessions.copyLast', SessionCopyLastInputSchema.parse(input))
      ),
    import: async (input) =>
      ThreadSchema.parse(await invoke('sessions.import', SessionImportInputSchema.parse(input))),
  },
  git: {
    preview: async (input) =>
      GitWorkflowPreviewSchema.parse(
        await invoke('git.preview', GitWorkflowPreviewInputSchema.parse(input))
      ),
    resolve: async (input) =>
      GitWorkflowResultSchema.parse(
        await invoke('git.resolve', GitWorkflowResolveInputSchema.parse(input))
      ),
  },
  turns: {
    start: async (input) =>
      TurnSchema.parse(await invoke('turns.start', TurnStartInputSchema.parse(input))),
    steer: async (input) =>
      IpcSchemas['turns.steer'].output.parse(
        await invoke('turns.steer', TurnMessageInputSchema.parse(input))
      ),
    queueFollowUp: async (input) =>
      IpcSchemas['turns.queueFollowUp'].output.parse(
        await invoke('turns.queueFollowUp', TurnMessageInputSchema.parse(input))
      ),
    compact: async (input) =>
      TurnSchema.parse(await invoke('turns.compact', TurnCompactInputSchema.parse(input))),
    clearQueue: async (input) =>
      IpcSchemas['turns.clearQueue'].output.parse(
        await invoke('turns.clearQueue', TurnClearQueueInputSchema.parse(input))
      ),
    stop: async (input) =>
      IpcSchemas['turns.stop'].output.parse(
        await invoke('turns.stop', TurnStopInputSchema.parse(input))
      ),
  },
  approvals: {
    resolve: async (input) =>
      IpcSchemas['approvals.resolve'].output.parse(
        await invoke('approvals.resolve', ApprovalResolveInputSchema.parse(input))
      ),
  },
  review: {
    getDiff: async (input) =>
      IpcSchemas['review.getDiff'].output.parse(
        await invoke('review.getDiff', ReviewDiffInputSchema.parse(input))
      ),
    revertFile: async (input) =>
      IpcSchemas['review.revertFile'].output.parse(
        await invoke('review.revertFile', ReviewRevertFileInputSchema.parse(input))
      ),
    revertAll: async (input) =>
      IpcSchemas['review.revertAll'].output.parse(
        await invoke('review.revertAll', ReviewRevertAllInputSchema.parse(input))
      ),
    accept: async (input) =>
      IpcSchemas['review.accept'].output.parse(
        await invoke('review.accept', ReviewAcceptInputSchema.parse(input))
      ),
    openFile: async (input) =>
      IpcSchemas['review.openFile'].output.parse(
        await invoke('review.openFile', ReviewOpenFileInputSchema.parse(input))
      ),
  },
  events: {
    subscribe: async (input, listener) => {
      const output = SubscriptionSchema.parse(
        await invoke('events.subscribe', EventsSubscribeInputSchema.parse(input))
      );
      eventListeners.set(output.subscriptionId, listener);
      return output.subscriptionId;
    },
    unsubscribe: async (input) => {
      const parsedInput = EventsUnsubscribeInputSchema.parse(input);
      const response = IpcSchemas['events.unsubscribe'].output.parse(
        await invoke('events.unsubscribe', parsedInput)
      );
      eventListeners.delete(parsedInput.subscriptionId);
      return response;
    },
  },
  app: {
    getInfo: async () => IpcSchemas['app.getInfo'].output.parse(await invoke('app.getInfo', {})),
    getVersion: async () =>
      IpcSchemas['app.getVersion'].output.parse(await invoke('app.getVersion', {})),
    getPlatform: async () =>
      IpcSchemas['app.getPlatform'].output.parse(await invoke('app.getPlatform', {})),
  },
};

contextBridge.exposeInMainWorld('adrouter', api);
