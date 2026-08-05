import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getWindowsSandboxUserStatus,
  parseWindowsBinShell,
  SandboxManager,
} from '@anthropic-ai/sandbox-runtime';

export type SandboxReadinessStatus = 'ready' | 'setup-required' | 'unsupported';

export interface SandboxReadiness {
  status: SandboxReadinessStatus;
  detail: string;
  setupCommands: string[];
}

const WINDOWS_SETUP_COMMAND = 'npx @anthropic-ai/sandbox-runtime@0.0.65 windows-install';
const SANDBOX_RUNTIME_ROOT = dirname(
  dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime')))
);

const ubuntuRestrictsUserNamespaces = (): boolean => {
  const path = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
  try {
    return existsSync(path) && readFileSync(path, 'utf8').trim() === '1';
  } catch {
    return false;
  }
};

export const sandboxReadiness = (
  platform: NodeJS.Platform = process.platform
): SandboxReadiness => {
  if (!['darwin', 'linux', 'win32'].includes(platform)) {
    return {
      status: 'unsupported',
      detail: `Command sandboxing is not supported on ${platform}.`,
      setupCommands: [],
    };
  }
  if (platform !== process.platform) {
    return platform === 'win32'
      ? {
          status: 'setup-required',
          detail: 'Windows command sandboxing requires one-time administrator provisioning.',
          setupCommands: [WINDOWS_SETUP_COMMAND],
        }
      : {
          status: 'ready',
          detail: 'Sandbox prerequisites must be verified on the target operating system.',
          setupCommands: [],
        };
  }
  if (!SandboxManager.isSupportedPlatform()) {
    return {
      status: 'unsupported',
      detail: 'The sandbox runtime does not support this host configuration.',
      setupCommands: [],
    };
  }
  if (platform === 'linux') {
    const dependencyCheck = SandboxManager.checkDependencies();
    if (dependencyCheck.errors.length > 0) {
      return {
        status: 'setup-required',
        detail: `Linux sandbox prerequisites are missing: ${dependencyCheck.errors.join('; ')}`,
        setupCommands: ['sudo apt-get install bubblewrap socat ripgrep'],
      };
    }
    const appArmorProfile = '/etc/apparmor.d/adrouter-agent-bwrap';
    if (ubuntuRestrictsUserNamespaces() && !existsSync(appArmorProfile)) {
      return {
        status: 'setup-required',
        detail:
          'Ubuntu AppArmor restricts Bubblewrap user namespaces and the AdRouter profile is not installed.',
        setupCommands: ['sudo apparmor_parser -r /etc/apparmor.d/adrouter-agent-bwrap'],
      };
    }
  }
  if (platform === 'win32') {
    try {
      const state = getWindowsSandboxUserStatus();
      if (!state.provisioned || !state.groupExists || !state.inSandboxGroup || !state.credPresent) {
        return {
          status: 'setup-required',
          detail: 'The dedicated Windows sandbox account or its credential is not provisioned.',
          setupCommands: [WINDOWS_SETUP_COMMAND],
        };
      }
    } catch (error) {
      return {
        status: 'setup-required',
        detail: `Windows sandbox setup could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        setupCommands: [WINDOWS_SETUP_COMMAND],
      };
    }
  }
  return {
    status: 'ready',
    detail: 'Operating-system command sandboxing is available.',
    setupCommands: [],
  };
};

const posixQuote = (part: string): string => `'${part.replaceAll("'", "'\\''")}'`;
const powershellQuote = (part: string): string => `'${part.replaceAll("'", "''")}'`;

export const serializeSandboxCommand = (
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform
): string =>
  platform === 'win32'
    ? `& ${argv.map(powershellQuote).join(' ')}`
    : argv.map(posixQuote).join(' ');

export const sandboxBinShell = (platform: NodeJS.Platform = process.platform) =>
  platform === 'win32' ? parseWindowsBinShell('powershell') : undefined;

export const sandboxPathEntries = (
  _temporaryHome: string,
  workspaceRoot: string | undefined,
  platform: NodeJS.Platform = process.platform,
  sourceEnvironment: NodeJS.ProcessEnv = process.env
): string[] => {
  const workspaceBins = workspaceRoot ? join(workspaceRoot, 'node_modules', '.bin') : undefined;
  if (platform === 'win32') {
    return [
      workspaceBins,
      sourceEnvironment.SystemRoot
        ? win32.join(sourceEnvironment.SystemRoot, 'System32')
        : undefined,
      ...(sourceEnvironment.PATH?.split(';') ?? []),
    ].filter((entry): entry is string => Boolean(entry));
  }
  return [
    workspaceBins,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter((entry): entry is string => Boolean(entry));
};

export const runtimeReadPaths = (
  workspaceRoot: string,
  temporaryHome: string,
  platform: NodeJS.Platform = process.platform
): string[] => {
  if (platform === 'win32') {
    return [workspaceRoot, temporaryHome, process.env.SystemRoot, dirname(process.execPath)].filter(
      (entry): entry is string => Boolean(entry)
    );
  }
  const common = [
    workspaceRoot,
    temporaryHome,
    // Linux seccomp execution uses a trusted native helper shipped with this
    // package. Keep that dependency readable when the rest of / is denied.
    SANDBOX_RUNTIME_ROOT,
    '/usr',
    '/bin',
    '/sbin',
    dirname(dirname(process.execPath)),
  ];
  return platform === 'darwin'
    ? [...common, '/System', '/Library']
    : [...common, '/lib', '/lib64', '/etc'];
};
