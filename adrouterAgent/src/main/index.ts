import { join } from 'node:path';
import { app, BrowserWindow, session, shell } from 'electron';
import { isSafeExternalUrl } from '../shared/security';
import { registerAppProtocol, rendererUrl } from './app-protocol';
import { runAutomationKeyHelper } from './automation-key-helper';
import { BundleService } from './bundle-service';
import { ConfigurationStore } from './configuration-store';
import { AppDatabase } from './database';
import { GitWorkflowService } from './git-workflow-service';
import { InstallationAuthManager } from './installation-auth';
import { type EventSubscriptions, registerIpcHandlers } from './ipc';
import { LocalRpcServer } from './local-rpc-server';
import { RepositoryService } from './repository-service';
import { ReviewService } from './review-service';
import { RuntimeSupervisor } from './runtime-supervisor';
import { SessionService } from './session-service';
import { SignedUpdateService } from './signed-update-service';
import { TaskService } from './task-service';
import { writeLauncherHealthMarker } from './update-health';

app.setName('AdRouter Agent');

let database: AppDatabase | undefined;
let installationAuth: InstallationAuthManager | undefined;
let localRpc: LocalRpcServer | undefined;
let shutdownComplete = false;
let shutdownStarted = false;

const createMainWindow = (onReady?: () => Promise<void>): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1_480,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#fffff0',
    show: false,
    ...(process.platform === 'linux'
      ? { icon: join(__dirname, '..', '..', 'assets', 'icon.png') }
      : {}),
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.setMenuBarVisibility(false);
  window.once('ready-to-show', () => {
    window.show();
    if (onReady) {
      void onReady().catch(() => {
        console.error('AdRouter Agent failed its launcher healthy-start acknowledgement.');
        app.quit();
      });
    }
  });
  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== rendererUrl) {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      setImmediate(() => void shell.openExternal(url));
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  if (app.isPackaged) {
    window.webContents.on('devtools-opened', () => window.webContents.closeDevTools());
  }
  void window.loadURL(rendererUrl);
  return window;
};

const initializeApplication = async (): Promise<void> => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  const rendererRoot = join(__dirname, '..', 'renderer', MAIN_WINDOW_VITE_NAME);
  registerAppProtocol(rendererRoot);

  const userData = app.getPath('userData');
  const configuration = new ConfigurationStore(join(userData, 'configuration.json'));
  installationAuth = new InstallationAuthManager(configuration, app.getVersion());
  if (process.argv.includes('--installation-auth-smoke')) {
    const diagnostics = await installationAuth.diagnostics();
    process.stdout.write(
      `${JSON.stringify({
        schema: 1,
        authenticated: diagnostics.authenticated,
        modelCount: diagnostics.models.length,
        authentication: {
          mode: diagnostics.authentication.mode,
          state: diagnostics.authentication.state,
          storageClassification: diagnostics.authentication.storageClassification,
          signedRequestSupport: diagnostics.authentication.signedRequestSupport,
          refreshHealthy: diagnostics.authentication.refreshHealthy,
          reconnectRequired: diagnostics.authentication.reconnectRequired,
        },
      })}\n`
    );
    app.exit(diagnostics.authenticated ? 0 : 1);
    return;
  }
  database = new AppDatabase(join(userData, 'adrouter.sqlite'));
  database.recoverInterruptedRuns();
  const repositories = new RepositoryService(database);
  const review = new ReviewService(database);
  const bundles = new BundleService(database, app.getVersion());
  let subscriptions: EventSubscriptions | undefined;
  const supervisor = new RuntimeSupervisor(
    database,
    join(__dirname, 'runtime.js'),
    (event) => subscriptions?.publish(event),
    installationAuth,
    undefined,
    undefined,
    bundles
  );
  const tasks = new TaskService(database, configuration, supervisor, (event) =>
    subscriptions?.publish(event)
  );
  supervisor.setDelegationHandler((manifest) => tasks.startDelegated(manifest));
  const sessions = new SessionService(database);
  const signedUpdates = new SignedUpdateService(app.getVersion());
  const gitWorkflows = new GitWorkflowService(
    database,
    (event) => subscriptions?.publish(event),
    () => supervisor.hasTasks
  );
  localRpc = new LocalRpcServer({
    database,
    tasks,
    supervisor,
    sessions,
    userDataPath: userData,
    appVersion: app.getVersion(),
    diagnostics: async () => ({
      ...(await installationAuth?.diagnostics()),
      signedUpdates: signedUpdates.diagnostics(),
    }),
  });
  await localRpc.start();
  subscriptions = registerIpcHandlers({
    database,
    configuration,
    repositories,
    review,
    supervisor,
    installationAuth,
    bundles,
    tasks,
    automation: localRpc,
    sessions,
    gitWorkflows,
  });

  createMainWindow(() => writeLauncherHealthMarker(app.getVersion()).then(() => undefined));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
};

const automationKeyHelperMode = process.argv.includes('--automation-key-helper');

void app
  .whenReady()
  .then(() =>
    automationKeyHelperMode
      ? runAutomationKeyHelper(app.getPath('userData')).finally(() =>
          app.exit(typeof process.exitCode === 'number' ? process.exitCode : 1)
        )
      : initializeApplication()
  )
  .catch((error: unknown) => {
    if (automationKeyHelperMode) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: 'Key-helper startup failed.' })}\n`
      );
    } else {
      console.error('AdRouter Agent failed to initialize.', error);
    }
    app.exit(1);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (automationKeyHelperMode || shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void (async () => {
    await localRpc?.close();
    localRpc = undefined;
    installationAuth?.dispose();
    installationAuth = undefined;
    database?.close();
    database = undefined;
    shutdownComplete = true;
    app.quit();
  })();
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
