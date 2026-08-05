import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/renderer/App';

const api = {
  configuration: {
    get: vi.fn(),
    save: vi.fn(),
    testRouter: vi.fn(),
    status: vi.fn(),
    signOut: vi.fn(),
    startEnrollment: vi.fn(),
    continueEnrollment: vi.fn(),
    enrollmentStatus: vi.fn(),
    cancelEnrollment: vi.fn(),
    openEnrollment: vi.fn(),
    copyEnrollmentLink: vi.fn(),
    updatePreferences: vi.fn(),
  },
  projects: { open: vi.fn(), list: vi.fn(), get: vi.fn(), update: vi.fn(), remove: vi.fn() },
  bundles: { list: vi.fn(), trust: vi.fn(), revoke: vi.fn() },
  automation: {
    endpoint: vi.fn(),
    pairings: vi.fn(),
    approvePairing: vi.fn(),
    denyPairing: vi.fn(),
    clients: vi.fn(),
    revokeClient: vi.fn(),
  },
  threads: {
    create: vi.fn(),
    list: vi.fn(),
    search: vi.fn(),
    get: vi.fn(),
    label: vi.fn(),
    continue: vi.fn(),
    fork: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
  },
  sessions: { export: vi.fn(), import: vi.fn() },
  git: { preview: vi.fn(), resolve: vi.fn() },
  turns: { start: vi.fn(), steer: vi.fn(), queueFollowUp: vi.fn(), stop: vi.fn() },
  approvals: { resolve: vi.fn() },
  review: {
    getDiff: vi.fn(),
    revertFile: vi.fn(),
    revertAll: vi.fn(),
    accept: vi.fn(),
    openFile: vi.fn(),
  },
  events: { subscribe: vi.fn(), unsubscribe: vi.fn() },
  app: { getInfo: vi.fn(), getVersion: vi.fn(), getPlatform: vi.fn() },
};

beforeEach(() => {
  api.bundles.list.mockResolvedValue([]);
  api.automation.endpoint.mockResolvedValue({
    protocolVersion: 1,
    endpoint: '/tmp/adrouter.sock',
    kind: 'unix-socket',
  });
  api.automation.pairings.mockResolvedValue([]);
  api.automation.clients.mockResolvedValue([]);
  api.configuration.enrollmentStatus.mockResolvedValue({
    state: 'idle',
    userCode: null,
    verificationUri: null,
    verificationUriComplete: null,
    expiresAt: null,
    nextPollAt: null,
    message: null,
  });
  api.app.getInfo.mockResolvedValue({
    name: 'AdRouter Agent',
    version: '0.1.0',
    platform: 'darwin',
    architecture: 'arm64',
    sandbox: { status: 'ready', detail: 'Sandbox available.', setupCommands: [] },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('theme-transitioning');
  document.documentElement.style.colorScheme = '';
});

describe('App onboarding', () => {
  it('renders secure onboarding when no encrypted configuration exists', async () => {
    api.configuration.get.mockResolvedValue({
      serverUrl: '',
      sponsoredCompute: true,
      tokenStored: false,
      configured: false,
      models: [],
    });
    api.projects.list.mockResolvedValue([]);
    Object.defineProperty(window, 'adrouter', { configurable: true, value: api });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Connect AdRouter' })).toBeInTheDocument();
    expect(screen.getByLabelText('Enable sponsored compute')).toBeChecked();
    expect(screen.getByLabelText('AdRouter server URL')).toHaveValue(
      'http://127.0.0.1:8787'
    );
    expect(screen.getByLabelText(/access token/i)).toBeInTheDocument();
    const themeSwitch = screen.getByRole('switch', { name: 'Switch to dark theme' });
    expect(themeSwitch).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(themeSwitch);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('switch', { name: 'Switch to light theme' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('signs in before starting installation approval and exposes only the comparison code', async () => {
    api.configuration.get.mockResolvedValue({
      serverUrl: 'https://api-staging.adrouter.co',
      sponsoredCompute: true,
      tokenStored: false,
      configured: false,
      models: [],
    });
    api.configuration.startEnrollment.mockResolvedValue({
      state: 'awaiting_sign_in',
      userCode: null,
      verificationUri: null,
      verificationUriComplete: null,
      expiresAt: '2026-07-27T00:15:00.000Z',
      nextPollAt: null,
      message: 'Sign in to AdRouter in your browser, then return here to continue.',
    });
    api.configuration.continueEnrollment.mockResolvedValue({
      state: 'pending',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://app-staging.adrouter.co/connect',
      verificationUriComplete: 'https://app-staging.adrouter.co/connect?code=ABCD-EFGH',
      expiresAt: '2026-07-27T01:00:00.000Z',
      nextPollAt: '2026-07-27T00:00:05.000Z',
      message: null,
    });
    api.projects.list.mockResolvedValue([]);
    Object.defineProperty(window, 'adrouter', { configurable: true, value: api });

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect this Agent' }));

    expect(await screen.findByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open sign-in page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy sign-in link' })).toBeInTheDocument();
    expect(screen.queryByText('ABCD-EFGH')).not.toBeInTheDocument();
    expect(screen.queryByText(/handoff=/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('AdRouter server URL')).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open approval page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy approval link' })).toBeInTheDocument();
    expect(api.configuration.continueEnrollment).toHaveBeenCalledOnce();
    expect(api.configuration.startEnrollment).toHaveBeenCalledWith({
      serverUrl: 'https://api-staging.adrouter.co',
      sponsoredCompute: true,
      displayName: 'AdRouter Agent',
    });
    expect(screen.queryByLabelText(/access token/i)).not.toBeInTheDocument();
  });

  it('warns migrated hosted-key users to approve an installation instead', async () => {
    api.configuration.get.mockResolvedValue({
      serverUrl: 'https://api-staging.adrouter.co',
      sponsoredCompute: true,
      tokenStored: true,
      configured: false,
      models: [],
      authentication: { mode: 'legacy_hosted' },
    });
    api.projects.list.mockResolvedValue([]);
    Object.defineProperty(window, 'adrouter', { configurable: true, value: api });

    render(<App />);

    expect(
      await screen.findByText(/Copied hosted API keys are no longer used/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect this Agent' })).toBeInTheDocument();
  });

  it('shows repository instruction sources and saves user project instructions', async () => {
    const project = {
      id: '11111111-1111-4111-8111-111111111111',
      path: '/tmp/project',
      displayName: 'project',
      instructions: 'Preserve compatibility.',
      repositoryInstructions: 'Run tests.',
      repositoryInstructionFiles: ['AGENTS.md'],
      permissionMode: 'workspace-write' as const,
      git: { branch: 'main', changeCount: 0, isDirty: false, remote: null },
      createdAt: '2026-07-11T12:00:00.000Z',
      updatedAt: '2026-07-11T12:00:00.000Z',
    };
    api.configuration.get.mockResolvedValue({
      serverUrl: 'https://router.example',
      sponsoredCompute: true,
      tokenStored: true,
      configured: true,
      models: ['deepseek-v4-flash'],
    });
    api.configuration.status.mockResolvedValue({
      health: true,
      authenticated: true,
      mode: 'live',
      models: [
        {
          id: 'deepseek-v4-flash',
          provider: 'deepseek',
          modelClass: 'flash',
          displayName: 'DeepSeek V4 Flash',
          providerLabel: 'DeepSeek',
          description: 'Fast general-purpose coding model.',
          thinkingLevels: ['none', 'medium', 'high'],
          defaultThinkingLevel: 'medium',
          contextWindow: 131_072,
          maxInputTokens: 126_976,
          maxOutputTokens: 4_096,
          configured: true,
        },
      ],
      catalog: {
        schemaVersion: 1,
        digest: `sha256:${'a'.repeat(64)}`,
        source: 'live',
        freshness: 'fresh',
        compatibility: 'compatible',
        lastValidatedAt: '2026-07-12T00:00:00.000Z',
        lastAttemptAt: '2026-07-12T00:00:00.000Z',
        errorCode: null,
      },
      modelsStale: false,
      checkedAt: '2026-07-12T00:00:00.000Z',
      error: null,
    });
    api.projects.list.mockResolvedValue([project]);
    api.projects.update.mockImplementation(async (input) => ({ ...project, ...input }));
    api.threads.list.mockResolvedValue([]);
    Object.defineProperty(window, 'adrouter', { configurable: true, value: api });

    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Connected' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'About AdRouter Agent' })).toBeInTheDocument();
    expect(screen.getByText('darwin · arm64')).toBeInTheDocument();
    expect(screen.getByText('compatible · live/fresh')).toBeInTheDocument();
    const modelsDisclosure = screen.getByText('Available models').closest('details');
    expect(modelsDisclosure).not.toHaveAttribute('open');
    await userEvent.click(screen.getByText('Available models'));
    expect(screen.getByText('DeepSeek V4 Flash')).toBeInTheDocument();
    const instructionsDisclosure = screen.getByText('Custom instructions').closest('details');
    expect(instructionsDisclosure).not.toHaveAttribute('open');
    await userEvent.click(screen.getByText('Custom instructions'));
    const editor = await screen.findByRole('textbox', { name: 'Project instructions' });
    await waitFor(() => expect(editor).toHaveValue('Preserve compatibility.'));
    expect(screen.getByText('Repository files loaded: AGENTS.md')).toBeInTheDocument();
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Keep routes stable.');
    await userEvent.click(screen.getByRole('button', { name: 'Save instructions' }));

    expect(api.projects.update).toHaveBeenCalledWith({
      id: project.id,
      instructions: 'Keep routes stable.',
    });
    expect(screen.queryByLabelText('Permission')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
  });

  it('signs out locally and returns to prefilled credential onboarding', async () => {
    api.configuration.get.mockResolvedValue({
      serverUrl: 'https://router.example',
      sponsoredCompute: false,
      tokenStored: true,
      configured: true,
      models: [],
      selectedModel: null,
      selectedThinkingLevel: 'medium',
      lastCheckedAt: null,
    });
    api.configuration.status.mockResolvedValue({
      health: true,
      authenticated: true,
      mode: 'live',
      models: [],
      modelsStale: false,
      checkedAt: '2026-07-26T00:00:00.000Z',
      error: null,
    });
    api.configuration.signOut.mockResolvedValue({
      configuration: {
        serverUrl: 'https://router.example',
        sponsoredCompute: false,
        tokenStored: false,
        configured: false,
        models: [],
        selectedModel: null,
        selectedThinkingLevel: 'medium',
        lastCheckedAt: null,
      },
      remoteRevocationConfirmed: false,
    });
    api.projects.list.mockResolvedValue([]);
    Object.defineProperty(window, 'adrouter', { configurable: true, value: api });

    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const signOutButton = await screen.findByRole('button', { name: 'Sign out' });
    expect(signOutButton).toHaveClass('settings-sign-out-button');
    await userEvent.click(signOutButton);
    expect(screen.getByRole('dialog')).toHaveTextContent('try to revoke this installation');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out and remove' }));

    expect(await screen.findByRole('heading', { name: 'Connect AdRouter' })).toBeInTheDocument();
    expect(screen.getByLabelText('AdRouter server URL')).toHaveValue('https://router.example');
    expect(screen.getByLabelText('Enable sponsored compute')).not.toBeChecked();
    expect(api.configuration.signOut).toHaveBeenCalledOnce();
  });

  it('renders compact activity and every tier in its turn-scoped placement', async () => {
    const project = {
      id: '11111111-1111-4111-8111-111111111111',
      path: '/tmp/project',
      displayName: 'project',
      instructions: '',
      repositoryInstructions: '',
      repositoryInstructionFiles: [],
      permissionMode: 'workspace-write' as const,
      git: null,
      createdAt: '2026-07-11T12:00:00.000Z',
      updatedAt: '2026-07-11T12:00:00.000Z',
    };
    const thread = {
      id: '22222222-2222-4222-8222-222222222222',
      projectId: project.id,
      title: 'Tier fixture',
      model: 'fixture-model',
      thinkingLevel: 'medium' as const,
      status: 'running' as const,
      archivedAt: null,
      createdAt: '2026-07-11T12:00:00.000Z',
      updatedAt: '2026-07-11T12:00:00.000Z',
    };
    const turnIds = [
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000003',
      '30000000-0000-4000-8000-000000000004',
    ];
    const tiers = ['A', 'B', 'NONE', 'C'] as const;
    const sponsor = (tier: (typeof tiers)[number], index: number) => ({
      routerTurnId: `router-${tier}`,
      tier,
      sponsorName: tier === 'NONE' ? null : `${tier} Sponsor`,
      headline: tier === 'NONE' ? 'Sensitive request' : `${tier} headline`,
      body: tier === 'NONE' ? null : `${tier} sponsor copy`,
      url: tier === 'NONE' ? null : `https://example.com/${tier.toLowerCase()}`,
      reason: tier === 'NONE' ? 'Sensitive request' : 'Relevant sponsor',
      provisionalSavings: index / 100,
      subsidyPercent: tier === 'A' ? 100 : tier === 'B' ? 40 : tier === 'C' ? 5 : 0,
    });
    let sequence = 0;
    const events: Array<Record<string, unknown>> = [];
    const push = (turnId: string, type: string, payload: Record<string, unknown>) => {
      sequence += 1;
      events.push({
        id: `${sequence.toString().padStart(8, '0')}-0000-4000-8000-000000000000`,
        threadId: thread.id,
        turnId,
        sequence,
        type,
        timestamp: '2026-07-11T12:00:00.000Z',
        payload,
      });
    };
    for (const [index, tier] of tiers.entries()) {
      const turnId = turnIds[index];
      if (!turnId) throw new Error(`Missing fixture turn for ${tier}.`);
      const ad = sponsor(tier, index + 1);
      push(turnId, 'message.user', { text: `Prompt ${tier}` });
      push(turnId, 'sponsor.update', ad);
      if (tier === 'A') {
        push(turnId, 'tool.activity', {
          name: 'read_file',
          state: 'started',
          toolCallId: 'read-1',
          args: { path: 'a.ts' },
        });
        push(turnId, 'tool.result', {
          name: 'read_file',
          toolCallId: 'read-1',
          output: '{}',
          isError: false,
        });
        push(turnId, 'tool.activity', {
          name: 'read_file',
          state: 'started',
          toolCallId: 'read-2',
          args: { path: 'b.ts' },
        });
      }
      if (tier === 'C') {
        push(turnId, 'thinking.delta', { text: 'Inspecting ' });
        push(turnId, 'thinking.delta', { text: 'the project continuously.' });
      } else {
        push(turnId, 'message.delta', { text: `Answer ${tier}` });
        push(turnId, 'settlement', {
          routerTurnId: ad.routerTurnId,
          cost: 0.02,
          subsidy: 0.01,
          paid: 0.01,
          sponsor: ad,
        });
        push(turnId, 'message.complete', { text: `Answer ${tier}` });
      }
    }

    api.configuration.get.mockResolvedValue({
      serverUrl: 'https://router.example',
      sponsoredCompute: true,
      tokenStored: true,
      configured: true,
      models: ['fixture-model'],
    });
    api.projects.list.mockResolvedValue([project]);
    api.threads.list.mockResolvedValue([thread]);
    const approval = {
      id: '40000000-0000-4000-8000-000000000001',
      threadId: thread.id,
      turnId: turnIds[3],
      kind: 'command' as const,
      argv: ['npm', 'test'],
      path: null,
      cwd: '/tmp/project',
      risk: 'medium' as const,
      reason: 'Run the project tests',
      decision: null,
      createdAt: '2026-07-11T12:00:00.000Z',
      resolvedAt: null,
    };
    const detail = {
      thread,
      turns: turnIds.map((id, index) => ({
        id,
        threadId: thread.id,
        input: `Prompt ${tiers[index]}`,
        status: index === 3 ? 'running' : 'completed',
        error: null,
        createdAt: '2026-07-11T12:00:00.000Z',
        startedAt: '2026-07-11T12:00:00.000Z',
        finishedAt: index === 3 ? null : '2026-07-11T12:00:01.000Z',
      })),
      events,
      approvals: [approval],
    };
    api.threads.get.mockResolvedValueOnce(detail).mockResolvedValue({
      ...detail,
      approvals: [],
    });
    api.approvals.resolve.mockResolvedValue({ ok: true });
    api.review.getDiff.mockResolvedValue([]);
    let emitEvent: ((event: (typeof events)[number]) => void) | undefined;
    api.events.subscribe.mockImplementation(async (_input, callback) => {
      emitEvent = callback;
      return 'subscription-id';
    });
    api.events.unsubscribe.mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'adrouter', { configurable: true, value: api });

    render(<App />);

    expect(await screen.findByText('Read × 2')).toBeInTheDocument();
    expect(screen.getByText('Inspecting the project continuously.')).toBeInTheDocument();
    expect(screen.getByLabelText('Sponsored compute tier A')).toBeInTheDocument();
    const tierB = screen.getByLabelText('Sponsored compute tier B');
    expect(tierB).toBeInTheDocument();
    expect(screen.getByText('Sensitive request')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Sponsored compute tier C')).toHaveLength(1);
    const completedEvent = {
      id: '99999999-0000-4000-8000-000000000000',
      threadId: thread.id,
      turnId: turnIds[3],
      sequence: sequence + 1,
      type: 'message.complete',
      timestamp: '2026-07-11T12:00:01.000Z',
      payload: { text: 'Answer C' },
    };
    await waitFor(() => expect(emitEvent).toBeTypeOf('function'));
    act(() => emitEvent?.(completedEvent));
    await waitFor(() =>
      expect(screen.getAllByLabelText('Sponsored compute tier C')).toHaveLength(2)
    );
    expect(screen.getAllByText(/Sponsored compute · 1 round/)).toHaveLength(3);
    const sponsorPanel = screen
      .getByRole('button', { name: 'Dismiss sponsored banner' })
      .closest('.composer-panel');
    const approvalPanel = screen
      .getByRole('heading', { name: 'Run command' })
      .closest('.composer-panel');
    expect(sponsorPanel?.nextElementSibling).toBe(approvalPanel);

    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(approvalPanel).toHaveAttribute('data-state', 'closed'));
    if (approvalPanel)
      fireEvent.transitionEnd(approvalPanel, { propertyName: 'grid-template-rows' });
    expect(screen.queryByRole('heading', { name: 'Run command' })).not.toBeInTheDocument();

    const closeSponsor = screen.getByRole('button', { name: 'Dismiss sponsored banner' });
    const closingSponsorPanel = closeSponsor.closest('.composer-panel');
    await userEvent.click(closeSponsor);
    await waitFor(() => expect(closingSponsorPanel).toHaveAttribute('data-state', 'closed'));
    if (closingSponsorPanel) {
      fireEvent.transitionEnd(closingSponsorPanel, { propertyName: 'grid-template-rows' });
    }
    expect(screen.getAllByLabelText('Sponsored compute tier C')).toHaveLength(1);

    await userEvent.click(within(tierB).getByRole('button', { name: 'Hide sponsored' }));
    expect(screen.queryByLabelText('Sponsored compute tier B')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show sponsored suggestion' }));
    expect(screen.getByLabelText('Sponsored compute tier B')).toBeInTheDocument();
  });

  it('uses composer preferences, sends with Enter, preserves Shift+Enter, and permanently deletes chats', async () => {
    const project = {
      id: '11111111-1111-4111-8111-111111111111',
      path: '/tmp/project',
      displayName: 'project',
      instructions: '',
      repositoryInstructions: '',
      repositoryInstructionFiles: [],
      permissionMode: 'workspace-write' as const,
      git: null,
      createdAt: '2026-07-11T12:00:00.000Z',
      updatedAt: '2026-07-11T12:00:00.000Z',
    };
    const thread = {
      id: '22222222-2222-4222-8222-222222222222',
      projectId: project.id,
      title: 'Delete me',
      model: 'model-pro',
      thinkingLevel: 'high' as const,
      status: 'idle' as const,
      archivedAt: null,
      createdAt: '2026-07-11T12:00:00.000Z',
      updatedAt: '2026-07-11T12:00:00.000Z',
    };
    const models = [
      {
        id: 'model-flash',
        provider: 'router',
        modelClass: 'flash' as const,
        displayName: 'Model Flash',
        providerLabel: 'Router',
        description: 'Fast fixture model.',
        thinkingLevels: ['none', 'medium'] as const,
        defaultThinkingLevel: 'medium' as const,
        contextWindow: 131_072,
        maxInputTokens: 126_976,
        maxOutputTokens: 4_096,
        configured: true,
      },
      {
        id: 'model-pro',
        provider: 'router',
        modelClass: 'pro' as const,
        displayName: 'Model Pro',
        providerLabel: 'Router',
        description: 'Pro fixture model.',
        thinkingLevels: ['medium', 'high'] as const,
        defaultThinkingLevel: 'high' as const,
        contextWindow: 131_072,
        maxInputTokens: 126_976,
        maxOutputTokens: 4_096,
        configured: true,
      },
    ];
    api.configuration.get.mockResolvedValue({
      serverUrl: 'https://router.example',
      sponsoredCompute: true,
      tokenStored: true,
      configured: true,
      models,
      selectedModel: 'model-flash',
      selectedThinkingLevel: 'medium',
      lastCheckedAt: null,
    });
    api.configuration.status.mockResolvedValue({
      health: true,
      authenticated: true,
      mode: 'live',
      models,
      modelsStale: false,
      checkedAt: '2026-07-12T00:00:00.000Z',
      error: null,
    });
    api.configuration.updatePreferences.mockResolvedValue({});
    api.projects.list.mockResolvedValue([project]);
    api.threads.list.mockResolvedValueOnce([]).mockResolvedValue([thread]);
    api.threads.create.mockResolvedValue(thread);
    api.threads.get.mockResolvedValue({ thread, turns: [], events: [], approvals: [] });
    api.turns.start.mockResolvedValue({});
    api.review.getDiff.mockResolvedValue([]);
    api.events.subscribe.mockResolvedValue('subscription-id');
    api.events.unsubscribe.mockResolvedValue({ ok: true });
    api.threads.delete.mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'adrouter', { configurable: true, value: api });

    const user = userEvent.setup();
    render(<App />);
    const composer = await screen.findByRole('textbox', { name: 'Task message' });
    await user.click(
      screen.getByRole('button', { name: /Explain this codebase and its architecture/ })
    );
    expect(composer).toHaveValue('Explain this codebase and its architecture');
    expect(api.turns.start).not.toHaveBeenCalled();
    await user.clear(composer);
    await user.selectOptions(screen.getByLabelText('Router model'), 'model-pro');
    await waitFor(() =>
      expect(api.configuration.updatePreferences).toHaveBeenCalledWith({
        model: 'model-pro',
        thinkingLevel: 'high',
      })
    );
    await user.type(composer, 'First line{shift>}{enter}{/shift}second line');
    expect(composer).toHaveValue('First line\nsecond line');
    await user.type(composer, '{enter}');
    await waitFor(() =>
      expect(api.turns.start).toHaveBeenCalledWith({
        threadId: thread.id,
        input: 'First line\nsecond line',
        model: 'model-pro',
        thinkingLevel: 'high',
        runtimeMode: 'auto',
      })
    );

    await user.click(screen.getByRole('button', { name: 'History' }));
    await waitFor(() =>
      expect(screen.getByLabelText('history drawer')).toHaveAttribute('data-state', 'open')
    );
    expect(screen.getByLabelText('history drawer')).toHaveAttribute('data-side', 'left');
    await user.click(await screen.findByRole('button', { name: 'Delete Delete me' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(api.threads.delete).toHaveBeenCalledWith({ id: thread.id }));

    await user.click(screen.getByRole('button', { name: 'History' }));
    const closingDrawer = screen.getByLabelText('history drawer');
    await waitFor(() => expect(closingDrawer).toHaveAttribute('data-state', 'closed'));
    fireEvent.transitionEnd(closingDrawer, { propertyName: 'transform' });
    expect(screen.queryByLabelText('history drawer')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await waitFor(() =>
      expect(screen.getByLabelText('settings drawer')).toHaveAttribute('data-state', 'open')
    );
    expect(screen.getByLabelText('settings drawer')).toHaveAttribute('data-side', 'right');
  });
});
