import type { Dirent } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import {
  runtimeReadPaths,
  sandboxBinShell,
  sandboxPathEntries,
  sandboxReadiness,
  serializeSandboxCommand,
} from './platform';
import { isProtectedPath } from './workspace';

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

const SECRET_ENVIRONMENT =
  /(?:token|secret|password|credential|api[_-]?key|auth|aws|github|npm_config)/i;

export const shellQuote = serializeSandboxCommand;

export const sanitizedEnvironment = (
  temporaryHome: string,
  workspaceRoot?: string,
  platform: NodeJS.Platform = process.platform,
  sourceEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv =>
  ({
    ...Object.fromEntries(
      Object.entries(sourceEnvironment).filter(
        ([key, value]) => !SECRET_ENVIRONMENT.test(key) && value !== undefined
      )
    ),
    HOME: temporaryHome,
    TMPDIR: temporaryHome,
    ...(platform === 'win32'
      ? { USERPROFILE: temporaryHome, TEMP: temporaryHome, TMP: temporaryHome }
      : {}),
    PATH: sandboxPathEntries(temporaryHome, workspaceRoot, platform, sourceEnvironment).join(
      platform === 'win32' ? ';' : ':'
    ),
  }) as NodeJS.ProcessEnv;

export const buildSandboxConfig = (
  workspaceRoot: string,
  temporaryHome: string,
  workspaceWriteAllowed = true,
  protectedReadPaths: readonly string[] = defaultProtectedPaths(workspaceRoot),
  platform: NodeJS.Platform = process.platform
): SandboxRuntimeConfig => ({
  network: {
    allowedDomains: [],
    deniedDomains: ['*'],
    strictAllowlist: true,
    allowLocalBinding: false,
  },
  filesystem: {
    // sandbox-runtime reads are allow-by-default. Denying / first makes the
    // workspace and the explicitly listed runtime paths the only readable
    // regions; literal protected paths are re-denied after the workspace
    // allow rule by the macOS Seatbelt profile generator.
    allowRead: runtimeReadPaths(workspaceRoot, temporaryHome, platform),
    denyRead: platform === 'win32' ? [...protectedReadPaths] : ['/', ...protectedReadPaths],
    allowWrite: workspaceWriteAllowed ? [workspaceRoot, temporaryHome] : [temporaryHome],
    denyWrite: [...protectedReadPaths],
    allowGitConfig: false,
  },
  credentials: {
    envVars: Object.keys(process.env)
      .filter((key) => SECRET_ENVIRONMENT.test(key))
      .map((name) => ({ name, mode: 'deny' as const })),
  },
});

const defaultProtectedPaths = (workspaceRoot: string): string[] => [
  resolve(workspaceRoot, '.git'),
  resolve(workspaceRoot, '.ssh'),
  resolve(workspaceRoot, '.aws'),
  resolve(workspaceRoot, '.env'),
];

const MAX_DISCOVERED_PROTECTED_PATHS = 1_024;

const discoverProtectedPaths = async (workspaceRoot: string): Promise<string[]> => {
  const discovered = new Set(defaultProtectedPaths(workspaceRoot));
  const walk = async (directory: string): Promise<void> => {
    if (discovered.size >= MAX_DISCOVERED_PROTECTED_PATHS) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (discovered.size >= MAX_DISCOVERED_PROTECTED_PATHS || entry.isSymbolicLink()) {
        continue;
      }
      const absolute = join(directory, entry.name);
      const fromRoot = relative(workspaceRoot, absolute).replaceAll('\\', '/');
      if (isProtectedPath(fromRoot)) {
        discovered.add(absolute);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
      }
    }
  };

  await walk(workspaceRoot);
  return [...discovered];
};

export interface WrappedSandboxCommand {
  argv: string[];
  env: NodeJS.ProcessEnv;
  temporaryHome: string;
}

export class CommandSandbox {
  private initializedFor?: string;
  private readonly temporaryHome = join(tmpdir(), `adrouter-agent-${process.pid}`);

  public async wrap(
    workspaceRoot: string,
    argv: readonly string[],
    signal?: AbortSignal,
    workspaceWriteAllowed = false
  ): Promise<WrappedSandboxCommand> {
    const readiness = sandboxReadiness();
    if (readiness.status !== 'ready') {
      throw new SandboxUnavailableError(
        `${readiness.detail}${readiness.setupCommands.length > 0 ? ` Setup: ${readiness.setupCommands.join(' ; ')}` : ''}`
      );
    }

    await mkdir(this.temporaryHome, { recursive: true, mode: 0o700 });
    const sessionKey = `${workspaceRoot}:${workspaceWriteAllowed ? 'write' : 'read'}`;
    if (this.initializedFor !== sessionKey) {
      try {
        if (this.initializedFor) {
          await SandboxManager.reset();
        }
        const protectedReadPaths = await discoverProtectedPaths(workspaceRoot);
        await SandboxManager.initialize(
          buildSandboxConfig(
            workspaceRoot,
            this.temporaryHome,
            workspaceWriteAllowed,
            protectedReadPaths
          )
        );
      } catch (error) {
        throw new SandboxUnavailableError(
          `The operating-system sandbox could not be initialized: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      this.initializedFor = sessionKey;
    }

    if (!SandboxManager.isSandboxingEnabled()) {
      throw new SandboxUnavailableError(
        'The operating-system sandbox is unavailable; commands remain disabled.'
      );
    }

    try {
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        shellQuote(argv),
        sandboxBinShell(),
        undefined,
        signal,
        workspaceRoot
      );
      return {
        argv: wrapped.argv,
        env: {
          ...sanitizedEnvironment(this.temporaryHome, workspaceRoot),
          ...wrapped.env,
          HOME: this.temporaryHome,
          TMPDIR: this.temporaryHome,
        },
        temporaryHome: this.temporaryHome,
      };
    } catch (error) {
      throw new SandboxUnavailableError(
        `The command could not be wrapped by the sandbox: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async reset(): Promise<void> {
    this.initializedFor = undefined;
    await SandboxManager.reset();
    await rm(this.temporaryHome, { recursive: true, force: true });
  }
}
