import { type ChildProcess, spawn } from 'node:child_process';
import { CommandSandbox, SandboxUnavailableError } from './sandbox';

const OUTPUT_LIMIT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_TIMEOUT_MS = 15 * 60 * 1_000;

export interface CommandOutputChunk {
  stream: 'stdout' | 'stderr';
  chunk: string;
}

export interface CommandRunOptions {
  argv: string[];
  cwd: string;
  workspaceWriteAllowed: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: CommandOutputChunk) => void;
}

export interface CommandRunResult {
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

const appendCapped = (
  previous: string,
  chunk: Buffer,
  cap: number
): { value: string; truncated: boolean; output: string } => {
  const allowed = Math.max(0, cap - Buffer.byteLength(previous, 'utf8'));
  const output = chunk.subarray(0, allowed).toString('utf8');
  return {
    value: previous + output,
    truncated: chunk.length > allowed,
    output,
  };
};

const terminateProcessTree = (child: ChildProcess): void => {
  const processId = child.pid;
  if (processId && process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(processId), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  if (processId && process.platform !== 'win32') {
    try {
      process.kill(-processId, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(-processId, 'SIGKILL');
        } catch {
          // The process ended between signals.
        }
      }, 2_000).unref();
      return;
    } catch {
      // Fall through to process-local termination.
    }
  }
  child.kill('SIGTERM');
};

export class SandboxedCommandRunner {
  public constructor(private readonly sandbox = new CommandSandbox()) {}

  public async run(options: CommandRunOptions): Promise<CommandRunResult> {
    const timeoutMs = Math.min(
      Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1),
      MAX_TIMEOUT_MS
    );
    const startedAt = Date.now();
    let wrapped: Awaited<ReturnType<CommandSandbox['wrap']>>;
    try {
      wrapped = await this.sandbox.wrap(
        options.cwd,
        options.argv,
        options.signal,
        options.workspaceWriteAllowed
      );
    } catch (error) {
      if (error instanceof SandboxUnavailableError) {
        throw error;
      }
      throw new SandboxUnavailableError(String(error));
    }

    return await new Promise<CommandRunResult>((resolveRun, rejectRun) => {
      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let cancelled = Boolean(options.signal?.aborted);
      let settled = false;

      const executable = wrapped.argv[0];
      if (!executable) {
        rejectRun(new Error('Sandbox returned an empty command argv.'));
        return;
      }
      const child: ChildProcess = spawn(executable, wrapped.argv.slice(1), {
        cwd: options.cwd,
        detached: process.platform !== 'win32',
        env: wrapped.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const finish = (exitCode: number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
        resolveRun({
          argv: options.argv,
          exitCode,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          timedOut,
          cancelled,
          durationMs: Date.now() - startedAt,
        });
      };

      const abort = (): void => {
        cancelled = true;
        terminateProcessTree(child);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child);
      }, timeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        const appended = appendCapped(stdout, chunk, OUTPUT_LIMIT);
        stdout = appended.value;
        stdoutTruncated ||= appended.truncated;
        if (appended.output) {
          options.onOutput?.({ stream: 'stdout', chunk: appended.output });
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const appended = appendCapped(stderr, chunk, OUTPUT_LIMIT);
        stderr = appended.value;
        stderrTruncated ||= appended.truncated;
        if (appended.output) {
          options.onOutput?.({ stream: 'stderr', chunk: appended.output });
        }
      });
      child.once('error', (error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          options.signal?.removeEventListener('abort', abort);
          rejectRun(error);
        }
      });
      child.once('close', finish);
    });
  }

  public async reset(): Promise<void> {
    await this.sandbox.reset();
  }
}
