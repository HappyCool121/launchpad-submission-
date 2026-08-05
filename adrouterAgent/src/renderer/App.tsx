import {
  ArrowRight,
  FolderOpen,
  History,
  LogOut,
  MessageSquarePlus,
  Moon,
  PanelRight,
  Send,
  Settings,
  Square,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import type { CSSProperties, JSX, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import jellyfishLogo from '../../assets/icon.svg?url';
import { classifyRouterOrigin, DEFAULT_ADROUTER_SERVER_URL } from '../shared/constants';
import type {
  ApplicationInfo,
  Approval,
  AutomationClient,
  AutomationPairing,
  BundleSummary,
  DiffFile,
  EnrollmentStatus,
  GitWorkflowPreview,
  JournalEvent,
  Project,
  RouterConfiguration,
  RouterDiagnostics,
  RouterModelDescriptor,
  SessionImportPreview,
  Sponsor,
  ThinkingLevel,
  Thread,
} from '../shared/contracts';
import { RouterModelDescriptorSchema } from '../shared/contracts';
import { buildChangedLineDiff } from './line-diff';
import { readStoredTheme, type Theme, transitionToTheme } from './theme';
import { buildTimeline, type SponsorRound, type TimelineItem } from './timeline';

type Detail = Awaited<ReturnType<Window['adrouter']['threads']['get']>>;
type Drawer = 'history' | 'changes' | 'settings' | null;

const isTerminal = (status: Thread['status']): boolean =>
  status === 'idle' || status === 'failed' || status === 'interrupted' || status === 'blocked';

const threadDepth = (thread: Thread, threads: Thread[]): number => {
  const byId = new Map(threads.map((candidate) => [candidate.id, candidate]));
  let depth = 0;
  let parentId = thread.parentThreadId;
  const seen = new Set<string>();
  while (parentId && depth < 8 && !seen.has(parentId)) {
    seen.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentThreadId ?? null;
  }
  return depth;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong.';

const asSponsor = (event?: JournalEvent): Sponsor | undefined => {
  if (event?.type !== 'sponsor.update') {
    return undefined;
  }
  const payload = event.payload;
  if (
    (payload.tier === 'A' ||
      payload.tier === 'B' ||
      payload.tier === 'C' ||
      payload.tier === 'NONE') &&
    typeof payload.subsidyPercent === 'number'
  ) {
    return payload as Sponsor;
  }
  return undefined;
};

const latestBottomSponsor = (
  events: readonly JournalEvent[]
): { eventId: string; sponsor: Sponsor } | undefined => {
  let current:
    | { eventId: string; turnId: string | null; sponsor: Sponsor; streamingComplete: boolean }
    | undefined;
  for (const event of events) {
    if (event.type === 'message.user') current = undefined;
    if (event.type === 'sponsor.update') {
      const sponsor = asSponsor(event);
      current =
        sponsor?.tier === 'B' || sponsor?.tier === 'C'
          ? { eventId: event.id, turnId: event.turnId, sponsor, streamingComplete: false }
          : undefined;
    }
    if (event.type === 'message.complete' && current?.turnId === event.turnId) {
      current.streamingComplete = true;
    }
  }
  return current?.streamingComplete
    ? { eventId: current.eventId, sponsor: current.sponsor }
    : undefined;
};

const formatCurrency = (amount: number): string =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  }).format(amount);

const normalizeModels = (value: unknown): RouterModelDescriptor[] => {
  const parsed = RouterModelDescriptorSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
};

export function App(): JSX.Element {
  const [configured, setConfigured] = useState<boolean | undefined>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [bundles, setBundles] = useState<BundleSummary[]>([]);
  const [automationPairings, setAutomationPairings] = useState<AutomationPairing[]>([]);
  const [automationClients, setAutomationClients] = useState<AutomationClient[]>([]);
  const [automationEndpoint, setAutomationEndpoint] = useState<string>();
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [detail, setDetail] = useState<Detail>();
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [renderedDrawer, setRenderedDrawer] = useState<Exclude<Drawer, null>>();
  const [drawerExpanded, setDrawerExpanded] = useState(false);
  const [diffs, setDiffs] = useState<DiffFile[]>([]);
  const [selectedDiffPath, setSelectedDiffPath] = useState<string>();
  const [composer, setComposer] = useState('');
  const [model, setModel] = useState('auto');
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('medium');
  const [models, setModels] = useState<RouterModelDescriptor[]>([]);
  const [routerStatus, setRouterStatus] = useState<RouterDiagnostics>();
  const [serverUrl, setServerUrl] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);
  const [deletingThread, setDeletingThread] = useState<Thread>();
  const [historyQuery, setHistoryQuery] = useState('');
  const [labelDraft, setLabelDraft] = useState('');
  const [selectedCheckpointId, setSelectedCheckpointId] = useState('');
  const [sessionImportPreview, setSessionImportPreview] = useState<SessionImportPreview>();
  const [runningMessageMode, setRunningMessageMode] = useState<'steer' | 'follow-up'>('follow-up');
  const [gitCapability, setGitCapability] = useState<
    'git.branch.create' | 'git.switch' | 'git.stage' | 'git.stage.hunk' | 'git.commit' | 'git.push'
  >('git.stage');
  const [gitPrimary, setGitPrimary] = useState('');
  const [gitSecondary, setGitSecondary] = useState('');
  const [gitPreview, setGitPreview] = useState<GitWorkflowPreview>();
  const [gitBusy, setGitBusy] = useState(false);
  const [dismissedBottomSponsors, setDismissedBottomSponsors] = useState<Set<string>>(
    () => new Set()
  );
  const [instructionDraft, setInstructionDraft] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [applicationInfo, setApplicationInfo] = useState<ApplicationInfo>();
  const [onboardingDefaults, setOnboardingDefaults] = useState<
    Pick<RouterConfiguration, 'serverUrl' | 'sponsoredCompute'>
  >({ serverUrl: DEFAULT_ADROUTER_SERVER_URL, sponsoredCompute: true });
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutNotice, setSignOutNotice] = useState<string>();
  const [composerClearance, setComposerClearance] = useState(190);
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerStackRef = useRef<HTMLDivElement>(null);
  const sessionImportRef = useRef<HTMLInputElement>(null);
  const followTimeline = useRef(true);

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selectedThread = selectedThreadId
    ? (threads.find((thread) => thread.id === selectedThreadId) ??
      (detail?.thread.id === selectedThreadId ? detail.thread : undefined))
    : undefined;
  const isRunning = selectedThread ? !isTerminal(selectedThread.status) : false;
  const needsContinue =
    selectedThread?.status === 'interrupted' || selectedThread?.status === 'blocked';
  const hasActiveTask = isRunning || threads.some((thread) => !isTerminal(thread.status));
  const runningTurnId = isRunning ? detail?.turns.at(-1)?.id : undefined;
  const timeline = useMemo(
    () => buildTimeline(detail?.events ?? [], runningTurnId),
    [detail?.events, runningTurnId]
  );
  const lastEventId = detail?.events.at(-1)?.id;
  const sponsor = useMemo(
    () =>
      asSponsor(
        [...(detail?.events ?? [])].reverse().find((event) => event.type === 'sponsor.update')
      ),
    [detail?.events]
  );
  const pendingApproval = detail?.approvals.find((approval) => approval.decision === null);
  const selectedDiff = diffs.find((diff) => diff.path === selectedDiffPath) ?? diffs[0];
  const bottomSponsor = useMemo(() => latestBottomSponsor(detail?.events ?? []), [detail?.events]);
  const visibleBottomSponsor =
    bottomSponsor && !dismissedBottomSponsors.has(bottomSponsor.eventId)
      ? bottomSponsor
      : undefined;
  const selectableModels = useMemo(() => {
    if (routerStatus?.catalog?.compatibility === 'incompatible') return [];
    if (routerStatus?.mode === 'live' && routerStatus.health && routerStatus.authenticated) {
      return models.filter((candidate) => candidate.configured);
    }
    return models;
  }, [models, routerStatus]);
  const selectedModel = selectableModels.find((candidate) => candidate.id === model);

  const refreshRouterStatus = useCallback(async (): Promise<void> => {
    if (typeof window.adrouter.configuration.status !== 'function') return;
    setStatusBusy(true);
    try {
      const status = await window.adrouter.configuration.status();
      if (!status) return;
      setRouterStatus(status);
      if (status.models.length > 0) setModels(normalizeModels(status.models));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setStatusBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!configured) return undefined;
    const stack = composerStackRef.current;
    if (!stack || typeof ResizeObserver === 'undefined') return undefined;
    const updateClearance = (): void => {
      setComposerClearance(Math.ceil(stack.getBoundingClientRect().height) + 24);
    };
    updateClearance();
    const observer = new ResizeObserver(updateClearance);
    observer.observe(stack);
    return () => observer.disconnect();
  }, [configured]);

  useEffect(() => {
    const element = timelineRef.current;
    if (composerClearance > 0 && lastEventId && element && followTimeline.current) {
      requestAnimationFrame(() => {
        if (followTimeline.current) element.scrollTop = element.scrollHeight;
      });
    }
  }, [composerClearance, lastEventId]);

  useEffect(() => {
    if (!selectedThreadId) return;
    followTimeline.current = true;
    requestAnimationFrame(() => {
      const element = timelineRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }, [selectedThreadId]);

  useEffect(() => {
    setInstructionDraft(selectedProject?.instructions ?? '');
  }, [selectedProject?.instructions]);

  useEffect(() => {
    setLabelDraft(selectedThread?.label ?? '');
  }, [selectedThread?.label]);

  useEffect(() => {
    setSelectedCheckpointId(detail?.checkpoints?.at(-1)?.id ?? '');
  }, [detail?.checkpoints]);

  useEffect(() => {
    setGitPreview(undefined);
    if (gitCapability === 'git.push') {
      setGitPrimary('origin');
      setGitSecondary(
        selectedProject?.git?.branch ? `refs/heads/${selectedProject.git.branch}` : ''
      );
    } else if (gitCapability === 'git.stage') {
      setGitPrimary(diffs.map((diff) => diff.path).join('\n'));
      setGitSecondary('');
    } else if (gitCapability === 'git.stage.hunk') {
      setGitPrimary(selectedDiff?.path ?? '');
      setGitSecondary('1');
    } else {
      setGitPrimary('');
      setGitSecondary('');
    }
  }, [diffs, gitCapability, selectedDiff?.path, selectedProject?.git?.branch]);

  const refreshProjects = useCallback(async (): Promise<void> => {
    const next = await window.adrouter.projects.list();
    setProjects(next);
    setSelectedProjectId((current) => current ?? next[0]?.id);
  }, []);

  const refreshBundles = useCallback(async (projectId?: string): Promise<void> => {
    if (!projectId) {
      setBundles([]);
      return;
    }
    setBundles(await window.adrouter.bundles.list({ projectId }));
  }, []);

  const refreshAutomation = useCallback(async (): Promise<void> => {
    const [pairings, clients, endpoint] = await Promise.all([
      window.adrouter.automation.pairings(),
      window.adrouter.automation.clients(),
      window.adrouter.automation.endpoint(),
    ]);
    setAutomationPairings(pairings);
    setAutomationClients(clients);
    setAutomationEndpoint(endpoint.endpoint);
  }, []);

  const refreshThreads = useCallback(async (projectId?: string, query = ''): Promise<void> => {
    if (!projectId) {
      setThreads([]);
      return;
    }
    const next = query.trim()
      ? await window.adrouter.threads.search({ projectId, query: query.trim() })
      : await window.adrouter.threads.list({ projectId });
    setThreads(next);
    setSelectedThreadId((current) =>
      current && next.some((thread) => thread.id === current) ? current : next[0]?.id
    );
  }, []);

  useEffect(() => {
    if (!selectedProjectId) return undefined;
    const timeout = window.setTimeout(
      () => void refreshThreads(selectedProjectId, historyQuery),
      180
    );
    return () => window.clearTimeout(timeout);
  }, [historyQuery, refreshThreads, selectedProjectId]);

  const refreshDetail = useCallback(async (threadId?: string): Promise<void> => {
    if (!threadId) {
      setDetail(undefined);
      return;
    }
    const next = await window.adrouter.threads.get({ id: threadId });
    setDetail(next);
  }, []);

  const refreshDiffs = useCallback(async (threadId?: string): Promise<void> => {
    if (!threadId) {
      setDiffs([]);
      return;
    }
    const next = await window.adrouter.review.getDiff({ threadId });
    setDiffs(next);
    setSelectedDiffPath((current) => current ?? next[0]?.path);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        if (typeof window.adrouter.app.getInfo === 'function') {
          const info = await window.adrouter.app.getInfo();
          if (info) setApplicationInfo(info);
        }
        const configuration = await window.adrouter.configuration.get();
        setOnboardingDefaults({
          serverUrl: configuration.serverUrl,
          sponsoredCompute: configuration.sponsoredCompute,
        });
        if (configuration.authentication?.mode === 'legacy_hosted') {
          setSignOutNotice(
            'Copied hosted API keys are no longer used. Connect this Agent and approve the installation in the AdRouter WebUI.'
          );
        }
        setConfigured(configuration.configured);
        setServerUrl(configuration.serverUrl);
        const configuredModels = normalizeModels(configuration.models);
        setModels(configuredModels);
        setModel(configuration.selectedModel ?? configuredModels[0]?.id ?? 'auto');
        setThinkingLevel(configuration.selectedThinkingLevel ?? 'medium');
        if (configuration.configured) void refreshRouterStatus();
        await refreshProjects();
      } catch (caught) {
        setError(errorMessage(caught));
        setConfigured(false);
      }
    })();
  }, [refreshProjects, refreshRouterStatus]);

  useEffect(() => {
    if (drawer !== 'settings' || !configured) return undefined;
    void refreshRouterStatus();
    const interval = window.setInterval(() => void refreshRouterStatus(), 15_000);
    return () => window.clearInterval(interval);
  }, [configured, drawer, refreshRouterStatus]);

  useEffect(() => {
    if (drawer !== 'settings' || !configured) return undefined;
    void refreshAutomation().catch((caught) => setError(errorMessage(caught)));
    const interval = window.setInterval(
      () => void refreshAutomation().catch((caught) => setError(errorMessage(caught))),
      2_000
    );
    return () => window.clearInterval(interval);
  }, [configured, drawer, refreshAutomation]);

  useEffect(() => {
    if (!drawer) {
      setDrawerExpanded(false);
      return undefined;
    }
    setDrawerExpanded(false);
    setRenderedDrawer(drawer);
    let openFrame = 0;
    const mountFrame = requestAnimationFrame(() => {
      openFrame = requestAnimationFrame(() => setDrawerExpanded(true));
    });
    return () => {
      cancelAnimationFrame(mountFrame);
      cancelAnimationFrame(openFrame);
    };
  }, [drawer]);

  useEffect(() => {
    if (selectableModels.length === 0) return;
    const current = selectableModels.find((candidate) => candidate.id === model);
    if (!current) {
      const fallback = selectableModels[0];
      if (!fallback) return;
      setModel(fallback.id);
      setThinkingLevel(fallback.defaultThinkingLevel);
      void Promise.resolve(
        window.adrouter.configuration.updatePreferences({
          model: fallback.id,
          thinkingLevel: fallback.defaultThinkingLevel,
        })
      ).catch((caught) => setError(errorMessage(caught)));
      return;
    }
    if (!current.thinkingLevels.includes(thinkingLevel)) {
      setThinkingLevel(current.defaultThinkingLevel);
      void Promise.resolve(
        window.adrouter.configuration.updatePreferences({
          model: current.id,
          thinkingLevel: current.defaultThinkingLevel,
        })
      ).catch((caught) => setError(errorMessage(caught)));
    }
  }, [model, selectableModels, thinkingLevel]);

  useEffect(() => {
    setSelectedThreadId(undefined);
    setDetail(undefined);
    setThreads([]);
    setDiffs([]);
    setSelectedDiffPath(undefined);
    void refreshThreads(selectedProjectId);
    void refreshBundles(selectedProjectId);
  }, [selectedProjectId, refreshBundles, refreshThreads]);

  useEffect(() => {
    void refreshDetail(selectedThreadId);
    void refreshDiffs(selectedThreadId);
    if (!selectedThreadId) {
      return undefined;
    }
    let subscriptionId: string | undefined;
    let live = true;
    void window.adrouter.events
      .subscribe({ threadId: selectedThreadId }, (event) => {
        if (!live) {
          return;
        }
        setDetail((current) => {
          if (!current || current.thread.id !== selectedThreadId) {
            return current;
          }
          const events = [...current.events, event].sort(
            (left, right) => left.sequence - right.sequence
          );
          return { ...current, events };
        });
        if (
          event.type === 'file.change' ||
          event.type === 'diff.change' ||
          event.type === 'turn.lifecycle'
        ) {
          void refreshDiffs(selectedThreadId);
          void refreshThreads(selectedProjectId);
        }
        if (event.type === 'approval.request' || event.type === 'approval.resolved') {
          void refreshDetail(selectedThreadId);
        }
      })
      .then((id) => {
        if (!live) {
          void window.adrouter.events.unsubscribe({ subscriptionId: id });
        } else {
          subscriptionId = id;
        }
      })
      .catch((caught) => setError(errorMessage(caught)));
    return () => {
      live = false;
      if (subscriptionId) {
        void window.adrouter.events.unsubscribe({ subscriptionId });
      }
    };
  }, [selectedThreadId, selectedProjectId, refreshDetail, refreshDiffs, refreshThreads]);

  if (configured === undefined) {
    return <main className="loading-shell">Loading AdRouter Agent…</main>;
  }
  if (!configured) {
    return (
      <>
        <Onboarding
          initialServerUrl={onboardingDefaults.serverUrl}
          initialSponsoredCompute={onboardingDefaults.sponsoredCompute}
          notice={signOutNotice}
          onConfigured={async () => {
            setConfigured(true);
            const configuration = await window.adrouter.configuration.get();
            setServerUrl(configuration.serverUrl);
            const configuredModels = normalizeModels(configuration.models);
            setModels(configuredModels);
            setModel(configuration.selectedModel ?? configuredModels[0]?.id ?? 'auto');
            setThinkingLevel(configuration.selectedThinkingLevel ?? 'medium');
            void refreshRouterStatus();
            await refreshProjects();
          }}
          onModels={(nextModels) => {
            setModels(nextModels);
            const first = nextModels[0];
            if (first) {
              setModel(first.id);
              setThinkingLevel(first.defaultThinkingLevel);
            }
          }}
        />
        <ThemeToggle />
      </>
    );
  }

  const openProject = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const project = await window.adrouter.projects.open({});
      await refreshProjects();
      setSelectedProjectId(project.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const saveInstructions = async (): Promise<void> => {
    if (!selectedProject) {
      return;
    }
    try {
      const updated = await window.adrouter.projects.update({
        id: selectedProject.id,
        instructions: instructionDraft,
      });
      setProjects((current) =>
        current.map((project) => (project.id === updated.id ? updated : project))
      );
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const setBundleTrust = async (bundle: BundleSummary, trusted: boolean): Promise<void> => {
    if (!selectedProject) return;
    try {
      if (trusted) {
        await window.adrouter.bundles.trust({
          projectId: selectedProject.id,
          bundleId: bundle.id,
          version: bundle.version,
          digest: bundle.aggregateDigest,
        });
      } else {
        await window.adrouter.bundles.revoke({
          projectId: selectedProject.id,
          bundleId: bundle.id,
        });
      }
      await refreshBundles(selectedProject.id);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const setDelegationEnabled = async (enabled: boolean): Promise<void> => {
    if (!selectedProject) return;
    try {
      const updated = await window.adrouter.projects.update({
        id: selectedProject.id,
        delegationEnabled: enabled,
      });
      setProjects((current) =>
        current.map((project) => (project.id === updated.id ? updated : project))
      );
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const decidePairing = async (pairingId: string, approve: boolean): Promise<void> => {
    try {
      if (approve) await window.adrouter.automation.approvePairing({ pairingId });
      else await window.adrouter.automation.denyPairing({ pairingId });
      await refreshAutomation();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const revokeAutomationClient = async (clientId: string): Promise<void> => {
    try {
      await window.adrouter.automation.revokeClient({ clientId });
      await refreshAutomation();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const continueThread = async (): Promise<void> => {
    if (!selectedThreadId || !selectedProjectId) return;
    try {
      await window.adrouter.threads.continue({ id: selectedThreadId });
      await Promise.all([
        refreshThreads(selectedProjectId, historyQuery),
        refreshDetail(selectedThreadId),
      ]);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const saveThreadLabel = async (): Promise<void> => {
    if (!selectedThreadId || !selectedProjectId) return;
    try {
      await window.adrouter.threads.label({
        id: selectedThreadId,
        label: labelDraft.trim() || null,
      });
      await refreshThreads(selectedProjectId, historyQuery);
      await refreshDetail(selectedThreadId);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const forkCheckpoint = async (): Promise<void> => {
    if (!selectedCheckpointId || !selectedProjectId) return;
    try {
      const fork = await window.adrouter.threads.fork({ checkpointId: selectedCheckpointId });
      await refreshThreads(selectedProjectId, historyQuery);
      setSelectedThreadId(fork.id);
      setDrawer(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const downloadText = (contents: string, type: string, filename: string): void => {
    const blob = new Blob([contents], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportSession = async (format: 'json' | 'html' = 'json'): Promise<void> => {
    if (!selectedThreadId || !selectedThread) return;
    try {
      if (format === 'html') {
        const exported = await window.adrouter.sessions.exportHtml({ threadId: selectedThreadId });
        downloadText(exported.html, 'text/html', exported.filename);
        return;
      }
      const session = await window.adrouter.sessions.export({
        threadId: selectedThreadId,
        includeBilling: false,
      });
      downloadText(
        `${JSON.stringify(session, null, 2)}\n`,
        'application/json',
        `${
          selectedThread.title
            .replace(/[^a-z0-9]+/gi, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 80) || 'adrouter-session'
        }.json`
      );
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const importSession = async (file?: File): Promise<void> => {
    if (!file || !selectedProjectId) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Session imports are limited to 10 MiB.');
      const preview = await window.adrouter.sessions.previewImport({
        projectId: selectedProjectId,
        sourceName: file.name,
        content: await file.text(),
      });
      setSessionImportPreview(preview);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      if (sessionImportRef.current) sessionImportRef.current.value = '';
    }
  };

  const confirmSessionImport = async (): Promise<void> => {
    if (!sessionImportPreview || !selectedProjectId) return;
    try {
      const imported = await window.adrouter.sessions.confirmImport({
        previewId: sessionImportPreview.previewId,
      });
      setSessionImportPreview(undefined);
      setHistoryQuery('');
      await refreshThreads(selectedProjectId);
      setSelectedThreadId(imported.id);
      setDrawer(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const copyLastAssistantResponse = async (): Promise<void> => {
    if (!selectedThreadId) return;
    try {
      await window.adrouter.sessions.copyLast({ threadId: selectedThreadId });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const compactContext = async (): Promise<void> => {
    if (!selectedThreadId) return;
    setBusy(true);
    setError(undefined);
    try {
      await window.adrouter.turns.compact({ threadId: selectedThreadId });
      await refreshDetail(selectedThreadId);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const clearQueuedFollowUps = async (): Promise<void> => {
    if (!selectedThreadId) return;
    try {
      await window.adrouter.turns.clearQueue({ threadId: selectedThreadId });
      await refreshDetail(selectedThreadId);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const previewGitOperation = async (): Promise<void> => {
    if (!selectedThreadId) return;
    setGitBusy(true);
    setError(undefined);
    try {
      const common = { threadId: selectedThreadId, capability: gitCapability };
      const input =
        gitCapability === 'git.branch.create' || gitCapability === 'git.switch'
          ? { ...common, branch: gitPrimary.trim() }
          : gitCapability === 'git.stage'
            ? {
                ...common,
                paths: [
                  ...new Set(
                    gitPrimary
                      .split(/[\n,]/)
                      .map((path) => path.trim())
                      .filter(Boolean)
                  ),
                ],
              }
            : gitCapability === 'git.stage.hunk'
              ? {
                  ...common,
                  path: gitPrimary.trim(),
                  hunks: [
                    ...new Set(
                      gitSecondary
                        .split(/[\s,]+/)
                        .filter(Boolean)
                        .map((value) => Number(value))
                    ),
                  ],
                }
              : gitCapability === 'git.commit'
                ? { ...common, message: gitPrimary.trim() }
                : {
                    ...common,
                    remote: gitPrimary.trim(),
                    remoteRef: gitSecondary.trim(),
                  };
      setGitPreview(await window.adrouter.git.preview(input));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setGitBusy(false);
    }
  };

  const resolveGitOperation = async (decision: 'allow-once' | 'deny'): Promise<void> => {
    if (!gitPreview || !selectedThreadId) return;
    setGitBusy(true);
    setError(undefined);
    try {
      await window.adrouter.git.resolve({
        operationId: gitPreview.manifest.operationId,
        decision,
      });
      setGitPreview(undefined);
      await Promise.all([
        refreshDetail(selectedThreadId),
        refreshDiffs(selectedThreadId),
        refreshThreads(selectedProjectId, historyQuery),
      ]);
    } catch (caught) {
      setGitPreview(undefined);
      setError(errorMessage(caught));
    } finally {
      setGitBusy(false);
    }
  };

  const send = async (): Promise<void> => {
    if (!composer.trim() || !selectedProject || !selectedModel) {
      return;
    }
    const text = composer.trim();
    if (bottomSponsor) {
      setDismissedBottomSponsors((current) => new Set(current).add(bottomSponsor.eventId));
    }
    setBusy(true);
    setError(undefined);
    try {
      let threadId = selectedThreadId;
      if (isRunning && threadId) {
        if (runningMessageMode === 'steer') {
          await window.adrouter.turns.steer({ threadId, input: text });
        } else {
          await window.adrouter.turns.queueFollowUp({ threadId, input: text });
        }
        setComposer('');
        await refreshDetail(threadId);
        return;
      }
      if (!threadId) {
        const thread = await window.adrouter.threads.create({
          projectId: selectedProject.id,
          title: text.slice(0, 80),
          model,
          thinkingLevel,
        });
        threadId = thread.id;
        await refreshThreads(selectedProject.id);
        setSelectedThreadId(threadId);
      }
      await window.adrouter.turns.start({
        threadId,
        input: text,
        model,
        thinkingLevel,
        runtimeMode: 'auto',
      });
      await refreshDetail(threadId);
      setComposer('');
      await refreshThreads(selectedProject.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const updateModelPreferences = async (
    nextModel: string,
    nextThinkingLevel: ThinkingLevel
  ): Promise<void> => {
    setModel(nextModel);
    setThinkingLevel(nextThinkingLevel);
    try {
      await window.adrouter.configuration.updatePreferences({
        model: nextModel,
        thinkingLevel: nextThinkingLevel,
      });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const deleteThread = async (): Promise<void> => {
    if (!deletingThread) return;
    try {
      await window.adrouter.threads.delete({ id: deletingThread.id });
      if (selectedThreadId === deletingThread.id) {
        setSelectedThreadId(undefined);
        setDetail(undefined);
        setDiffs([]);
      }
      setDeletingThread(undefined);
      if (selectedProjectId) {
        const next = await window.adrouter.threads.list({ projectId: selectedProjectId });
        setThreads(next);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const resolveApproval = async (
    approval: Approval,
    decision: 'allow-once' | 'deny'
  ): Promise<void> => {
    try {
      await window.adrouter.approvals.resolve({ approvalId: approval.id, decision });
      await refreshDetail(selectedThreadId);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <main
      className="app-shell"
      style={{ '--composer-clearance': `${composerClearance}px` } as CSSProperties}
    >
      <header className="top-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <img src={jellyfishLogo} alt="" />
          </span>
          <span>AdRouter Agent</span>
        </div>
        <nav aria-label="Workspace controls">
          <button
            className="secondary-button"
            type="button"
            onClick={() => void openProject()}
            disabled={busy}
          >
            <FolderOpen size={16} aria-hidden="true" />
            Choose folder
          </button>
          <select
            aria-label="Current project"
            value={selectedProjectId ?? ''}
            onChange={(event) => setSelectedProjectId(event.target.value || undefined)}
          >
            <option value="">No project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.displayName}
              </option>
            ))}
          </select>
          <button
            className="secondary-button"
            type="button"
            disabled={!selectedProject}
            onClick={() => {
              setSelectedThreadId(undefined);
              setDetail(undefined);
              setDiffs([]);
              setSelectedDiffPath(undefined);
              setDrawer(null);
            }}
          >
            <MessageSquarePlus size={16} aria-hidden="true" />
            New Chat
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!selectedProject}
            onClick={() => setDrawer(drawer === 'history' ? null : 'history')}
          >
            <History size={16} aria-hidden="true" />
            History
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!selectedThreadId}
            onClick={() => setDrawer(drawer === 'changes' ? null : 'changes')}
          >
            <PanelRight size={16} aria-hidden="true" />
            Changes{diffs.length ? ` (${diffs.length})` : ''}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => setDrawer(drawer === 'settings' ? null : 'settings')}
          >
            <Settings size={16} aria-hidden="true" />
            Settings
          </button>
        </nav>
      </header>

      <section className="chat-pane" aria-label="Agent timeline">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">{selectedProject?.displayName ?? 'Choose a project folder'}</p>
            <h1>{selectedThread?.title ?? 'What should we build?'}</h1>
          </div>
          {selectedThread && (
            <span className={`run-status ${selectedThread.status}`}>
              {selectedThread.status.replace('_', ' ')}
            </span>
          )}
        </header>
        <div className="conversation-stage">
          <div
            ref={timelineRef}
            className="timeline"
            role="log"
            aria-label="Agent activity timeline"
            onScroll={(event) => {
              const element = event.currentTarget;
              followTimeline.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            }}
          >
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
            {!selectedThread && (
              <EmptyTimeline
                hasProject={Boolean(selectedProject)}
                onSuggestion={(suggestion) => {
                  setComposer(suggestion);
                  requestAnimationFrame(() => document.getElementById('task-composer')?.focus());
                }}
              />
            )}
            {timeline.map((item) => (
              <TimelineEntry item={item} key={item.id} />
            ))}
          </div>
          <div className="composer-dock">
            <div className="composer-stack" ref={composerStackRef}>
              <ComposerPanel shown={Boolean(visibleBottomSponsor)} kind="sponsor">
                {visibleBottomSponsor && (
                  <SponsorSurface
                    sponsor={visibleBottomSponsor.sponsor}
                    location="banner-bottom"
                    onHide={() =>
                      setDismissedBottomSponsors((current) =>
                        new Set(current).add(visibleBottomSponsor.eventId)
                      )
                    }
                  />
                )}
              </ComposerPanel>
              <ComposerPanel shown={Boolean(pendingApproval)} kind="approval">
                {pendingApproval && (
                  <ApprovalCard approval={pendingApproval} onResolve={resolveApproval} />
                )}
              </ComposerPanel>
              <Composer
                value={composer}
                disabled={!selectedProject || !selectedModel || busy || needsContinue}
                isRunning={isRunning}
                runningMode={runningMessageMode}
                models={selectableModels}
                model={model}
                thinkingLevel={thinkingLevel}
                onChange={setComposer}
                onRunningModeChange={setRunningMessageMode}
                onModelChange={(nextModel) => {
                  const descriptor = selectableModels.find(
                    (candidate) => candidate.id === nextModel
                  );
                  if (descriptor) {
                    void updateModelPreferences(descriptor.id, descriptor.defaultThinkingLevel);
                  }
                }}
                onThinkingLevelChange={(level) => void updateModelPreferences(model, level)}
                onSend={() => void send()}
                onStop={async () => {
                  if (selectedThreadId) {
                    await window.adrouter.turns.stop({ threadId: selectedThreadId });
                  }
                }}
              />
            </div>
          </div>
        </div>
      </section>

      {renderedDrawer && (
        <aside
          className="drawer"
          aria-label={`${renderedDrawer} drawer`}
          aria-hidden={!drawerExpanded}
          data-state={drawerExpanded ? 'open' : 'closed'}
          data-side={renderedDrawer === 'history' ? 'left' : 'right'}
          onTransitionEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.propertyName === 'transform' &&
              !drawer &&
              !drawerExpanded
            ) {
              setRenderedDrawer(undefined);
            }
          }}
        >
          <div className="drawer-header">
            <h2>
              {renderedDrawer[0]?.toUpperCase()}
              {renderedDrawer.slice(1)}
            </h2>
            <button className="text-button" type="button" onClick={() => setDrawer(null)}>
              <X size={17} aria-hidden="true" />
              <span className="sr-only">Close</span>
            </button>
          </div>
          {renderedDrawer === 'history' && (
            <div className="thread-list">
              <input
                type="search"
                aria-label="Search task history"
                placeholder="Search tasks and context"
                value={historyQuery}
                onChange={(event) => setHistoryQuery(event.target.value)}
              />
              <div className="history-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!selectedThreadId}
                  onClick={() => void exportSession('json')}
                >
                  Export JSON
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!selectedThreadId}
                  onClick={() => void exportSession('html')}
                >
                  Export HTML
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!selectedThreadId}
                  onClick={() => void copyLastAssistantResponse()}
                >
                  Copy last
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!selectedThreadId || isRunning || busy}
                  onClick={() => void compactContext()}
                >
                  Compact context
                </button>
                {isRunning && (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void clearQueuedFollowUps()}
                  >
                    Clear queued
                  </button>
                )}
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!selectedProjectId}
                  onClick={() => sessionImportRef.current?.click()}
                >
                  Import
                </button>
                <input
                  ref={sessionImportRef}
                  className="sr-only"
                  type="file"
                  accept="application/json,application/x-ndjson,.json,.jsonl"
                  aria-label="Import session file"
                  onChange={(event) => void importSession(event.target.files?.[0])}
                />
              </div>
              {detail?.contextBudget && (
                <small className="context-budget">
                  Context {detail.contextBudget.estimatedTokens.toLocaleString()} /{' '}
                  {detail.contextBudget.maxInputTokens.toLocaleString()} tokens ·{' '}
                  {detail.contextBudget.status}
                </small>
              )}
              {sessionImportPreview && (
                <section className="session-controls" aria-label="Session import preview">
                  <strong>Confirm inert session import</strong>
                  <small>
                    {sessionImportPreview.format === 'adrouter-cli-v3-jsonl'
                      ? 'AdRouterCLI v3 active branch'
                      : 'AdRouter Agent JSON'}{' '}
                    · {sessionImportPreview.entries} entries · {sessionImportPreview.messages}{' '}
                    messages
                  </small>
                  <small>
                    {sessionImportPreview.title} · {sessionImportPreview.model} ·{' '}
                    {sessionImportPreview.thinkingLevel}
                  </small>
                  {sessionImportPreview.warnings.map((warning) => (
                    <small key={warning}>{warning}</small>
                  ))}
                  <div className="inline-controls">
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => void confirmSessionImport()}
                    >
                      Import into this project
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => setSessionImportPreview(undefined)}
                    >
                      Cancel
                    </button>
                  </div>
                </section>
              )}
              {selectedThread && (
                <section className="session-controls" aria-label="Selected task session controls">
                  <label htmlFor="task-label">Label</label>
                  <div className="inline-controls">
                    <input
                      id="task-label"
                      value={labelDraft}
                      maxLength={120}
                      onChange={(event) => setLabelDraft(event.target.value)}
                    />
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={labelDraft.trim() === (selectedThread.label ?? '')}
                      onClick={() => void saveThreadLabel()}
                    >
                      Save
                    </button>
                  </div>
                  {needsContinue && (
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => void continueThread()}
                    >
                      Continue interrupted task
                    </button>
                  )}
                  <label htmlFor="fork-checkpoint">Fork from safe checkpoint</label>
                  <div className="inline-controls">
                    <select
                      id="fork-checkpoint"
                      value={selectedCheckpointId}
                      onChange={(event) => setSelectedCheckpointId(event.target.value)}
                      disabled={!detail?.checkpoints?.length}
                    >
                      <option value="">No checkpoint</option>
                      {detail?.checkpoints?.map((checkpoint, index) => (
                        <option key={checkpoint.id} value={checkpoint.id}>
                          Checkpoint {index + 1} · entry {checkpoint.entryOrdinal}
                        </option>
                      ))}
                    </select>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={!selectedCheckpointId}
                      onClick={() => void forkCheckpoint()}
                    >
                      Fork
                    </button>
                  </div>
                </section>
              )}
              {threads.map((thread) => (
                <div
                  className={`thread-row ${thread.id === selectedThreadId ? 'selected' : ''}`}
                  key={thread.id}
                  style={{ paddingLeft: `${threadDepth(thread, threads) * 18}px` }}
                >
                  <button
                    className="thread-select"
                    type="button"
                    onClick={() => {
                      setSelectedThreadId(thread.id);
                      setDrawer(null);
                    }}
                  >
                    <span className={`status-dot ${thread.status}`} aria-hidden="true" />
                    <span>
                      {thread.title}
                      {thread.label && <small>{thread.label}</small>}
                    </span>
                  </button>
                  <button
                    className="thread-delete"
                    type="button"
                    aria-label={`Delete ${thread.title}`}
                    disabled={thread.status === 'running' || thread.status === 'awaiting_approval'}
                    onClick={() => setDeletingThread(thread)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                    <span className="sr-only">Delete</span>
                  </button>
                </div>
              ))}
            </div>
          )}
          {renderedDrawer === 'changes' && (
            <>
              {detail?.gitBaseline && (
                <section className="git-baseline" aria-label="Task-start Git baseline">
                  <strong>Task-start Git baseline</strong>
                  <small>
                    {detail.gitBaseline.ref ?? 'detached HEAD'} ·{' '}
                    {detail.gitBaseline.headOid?.slice(0, 12) ?? 'unborn'}
                  </small>
                  <small>
                    {detail.gitBaseline.statusEntries.length} pre-existing change(s)
                    {detail.gitBaseline.truncated ? ' · truncated' : ''}
                  </small>
                </section>
              )}
              {selectedProject?.git && selectedThread && (
                <section className="git-workflow" aria-label="Reviewed Git workflow">
                  <strong>Reviewed Git workflow</strong>
                  <small>
                    Every write gets an exact, expiring before-state preview and a separate
                    allow-once decision.
                  </small>
                  <label htmlFor="git-operation">Operation</label>
                  <select
                    id="git-operation"
                    value={gitCapability}
                    disabled={gitBusy || isRunning}
                    onChange={(event) =>
                      setGitCapability(event.target.value as typeof gitCapability)
                    }
                  >
                    <option value="git.stage">Stage exact paths</option>
                    <option value="git.stage.hunk">Stage selected text hunks</option>
                    <option value="git.commit">Commit staged index</option>
                    <option value="git.branch.create">Create branch</option>
                    <option value="git.switch">Switch clean worktree</option>
                    <option value="git.push">Push exact ref</option>
                  </select>
                  {gitCapability === 'git.stage' ? (
                    <textarea
                      aria-label="Git paths"
                      placeholder="One workspace-relative path per line"
                      value={gitPrimary}
                      onChange={(event) => setGitPrimary(event.target.value)}
                    />
                  ) : (
                    <input
                      aria-label={
                        gitCapability === 'git.commit'
                          ? 'Commit message'
                          : gitCapability === 'git.push'
                            ? 'Git remote'
                            : gitCapability === 'git.stage.hunk'
                              ? 'Git path'
                              : 'Git branch'
                      }
                      placeholder={gitCapability === 'git.push' ? 'origin' : undefined}
                      value={gitPrimary}
                      onChange={(event) => setGitPrimary(event.target.value)}
                    />
                  )}
                  {(gitCapability === 'git.push' || gitCapability === 'git.stage.hunk') && (
                    <input
                      aria-label={
                        gitCapability === 'git.push' ? 'Remote branch ref' : 'Git hunk ordinals'
                      }
                      placeholder={gitCapability === 'git.push' ? 'refs/heads/feature' : '1, 3'}
                      value={gitSecondary}
                      onChange={(event) => setGitSecondary(event.target.value)}
                    />
                  )}
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={gitBusy || isRunning || needsContinue || !gitPrimary.trim()}
                    onClick={() => void previewGitOperation()}
                  >
                    Review exact operation
                  </button>
                  {gitPreview && (
                    <div className="git-preview">
                      <small>{gitPreview.reason}</small>
                      {gitPreview.patchPreview && (
                        <>
                          <strong>Selected Git hunk patch</strong>
                          <pre>{gitPreview.patchPreview}</pre>
                        </>
                      )}
                      <code>{gitPreview.manifest.binding}</code>
                      <div className="approval-actions">
                        <button
                          className="allow-button"
                          type="button"
                          disabled={gitBusy}
                          onClick={() => void resolveGitOperation('allow-once')}
                        >
                          Allow once
                        </button>
                        <button
                          className="deny-button"
                          type="button"
                          disabled={gitBusy}
                          onClick={() => void resolveGitOperation('deny')}
                        >
                          Deny
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              )}
              <ChangesPanel diffs={diffs} selected={selectedDiff} onSelect={setSelectedDiffPath} />
            </>
          )}
          {renderedDrawer === 'settings' && (
            <>
              <AgentStatusPanel
                status={routerStatus}
                busy={statusBusy}
                serverUrl={serverUrl}
                agentStatus={selectedThread?.status ?? 'ready'}
                onRefresh={() => void refreshRouterStatus()}
              />
              <details
                className="project-controls settings-disclosure"
                aria-label="Custom instructions"
              >
                <summary>Custom instructions</summary>
                <div className="settings-disclosure-content">
                  <label htmlFor="project-instructions">Project instructions</label>
                  <textarea
                    id="project-instructions"
                    value={instructionDraft}
                    onChange={(event) => setInstructionDraft(event.target.value)}
                    disabled={!selectedProject}
                  />
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!selectedProject || instructionDraft === selectedProject.instructions}
                    onClick={() => void saveInstructions()}
                  >
                    Save instructions
                  </button>
                  {selectedProject?.repositoryInstructionFiles.length ? (
                    <small>
                      Repository files loaded:{' '}
                      {selectedProject.repositoryInstructionFiles.join(', ')}
                    </small>
                  ) : (
                    <small>No repository instruction files loaded.</small>
                  )}
                </div>
              </details>
              <details
                className="project-controls settings-disclosure"
                aria-label="Declarative bundles"
              >
                <summary>Declarative bundles</summary>
                <div className="settings-disclosure-content">
                  <small>
                    Only exact, packaged Markdown guidance can be enabled. Bundle content cannot add
                    tools, network access, or executable hooks.
                  </small>
                  {bundles.map((bundle) => (
                    <label className="toggle-row" key={bundle.id}>
                      <input
                        type="checkbox"
                        checked={bundle.active}
                        onChange={(event) => void setBundleTrust(bundle, event.target.checked)}
                        disabled={!selectedProject}
                      />
                      <span>
                        <strong>{bundle.id}</strong> {bundle.version}
                        <small>
                          {bundle.entries.map((entry) => entry.title).join(', ')} ·{' '}
                          {bundle.aggregateDigest.slice(0, 12)}…
                        </small>
                        {bundle.trustReason && <small>{bundle.trustReason}</small>}
                      </span>
                    </label>
                  ))}
                  {bundles.length === 0 && <small>No packaged bundles are available.</small>}
                </div>
              </details>
              <details
                className="project-controls settings-disclosure"
                aria-label="Delegated child tasks"
              >
                <summary>Delegated child tasks</summary>
                <div className="settings-disclosure-content">
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedProject?.delegationEnabled)}
                      disabled={!selectedProject}
                      onChange={(event) => void setDelegationEnabled(event.target.checked)}
                    />
                    <span>
                      <strong>Enable bounded delegation</strong>
                      <small>
                        Depth one, at most three visible children. Every child start still requires
                        a fresh high-risk allow-once decision and uses an independent conversation.
                      </small>
                    </span>
                  </label>
                </div>
              </details>
              <details
                className="project-controls settings-disclosure"
                aria-label="Local automation"
              >
                <summary>Local automation</summary>
                <div className="settings-disclosure-content">
                  <small>
                    Owner-only local IPC · protocol 1
                    {automationEndpoint ? ` · ${automationEndpoint}` : ''}
                  </small>
                  {automationPairings.map((pairing) => (
                    <section className="detail-panel" key={pairing.id}>
                      <strong>{pairing.displayName}</strong>
                      <span className="user-code">{pairing.comparisonCode}</span>
                      <small>Scopes: {pairing.scopes.join(', ')}</small>
                      <small>Key: {pairing.publicKeyFingerprint.slice(0, 16)}…</small>
                      <div className="onboarding-actions">
                        <button
                          className="primary-button"
                          type="button"
                          onClick={() => void decidePairing(pairing.id, true)}
                        >
                          Approve exact key and scopes
                        </button>
                        <button
                          className="danger-outline-button"
                          type="button"
                          onClick={() => void decidePairing(pairing.id, false)}
                        >
                          Deny
                        </button>
                      </div>
                    </section>
                  ))}
                  {automationPairings.length === 0 && <small>No pairing is awaiting review.</small>}
                  {automationClients.map((client) => (
                    <div className="toggle-row" key={client.id}>
                      <span>
                        <strong>{client.displayName}</strong>
                        <small>
                          {client.scopes.join(', ')} · {client.publicKeyFingerprint.slice(0, 16)}…
                          {client.revokedAt ? ' · revoked' : ''}
                        </small>
                      </span>
                      {!client.revokedAt && (
                        <button
                          className="danger-outline-button"
                          type="button"
                          onClick={() => void revokeAutomationClient(client.id)}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </details>
              <div className="settings-primary-sections">
                <EconomicsPanel events={detail?.events ?? []} sponsor={sponsor} />
                <section className="detail-panel credential-panel" aria-label="AdRouter credential">
                  <div className="detail-heading">
                    <div>
                      <p className="eyebrow">Authentication</p>
                      <h2>Manage this installation</h2>
                    </div>
                    <button
                      className="danger-outline-button settings-sign-out-button"
                      type="button"
                      disabled={hasActiveTask || signOutBusy}
                      onClick={() => setConfirmingSignOut(true)}
                    >
                      <LogOut size={16} aria-hidden="true" />
                      Sign out
                    </button>
                  </div>
                  <p className="empty-copy">
                    Sign out attempts to revoke this installation, then always removes its encrypted
                    key and refresh credential locally. Projects, chats, and preferences stay here.
                  </p>
                  {hasActiveTask && (
                    <small>Stop all active or queued agent tasks before signing out.</small>
                  )}
                </section>
                <AboutPanel info={applicationInfo} />
              </div>
            </>
          )}
        </aside>
      )}
      {deletingThread && (
        <div className="modal-backdrop">
          <section
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-chat-title"
          >
            <h2 id="delete-chat-title">Delete “{deletingThread.title}”?</h2>
            <p>
              This permanently removes its messages, approvals, settlements, and saved change
              history. Project files are not affected.
            </p>
            <div className="approval-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setDeletingThread(undefined)}
              >
                Cancel
              </button>
              <button className="deny-button" type="button" onClick={() => void deleteThread()}>
                Delete permanently
              </button>
            </div>
          </section>
        </div>
      )}
      {confirmingSignOut && (
        <div className="modal-backdrop">
          <section
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sign-out-title"
          >
            <h2 id="sign-out-title">Sign out this Agent?</h2>
            <p>
              AdRouter Agent will try to revoke this installation remotely, then remove all local
              authentication material even if the server is unavailable. Your projects and chats are
              not removed.
            </p>
            <div className="approval-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={signOutBusy}
                onClick={() => setConfirmingSignOut(false)}
              >
                Cancel
              </button>
              <button
                className="deny-button"
                type="button"
                disabled={signOutBusy || hasActiveTask}
                onClick={() => {
                  setSignOutBusy(true);
                  setError(undefined);
                  void window.adrouter.configuration
                    .signOut()
                    .then((result) => {
                      const configuration = result.configuration;
                      setOnboardingDefaults({
                        serverUrl: configuration.serverUrl,
                        sponsoredCompute: configuration.sponsoredCompute,
                      });
                      setRouterStatus(undefined);
                      setDrawer(null);
                      setConfirmingSignOut(false);
                      setSignOutNotice(
                        result.remoteRevocationConfirmed
                          ? 'This installation was revoked and removed from this device.'
                          : 'Local authentication was removed. If this device was offline, confirm revocation in the AdRouter WebUI.'
                      );
                      setConfigured(false);
                    })
                    .catch((caught) => setError(errorMessage(caught)))
                    .finally(() => setSignOutBusy(false));
                }}
              >
                {signOutBusy ? 'Signing out…' : 'Sign out and remove'}
              </button>
            </div>
          </section>
        </div>
      )}
      <ThemeToggle />
    </main>
  );
}

function AboutPanel({ info }: { info?: ApplicationInfo }): JSX.Element {
  return (
    <section className="detail-panel about-panel" aria-label="About AdRouter Agent">
      <div className="detail-heading">
        <div>
          <p className="eyebrow">Public beta</p>
          <h2>About AdRouter Agent</h2>
        </div>
      </div>
      <dl className="status-grid">
        <div>
          <dt>Version</dt>
          <dd>{info?.version ?? 'Loading…'}</dd>
        </div>
        <div>
          <dt>Platform</dt>
          <dd>{info ? `${info.platform} · ${info.architecture}` : 'Loading…'}</dd>
        </div>
      </dl>
      <p className="empty-copy">
        Local project data stays on this device. Agent requests are sent only to your configured
        AdRouter server. Updates are installed manually.
      </p>
      {info?.sandbox.status !== 'ready' && info?.sandbox ? (
        <div className="notice-card" role="status">
          <strong>Command sandbox: {info.sandbox.status}</strong>
          <p>{info.sandbox.detail}</p>
          {info.sandbox.setupCommands.map((command) => (
            <code key={command}>{command}</code>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Onboarding({
  initialServerUrl,
  initialSponsoredCompute,
  notice,
  onConfigured,
  onModels,
}: {
  initialServerUrl: string;
  initialSponsoredCompute: boolean;
  notice?: string;
  onConfigured: () => Promise<void>;
  onModels: (models: RouterModelDescriptor[]) => void;
}): JSX.Element {
  const [serverUrl, setServerUrl] = useState(initialServerUrl || DEFAULT_ADROUTER_SERVER_URL);
  const [token, setToken] = useState('');
  const [advancedCustom, setAdvancedCustom] = useState(false);
  const [enrollment, setEnrollment] = useState<EnrollmentStatus>();
  const [sponsoredCompute, setSponsoredCompute] = useState(initialSponsoredCompute);
  const [diagnostics, setDiagnostics] = useState<RouterDiagnostics>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const originClass = useMemo(() => {
    try {
      return classifyRouterOrigin(serverUrl);
    } catch {
      return 'custom';
    }
  }, [serverUrl]);
  const official = originClass === 'official';
  const enrollmentActive =
    enrollment?.state === 'awaiting_sign_in' ||
    enrollment?.state === 'starting' ||
    enrollment?.state === 'pending';

  useEffect(() => {
    if (typeof window.adrouter.configuration.enrollmentStatus !== 'function') return undefined;
    let active = true;
    void window.adrouter.configuration.enrollmentStatus().then((status) => {
      if (active && status.state !== 'idle') setEnrollment(status);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (enrollment?.state !== 'pending') return undefined;
    const interval = window.setInterval(() => {
      void window.adrouter.configuration
        .enrollmentStatus()
        .then(async (status) => {
          setEnrollment(status);
          if (status.state === 'approved') await onConfigured();
        })
        .catch((caught) => setError(errorMessage(caught)));
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [enrollment?.state, onConfigured]);

  const test = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.adrouter.configuration.testRouter({ serverUrl, token });
      setDiagnostics(result);
      onModels(result.models);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      let verified = diagnostics;
      if (!verified?.health || !verified.authenticated) {
        verified = await window.adrouter.configuration.testRouter({ serverUrl, token });
        setDiagnostics(verified);
        onModels(verified.models);
      }
      if (!verified.health || !verified.authenticated) {
        return;
      }
      await window.adrouter.configuration.save({ serverUrl, token, sponsoredCompute });
      await onConfigured();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const status = await window.adrouter.configuration.startEnrollment({
        serverUrl,
        sponsoredCompute,
        displayName: 'AdRouter Agent',
      });
      setEnrollment(status);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const continueEnrollment = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      setEnrollment(await window.adrouter.configuration.continueEnrollment());
    } catch (caught) {
      setError(errorMessage(caught));
      setEnrollment(await window.adrouter.configuration.enrollmentStatus().catch(() => enrollment));
    } finally {
      setBusy(false);
    }
  };
  const openEnrollment = (): void => {
    void window.adrouter.configuration
      .openEnrollment()
      .catch((caught) => setError(errorMessage(caught)));
  };
  const copyEnrollmentLink = (): void => {
    void window.adrouter.configuration
      .copyEnrollmentLink()
      .catch((caught) => setError(errorMessage(caught)));
  };
  const cancelEnrollment = (): void => {
    void window.adrouter.configuration
      .cancelEnrollment()
      .then(setEnrollment)
      .catch((caught) => setError(errorMessage(caught)));
  };
  return (
    <main className="onboarding-shell">
      <section className="onboarding-card" aria-labelledby="onboarding-title">
        <span className="brand-mark large" aria-hidden="true">
          <img src={jellyfishLogo} alt="" />
        </span>
        <p className="eyebrow">Local-first desktop coding agent</p>
        <h1 id="onboarding-title">Connect AdRouter</h1>
        <p>
          Official AdRouter access uses a unique installation key protected by your operating system
          credential store. Private keys and tokens never enter this screen.
        </p>
        {notice && <div className="diagnostics success">{notice}</div>}
        <label htmlFor="router-url">AdRouter server URL</label>
        <input
          id="router-url"
          value={serverUrl}
          onChange={(event) => setServerUrl(event.target.value)}
          autoComplete="url"
          disabled={enrollmentActive}
        />
        <label className="toggle-row" htmlFor="sponsored-compute">
          <input
            id="sponsored-compute"
            checked={sponsoredCompute}
            onChange={(event) => setSponsoredCompute(event.target.checked)}
            type="checkbox"
            disabled={enrollmentActive}
          />
          <span>Enable sponsored compute</span>
        </label>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {diagnostics && (
          <div
            className={`diagnostics ${diagnostics.health && diagnostics.authenticated ? 'success' : 'failed'}`}
          >
            <strong>
              {diagnostics.health && diagnostics.authenticated
                ? 'Connection verified'
                : 'Connection failed'}
            </strong>
            <span>{diagnostics.error ?? `${diagnostics.models.length} model(s) discovered`}</span>
          </div>
        )}
        {official &&
          enrollment &&
          enrollment.state !== 'idle' &&
          enrollment.state !== 'awaiting_sign_in' &&
          enrollment.state !== 'pending' &&
          enrollment.message && (
            <div
              className={`diagnostics ${enrollment.state === 'approved' ? 'success' : 'failure'}`}
              role="status"
            >
              {enrollment.message}
            </div>
          )}
        {official ? (
          enrollment?.state === 'awaiting_sign_in' ? (
            <section className="enrollment-panel" aria-live="polite">
              <p className="eyebrow">Sign in before creating the installation</p>
              <strong>Finish signing in to AdRouter in your browser.</strong>
              <p>{enrollment.message}</p>
              <div className="onboarding-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void continueEnrollment()}
                  disabled={busy}
                >
                  {busy ? 'Continuing…' : 'Continue'}
                </button>
                <button className="secondary-button" type="button" onClick={openEnrollment}>
                  Open sign-in page
                </button>
                <button className="secondary-button" type="button" onClick={copyEnrollmentLink}>
                  Copy sign-in link
                </button>
                <button className="danger-outline-button" type="button" onClick={cancelEnrollment}>
                  Cancel
                </button>
              </div>
              <small>The sign-in link stays in the protected Electron main process.</small>
            </section>
          ) : enrollment?.state === 'pending' ? (
            <section className="enrollment-panel" aria-live="polite">
              <p className="eyebrow">Compare this code in the AdRouter WebUI</p>
              <strong className="user-code">{enrollment.userCode}</strong>
              <p>{enrollment.message ?? 'Waiting for your approval…'}</p>
              <div className="onboarding-actions">
                <button className="secondary-button" type="button" onClick={openEnrollment}>
                  Open approval page
                </button>
                <button className="secondary-button" type="button" onClick={copyEnrollmentLink}>
                  Copy approval link
                </button>
                <button className="danger-outline-button" type="button" onClick={cancelEnrollment}>
                  Cancel
                </button>
              </div>
              <small>If the page does not open, copy the approval link and open it manually.</small>
            </section>
          ) : (
            <div className="onboarding-actions">
              <button
                className="primary-button"
                type="button"
                onClick={() => void connect()}
                disabled={busy || !serverUrl}
              >
                {busy ? 'Connecting…' : 'Connect this Agent'}
              </button>
            </div>
          )
        ) : (
          <details
            open={advancedCustom}
            onToggle={(event) => setAdvancedCustom(event.currentTarget.open)}
          >
            <summary>Advanced: connect a custom or local router</summary>
            <p>
              Bearer tokens are supported only for explicit non-official routers. They cannot
              override official hosted installation authentication.
            </p>
            <label htmlFor="router-token">Custom router access token</label>
            <input
              id="router-token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              type="password"
              autoComplete="off"
            />
            <div className="onboarding-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => void test()}
                disabled={busy || !serverUrl || !token}
              >
                Test connection
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => void save()}
                disabled={busy || !serverUrl || !token}
              >
                Save custom router
              </button>
            </div>
          </details>
        )}
      </section>
    </main>
  );
}

function TimelineEntry({ item }: { item: TimelineItem }): JSX.Element {
  const [sponsorHidden, setSponsorHidden] = useState(false);
  if (item.kind === 'sponsor') {
    return <SponsorSurface sponsor={item.sponsor} location="banner-top" />;
  }
  if (item.kind === 'assistant') {
    const finalRound = item.rounds?.at(-1);
    const sponsor = finalRound?.sponsor;
    return (
      <article className="timeline-item assistant-message">
        <div className="message-label">AdRouter</div>
        <div className="assistant-bubble">
          <ReactMarkdown>{item.text || '…'}</ReactMarkdown>
          {sponsor?.tier === 'A' &&
            (sponsorHidden ? (
              <button
                className="show-sponsored"
                type="button"
                onClick={() => setSponsorHidden(false)}
              >
                Show sponsored suggestion
              </button>
            ) : (
              <SponsorSurface
                sponsor={sponsor}
                location="inline"
                onHide={() => setSponsorHidden(true)}
              />
            ))}
          {sponsor?.tier === 'NONE' && (
            <div className="privacy-notice">
              <strong>Privacy guardrail</strong>
              <span>{sponsor.reason || sponsor.headline || 'No sponsored content was shown.'}</span>
            </div>
          )}
          {item.rounds && item.rounds.length > 0 && <SponsorshipSummary rounds={item.rounds} />}
        </div>
        {sponsor?.tier === 'B' &&
          (sponsorHidden ? (
            <button
              className="show-sponsored"
              type="button"
              onClick={() => setSponsorHidden(false)}
            >
              Show sponsored suggestion
            </button>
          ) : (
            <SponsorSurface
              sponsor={sponsor}
              location="card"
              onHide={() => setSponsorHidden(true)}
            />
          ))}
      </article>
    );
  }
  if (item.kind === 'user') {
    return (
      <article className="timeline-item user-message">
        <div className="message-label">You</div>
        <p>{item.text}</p>
      </article>
    );
  }
  if (item.kind === 'thinking') {
    if (item.active) {
      return (
        <section className="timeline-item thinking-message" aria-label="Thinking">
          <div className="thinking-label">Thinking</div>
          <ReactMarkdown>{item.text || '…'}</ReactMarkdown>
        </section>
      );
    }
    return (
      <details className="timeline-item thinking-message">
        <summary>Thinking</summary>
        <div className="thinking-content">
          <ReactMarkdown>{item.text}</ReactMarkdown>
        </div>
      </details>
    );
  }
  if (item.kind === 'read') {
    const failed = item.reads.filter((read) => read.status === 'failed').length;
    return (
      <details className="timeline-item tool-message read-group">
        <summary>
          Read × {item.reads.length}
          {failed > 0 ? ` · ${failed} failed` : ''}
        </summary>
        <ul>
          {item.reads.map((read) => (
            <li key={read.id}>
              <span>{read.path}</span>
              <small>{read.status}</small>
            </li>
          ))}
        </ul>
      </details>
    );
  }
  if (item.kind === 'tool') {
    return (
      <details className="timeline-item tool-message">
        <summary>
          {item.title} <small>{item.status}</small>
        </summary>
        <pre>{item.text}</pre>
      </details>
    );
  }
  return (
    <article className={`timeline-item ${item.kind}-message`}>
      <strong>{item.title}</strong>
      <p>{item.text}</p>
    </article>
  );
}

function SponsorshipSummary({ rounds }: { rounds: SponsorRound[] }): JSX.Element {
  const totals = rounds.reduce(
    (current, round) => ({
      cost: current.cost + round.cost,
      subsidy: current.subsidy + round.subsidy,
      paid: current.paid + round.paid,
    }),
    { cost: 0, subsidy: 0, paid: 0 }
  );
  return (
    <details className="sponsorship-summary">
      <summary>
        Sponsored compute · {rounds.length} {rounds.length === 1 ? 'round' : 'rounds'} · saved{' '}
        {formatCurrency(totals.subsidy)}
      </summary>
      <div className="sponsorship-totals">
        <span>Cost {formatCurrency(totals.cost)}</span>
        <span>Paid {formatCurrency(totals.paid)}</span>
      </div>
      <ul>
        {rounds.map((round) => (
          <li key={round.routerTurnId}>
            <span>
              Tier {round.sponsor.tier} · {round.sponsor.sponsorName ?? 'No sponsor'}
            </span>
            <strong>{formatCurrency(round.subsidy)}</strong>
          </li>
        ))}
      </ul>
    </details>
  );
}

const starterSuggestions = [
  'Explain this codebase and its architecture',
  'Fix a bug and run the relevant tests',
  'Review the current changes',
];

function EmptyTimeline({
  hasProject,
  onSuggestion,
}: {
  hasProject: boolean;
  onSuggestion: (suggestion: string) => void;
}): JSX.Element {
  return (
    <div className="empty-timeline">
      <div className="welcome-orb" aria-hidden="true">
        <img src={jellyfishLogo} alt="" />
      </div>
      <p className="eyebrow">Local-first coding agent</p>
      <h2>
        {hasProject ? (
          <>
            What should we <span>build?</span>
          </>
        ) : (
          'Open a project to begin'
        )}
      </h2>
      <p className="welcome-copy">
        {hasProject
          ? 'Ask AdRouter Agent to inspect, explain, change, or test this project. It reads safely and asks before running commands or editing files.'
          : 'Choose a local project folder from the toolbar. Your files remain on this device, and every command or edit requires your approval.'}
      </p>
      {hasProject ? (
        <div className="suggestion-grid">
          {starterSuggestions.map((suggestion) => (
            <button type="button" key={suggestion} onClick={() => onSuggestion(suggestion)}>
              <span>{suggestion}</span>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : (
        <div className="welcome-steps">
          <span>1. Choose a folder</span>
          <span>2. Describe the task</span>
          <span>3. Review each action</span>
        </div>
      )}
    </div>
  );
}

function ComposerPanel({
  shown,
  kind,
  children,
}: {
  shown: boolean;
  kind: 'sponsor' | 'approval';
  children: ReactNode;
}): JSX.Element | null {
  const content = useRef<ReactNode>(children);
  const [mounted, setMounted] = useState(shown);
  const [expanded, setExpanded] = useState(false);

  if (shown) content.current = children;

  useEffect(() => {
    if (!shown) {
      setExpanded(false);
      return undefined;
    }
    setMounted(true);
    const frame = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(frame);
  }, [shown]);

  if (!mounted) return null;
  return (
    <div
      className={`composer-panel composer-panel-${kind}`}
      data-state={expanded ? 'open' : 'closed'}
      onTransitionEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.propertyName === 'grid-template-rows' &&
          !shown &&
          !expanded
        ) {
          setMounted(false);
        }
      }}
    >
      <div className="composer-panel-clip">{content.current}</div>
    </div>
  );
}

function Composer({
  value,
  disabled,
  isRunning,
  runningMode,
  models,
  model,
  thinkingLevel,
  onChange,
  onRunningModeChange,
  onModelChange,
  onThinkingLevelChange,
  onSend,
  onStop,
}: {
  value: string;
  disabled: boolean;
  isRunning: boolean;
  runningMode: 'steer' | 'follow-up';
  models: RouterModelDescriptor[];
  model: string;
  thinkingLevel: ThinkingLevel;
  onChange: (value: string) => void;
  onRunningModeChange: (mode: 'steer' | 'follow-up') => void;
  onModelChange: (model: string) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  onSend: () => void;
  onStop: () => Promise<void>;
}): JSX.Element {
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <label className="sr-only" htmlFor="task-composer">
        Task message
      </label>
      <textarea
        id="task-composer"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!disabled && value.trim()) onSend();
          }
        }}
        disabled={disabled}
        placeholder="Ask the agent to inspect, change, test, or explain this repository…"
      />
      <div className="composer-actions">
        {isRunning && (
          <label className="composer-select">
            <span className="sr-only">Running task message mode</span>
            <select
              aria-label="Running task message mode"
              value={runningMode}
              disabled={disabled}
              onChange={(event) => onRunningModeChange(event.target.value as 'steer' | 'follow-up')}
            >
              <option value="follow-up">Queue follow-up</option>
              <option value="steer">Steer current turn</option>
            </select>
          </label>
        )}
        <label className="composer-select">
          <span className="sr-only">Router model</span>
          <select
            aria-label="Router model"
            value={model}
            disabled={disabled || isRunning || models.length === 0}
            onChange={(event) => onModelChange(event.target.value)}
          >
            {models.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.displayName} · {candidate.providerLabel}
              </option>
            ))}
          </select>
        </label>
        <label className="composer-select">
          <span className="sr-only">Thinking level</span>
          <select
            aria-label="Thinking level"
            value={thinkingLevel}
            disabled={disabled || isRunning || !models.length}
            onChange={(event) => onThinkingLevelChange(event.target.value as ThinkingLevel)}
          >
            {(models.find((candidate) => candidate.id === model)?.thinkingLevels ?? []).map(
              (level) => (
                <option key={level} value={level}>
                  {level === 'none'
                    ? 'No thinking'
                    : `${level[0]?.toUpperCase()}${level.slice(1)} thinking`}
                </option>
              )
            )}
          </select>
        </label>
        {isRunning ? (
          <>
            <button className="primary-button" type="submit" disabled={disabled || !value.trim()}>
              <Send size={15} aria-hidden="true" />
              {runningMode === 'steer' ? 'Steer' : 'Queue'}
            </button>
            <button className="stop-button" type="button" onClick={() => void onStop()}>
              <Square size={14} aria-hidden="true" />
              Stop
            </button>
          </>
        ) : (
          <button className="primary-button" type="submit" disabled={disabled || !value.trim()}>
            <Send size={15} aria-hidden="true" />
            Send
          </button>
        )}
      </div>
    </form>
  );
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: Approval;
  onResolve: (approval: Approval, decision: 'allow-once' | 'deny') => Promise<void>;
}): JSX.Element {
  const manifest = approval.operationManifest;
  const target =
    manifest?.targets.map((candidate) => candidate.path).join(' → ') ||
    manifest?.network?.url ||
    approval.argv?.join(' ') ||
    approval.path ||
    'Requested operation';
  return (
    <section className="approval-card" aria-labelledby={`approval-${approval.id}`}>
      <p className="eyebrow">Approval required · {approval.risk} risk</p>
      <h2 id={`approval-${approval.id}`}>
        {manifest
          ? manifest.capability
          : approval.kind === 'command'
            ? 'Run command'
            : approval.kind === 'file-delete'
              ? 'Delete file'
              : 'Edit file'}
      </h2>
      <code>{target}</code>
      <p>{approval.reason}</p>
      {manifest && (
        <small>
          Immutable binding: {manifest.binding.slice(0, 16)}… · expires{' '}
          {new Date(manifest.expiresAt).toLocaleTimeString()}
        </small>
      )}
      <small>Working directory: {approval.cwd}</small>
      <div className="approval-actions">
        <button
          className="primary-button"
          type="button"
          onClick={() => void onResolve(approval, 'allow-once')}
        >
          Allow once
        </button>
        <button
          className="deny-button"
          type="button"
          onClick={() => void onResolve(approval, 'deny')}
        >
          Deny
        </button>
      </div>
    </section>
  );
}

function SponsorSurface({
  sponsor,
  location,
  onHide,
}: {
  sponsor: Sponsor;
  location: 'banner-top' | 'banner-bottom' | 'inline' | 'card';
  onHide?: () => void;
}): JSX.Element {
  const className = `sponsor-surface tier-${sponsor.tier.toLowerCase()} ${location}`;
  return (
    <section className={className} aria-label={`Sponsored compute tier ${sponsor.tier}`}>
      <div>
        <p className="eyebrow">Sponsored compute · Tier {sponsor.tier}</p>
        <strong>{sponsor.sponsorName ?? 'Privacy guardrail'}</strong>
      </div>
      <p>{sponsor.headline}</p>
      {sponsor.body && <small>{sponsor.body}</small>}
      {sponsor.url && (
        <a href={sponsor.url} target="_blank" rel="noreferrer">
          Learn about {sponsor.sponsorName ?? 'sponsored compute'}
        </a>
      )}
      <span className="subsidy">
        {sponsor.provisionalSavings > 0
          ? `${formatCurrency(sponsor.provisionalSavings)} estimated savings`
          : `${sponsor.subsidyPercent}% subsidy`}
      </span>
      {onHide && (
        <button
          className={location === 'banner-bottom' ? 'close-sponsored' : 'hide-sponsored'}
          type="button"
          aria-label={location === 'banner-bottom' ? 'Dismiss sponsored banner' : undefined}
          onClick={onHide}
        >
          {location === 'banner-bottom' ? <span aria-hidden="true">×</span> : 'Hide sponsored'}
        </button>
      )}
    </section>
  );
}

function AgentStatusPanel({
  status,
  busy,
  serverUrl,
  agentStatus,
  onRefresh,
}: {
  status?: RouterDiagnostics;
  busy: boolean;
  serverUrl: string;
  agentStatus: Thread['status'] | 'ready';
  onRefresh: () => void;
}): JSX.Element {
  const connection = !status
    ? 'Checking…'
    : status.health && status.authenticated
      ? 'Connected'
      : status.health
        ? 'Authentication failed'
        : 'Unreachable';
  return (
    <section className="detail-panel agent-status-panel" aria-label="Agent status">
      <div className="detail-heading">
        <div>
          <p className="eyebrow">Agent status</p>
          <h2>{connection}</h2>
        </div>
        <button className="secondary-button" type="button" disabled={busy} onClick={onRefresh}>
          {busy ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      <dl className="status-grid">
        <div>
          <dt>Agent</dt>
          <dd>{agentStatus.replace('_', ' ')}</dd>
        </div>
        <div>
          <dt>Router mode</dt>
          <dd>{status?.mode ?? 'unknown'}</dd>
        </div>
        <div>
          <dt>Server</dt>
          <dd>{serverUrl || 'Not configured'}</dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd>{status ? new Date(status.checkedAt).toLocaleTimeString() : '—'}</dd>
        </div>
        <div>
          <dt>Model catalog</dt>
          <dd>
            {status?.catalog
              ? `${status.catalog.compatibility} · ${status.catalog.source}/${status.catalog.freshness}`
              : 'unknown'}
          </dd>
        </div>
        <div>
          <dt>Catalog digest</dt>
          <dd>
            {status?.catalog?.digest ? `${status.catalog.digest.slice(0, 19)}…` : 'not validated'}
          </dd>
        </div>
        <div>
          <dt>Authentication</dt>
          <dd>{status?.authentication?.mode.replace('_', ' ') ?? 'unknown'}</dd>
        </div>
        <div>
          <dt>Installation</dt>
          <dd>
            {status?.authentication?.installationIdSuffix
              ? `…${status.authentication.installationIdSuffix}`
              : (status?.authentication?.state ?? 'none')}
          </dd>
        </div>
        <div>
          <dt>Secret storage</dt>
          <dd>{status?.authentication?.storageClassification ?? 'not used'}</dd>
        </div>
        <div>
          <dt>Signed requests</dt>
          <dd>{status?.authentication?.signedRequestSupport ? 'supported' : 'not active'}</dd>
        </div>
        <div>
          <dt>Refresh</dt>
          <dd>{status?.authentication?.refreshHealthy ? 'healthy' : 'not active'}</dd>
        </div>
      </dl>
      {status?.catalog?.compatibility === 'incompatible' && (
        <p className="status-error">
          This router catalog is incompatible with the installed Agent. Update the Agent before
          starting another task.
        </p>
      )}
      {status?.error && <p className="status-error">{status.error}</p>}
      <details className="settings-disclosure model-disclosure">
        <summary>
          <span>Available models</span>
          <small>{status?.models.length ?? 0}</small>
        </summary>
        <div className="settings-disclosure-content">
          {status?.models.length ? (
            <ul className="model-status-list">
              {status.models.map((candidate) => (
                <li key={candidate.id}>
                  <span>
                    <strong>{candidate.displayName}</strong>
                    <small>
                      {candidate.providerLabel} · {candidate.thinkingLevels.join(', ')} thinking
                    </small>
                  </span>
                  <span className={candidate.configured ? 'model-ready' : 'model-mock'}>
                    {candidate.configured ? 'configured' : 'mock'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-copy">No router models are currently available.</p>
          )}
          {status?.modelsStale && <small>Showing the last known model catalog.</small>}
        </div>
      </details>
    </section>
  );
}

function ChangesPanel({
  diffs,
  selected,
  onSelect,
}: {
  diffs: DiffFile[];
  selected?: DiffFile;
  onSelect: (path: string) => void;
}): JSX.Element {
  const changedLines = useMemo(
    () => (selected ? buildChangedLineDiff(selected.original, selected.current) : undefined),
    [selected]
  );
  return (
    <section className="detail-panel changes-panel">
      <div className="detail-heading">
        <div>
          <p className="eyebrow">Agent-only baselines</p>
          <h2>Changes</h2>
        </div>
      </div>
      {diffs.length === 0 ? (
        <p className="empty-copy">
          Agent-authored changes will appear here. Existing Git changes are intentionally excluded.
        </p>
      ) : (
        <>
          <div className="diff-files">
            {diffs.map((diff) => (
              <button
                className={diff.path === selected?.path ? 'selected' : ''}
                type="button"
                key={diff.path}
                onClick={() => onSelect(diff.path)}
              >
                <span>{diff.path}</span>
                <small>{diff.status}</small>
              </button>
            ))}
          </div>
          {selected && changedLines && (
            <section className="diff-view" aria-label={`Unified changes for ${selected.path}`}>
              {changedLines.tooLarge ? (
                <p className="diff-notice">
                  This file is too large for the changed-lines preview. Review it in your local Git
                  tooling.
                </p>
              ) : changedLines.rows.length === 0 ? (
                <p className="diff-notice">No changed lines remain in this file.</p>
              ) : (
                <table className="unified-diff" aria-label="Changed lines">
                  <tbody>
                    {changedLines.rows.map((row) => {
                      if (row.kind === 'ellipsis' || row.kind === 'meta') {
                        return (
                          <tr
                            className={`diff-row ${row.kind}`}
                            key={
                              row.kind === 'ellipsis'
                                ? `ellipsis-${row.oldLine}-${row.newLine}`
                                : `meta-${row.text}`
                            }
                          >
                            <td className="diff-gutter" />
                            <td className="diff-gutter" />
                            <td className="diff-marker">{row.kind === 'ellipsis' ? '⋯' : '\\'}</td>
                            <td className="diff-code">{row.text}</td>
                          </tr>
                        );
                      }
                      return (
                        <tr
                          className={`diff-row ${row.kind}`}
                          key={`${row.kind}-${row.oldLine ?? 'x'}-${row.newLine ?? 'x'}`}
                        >
                          <td className="diff-gutter">{row.oldLine ?? ''}</td>
                          <td className="diff-gutter">{row.newLine ?? ''}</td>
                          <td className="diff-marker">{row.kind === 'removed' ? '−' : '+'}</td>
                          <td className="diff-code">
                            <code>{row.text || ' '}</code>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}

function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  const nextTheme: Theme = theme === 'light' ? 'dark' : 'light';
  return (
    <fieldset className="theme-control">
      <legend className="sr-only">Color theme</legend>
      <Sun size={15} aria-hidden="true" />
      <button
        className="theme-switch"
        type="button"
        role="switch"
        aria-checked={theme === 'dark'}
        aria-label={`Switch to ${nextTheme} theme`}
        onClick={() => {
          transitionToTheme(nextTheme);
          setTheme(nextTheme);
        }}
      >
        <span aria-hidden="true" />
      </button>
      <Moon size={15} aria-hidden="true" />
    </fieldset>
  );
}

function EconomicsPanel({
  events,
  sponsor,
}: {
  events: JournalEvent[];
  sponsor?: Sponsor;
}): JSX.Element {
  const settlements = events
    .filter((event) => event.type === 'settlement')
    .map((event) => ({ payload: event.payload, timestamp: event.timestamp }));
  const totals = settlements.reduce<{
    cost: number;
    subsidy: number;
    paid: number;
    cacheRead: number;
    cacheWrite: number;
    tokens: number;
  }>(
    (total, settlement) => ({
      cost:
        total.cost + (typeof settlement.payload.cost === 'number' ? settlement.payload.cost : 0),
      subsidy:
        total.subsidy +
        (typeof settlement.payload.subsidy === 'number' ? settlement.payload.subsidy : 0),
      paid:
        total.paid + (typeof settlement.payload.paid === 'number' ? settlement.payload.paid : 0),
      cacheRead:
        total.cacheRead +
        (typeof settlement.payload.cacheRead === 'number' ? settlement.payload.cacheRead : 0),
      cacheWrite:
        total.cacheWrite +
        (typeof settlement.payload.cacheWrite === 'number' ? settlement.payload.cacheWrite : 0),
      tokens:
        total.tokens +
        (typeof settlement.payload.totalTokens === 'number' ? settlement.payload.totalTokens : 0),
    }),
    { cost: 0, subsidy: 0, paid: 0, cacheRead: 0, cacheWrite: 0, tokens: 0 }
  );
  const dailyTotals = settlements.reduce((totalsByDay, settlement) => {
    const day = settlement.timestamp.slice(0, 10);
    const current = totalsByDay.get(day) ?? { cost: 0, subsidy: 0, paid: 0, tokens: 0 };
    totalsByDay.set(day, {
      cost:
        current.cost + (typeof settlement.payload.cost === 'number' ? settlement.payload.cost : 0),
      subsidy:
        current.subsidy +
        (typeof settlement.payload.subsidy === 'number' ? settlement.payload.subsidy : 0),
      paid:
        current.paid + (typeof settlement.payload.paid === 'number' ? settlement.payload.paid : 0),
      tokens:
        current.tokens +
        (typeof settlement.payload.totalTokens === 'number' ? settlement.payload.totalTokens : 0),
    });
    return totalsByDay;
  }, new Map<string, { cost: number; subsidy: number; paid: number; tokens: number }>());
  return (
    <section className="detail-panel economics-panel">
      <div className="detail-heading">
        <div>
          <p className="eyebrow">Compute wallet</p>
          <h2>Economics</h2>
        </div>
        <span className="wallet-badge">{sponsor?.tier ?? '—'}</span>
      </div>
      <dl className="totals">
        <div>
          <dt>Compute cost</dt>
          <dd>{formatCurrency(totals.cost)}</dd>
        </div>
        <div>
          <dt>Subsidized</dt>
          <dd>{formatCurrency(totals.subsidy)}</dd>
        </div>
        <div>
          <dt>You paid</dt>
          <dd>{formatCurrency(totals.paid)}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{totals.tokens.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Cache read / write</dt>
          <dd>
            {totals.cacheRead.toLocaleString()} / {totals.cacheWrite.toLocaleString()}
          </dd>
        </div>
      </dl>
      <details className="ledger">
        <summary>Inference ledger ({settlements.length})</summary>
        {settlements.length === 0 ? (
          <p className="empty-copy">No router settlements yet.</p>
        ) : (
          <ul>
            {settlements.map((settlement, index) => (
              <li key={String(settlement.payload.routerTurnId ?? index)}>
                <span>{String(settlement.payload.inferencePurpose ?? 'agent')}</span>
                <strong>
                  {formatCurrency(
                    typeof settlement.payload.paid === 'number' ? settlement.payload.paid : 0
                  )}
                </strong>
              </li>
            ))}
          </ul>
        )}
      </details>
      <details className="ledger">
        <summary>Daily totals ({dailyTotals.size})</summary>
        <ul>
          {[...dailyTotals.entries()].map(([day, total]) => (
            <li key={day}>
              <span>
                {day} · {total.tokens.toLocaleString()} tokens
              </span>
              <strong>{formatCurrency(total.paid)}</strong>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
