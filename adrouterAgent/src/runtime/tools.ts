import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { ApprovalDecision, OperationManifestV1, PermissionMode } from '../shared/contracts';
import { createId, now } from '../shared/security';
import { approvalAllowsCommand, classifyCommand } from './command-policy';
import type { SandboxedCommandRunner } from './command-runner';
import { createDelegationManifest } from './delegation';
import {
  createDependencyApplyManifest,
  createDependencyPreviewManifest,
  type DependencyPreviewResult,
  DependencyPreviewResultSchema,
} from './dependency-operations';
import { createGitOperationManifest, type GitWriteCapability } from './git-operations';
import { createNetworkFetchManifest } from './network-policy';
import { createRestoreManifest, createStructuredFileManifest } from './structured-files';
import { createScriptOperationManifest } from './structured-processes';
import {
  type ApplyPatchInput,
  applyWorkspacePatch,
  listWorkspaceFilesPage,
  readWorkspaceTextRange,
  searchWorkspaceTextPage,
} from './workspace';

export interface ToolApproval {
  id: string;
  version?: 1 | 2;
  kind:
    | 'command'
    | 'file-delete'
    | 'file-mutation'
    | 'structured-operation'
    | 'network-operation'
    | 'git-operation'
    | 'dependency-operation'
    | 'delegation';
  argv: string[] | null;
  path: string | null;
  cwd: string;
  risk: 'low' | 'medium' | 'high';
  reason: string;
  operationManifest?: OperationManifestV1 | null;
  expiresAt?: string | null;
}

export interface DesktopToolOptions {
  workspaceRoot: string;
  permissionMode: PermissionMode;
  threadId: string;
  turnId: string;
  commandRunner: SandboxedCommandRunner;
  allowedCommands?: readonly string[][];
  commandsEnabled?: boolean;
  delegationEnabled?: boolean;
  executeOperation?: (
    manifest: OperationManifestV1,
    signal?: AbortSignal
  ) => Promise<Record<string, unknown>>;
  requestApproval: (request: ToolApproval, signal?: AbortSignal) => Promise<ApprovalDecision>;
  emit: (
    type:
      | 'tool.activity'
      | 'tool.result'
      | 'command.output'
      | 'file.change'
      | 'diff.change'
      | 'operation.completed',
    payload: Record<string, unknown>
  ) => void;
}

type CommandToolOptions = Omit<DesktopToolOptions, 'allowedCommands'> & {
  allowedCommands?: Set<string>;
};

const errorContent = (message: string): AgentToolResult<Record<string, unknown>> => ({
  content: [{ type: 'text', text: message }],
  details: { error: message },
});

const commandTool = (
  options: CommandToolOptions,
  name: 'run_command' | 'git_status' | 'git_diff'
): AgentTool => ({
  name,
  label:
    name === 'run_command'
      ? 'Run sandboxed command'
      : name === 'git_status'
        ? 'Inspect Git status'
        : 'Inspect Git diff',
  description:
    name === 'run_command'
      ? 'Run an argv array only after policy checks in the workspace sandbox.'
      : 'Inspect Git state via the same restricted command sandbox.',
  parameters:
    name === 'run_command'
      ? Type.Object({
          argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 900_000 })),
        })
      : Type.Object({}),
  executionMode: 'sequential',
  execute: async (toolCallId, params, signal, onUpdate) => {
    const argv =
      name === 'git_status'
        ? ['git', 'status', '--short', '--branch']
        : name === 'git_diff'
          ? ['git', 'diff', '--no-ext-diff']
          : (params as { argv: string[] }).argv;
    const timeoutMs =
      name === 'run_command' ? (params as { timeoutMs?: number }).timeoutMs : undefined;
    const assessment = classifyCommand(argv);
    if (assessment.disposition === 'deny') {
      return errorContent(assessment.reason);
    }

    if (name === 'run_command') {
      const approval: ToolApproval = {
        id: createId(),
        kind: 'command',
        argv,
        path: null,
        cwd: options.workspaceRoot,
        risk: assessment.risk,
        reason: assessment.reason,
      };
      const decision = await options.requestApproval(approval, signal);
      if (decision !== 'allow-once' || !approvalAllowsCommand(decision, argv, argv)) {
        return errorContent('The requested command was denied.');
      }
    }

    const startedAt = now();
    const result = await options.commandRunner.run({
      argv,
      cwd: options.workspaceRoot,
      workspaceWriteAllowed: options.permissionMode === 'workspace-write',
      timeoutMs,
      signal,
      onOutput: (output) => {
        options.emit('command.output', {
          toolCallId,
          name,
          argv,
          stream: output.stream,
          chunk: output.chunk,
        });
        onUpdate?.({
          content: [{ type: 'text', text: output.chunk }],
          details: { stream: output.stream },
        });
      },
    });
    const completedAt = now();
    const details = {
      recordKind: 'command-completion',
      argv,
      cwd: options.workspaceRoot,
      startedAt,
      completedAt,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      status: result.cancelled
        ? 'cancelled'
        : result.timedOut || result.exitCode !== 0
          ? 'failed'
          : 'completed',
      durationMs: result.durationMs,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(details) }],
      details,
    };
  },
});

export const createDesktopTools = (options: DesktopToolOptions): AgentTool[] => {
  const allowedCommands = new Set(
    (options.allowedCommands ?? []).map((argv) => JSON.stringify(argv))
  );
  const withAllowed: CommandToolOptions = { ...options, allowedCommands };
  const dependencyPreviews = new Map<string, DependencyPreviewResult>();

  const listFiles: AgentTool = {
    name: 'list_files',
    label: 'List workspace files',
    description:
      'List a bounded page of non-protected workspace files with optional glob filtering and Git-ignore awareness.',
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      glob: Type.Optional(Type.String({ maxLength: 256 })),
      cursor: Type.Optional(Type.String({ maxLength: 8 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      respectGitIgnore: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const input = params as {
          path?: string;
          glob?: string;
          cursor?: string;
          limit?: number;
          respectGitIgnore?: boolean;
        };
        const page = await listWorkspaceFilesPage(options.workspaceRoot, input);
        const result = { files: page.items, ...page, items: undefined };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return errorContent(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const readFile: AgentTool = {
    name: 'read_file',
    label: 'Read workspace file',
    description:
      'Read a bounded line range from a safe text file and return its content with a hash.',
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 * 1024 })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const input = params as {
          path: string;
          startLine?: number;
          maxLines?: number;
          maxBytes?: number;
        };
        const file = await readWorkspaceTextRange(options.workspaceRoot, input.path, input);
        const result = {
          path: file.path.relative,
          hash: file.hash,
          size: file.size,
          content: file.content,
          startLine: file.startLine,
          endLine: file.endLine,
          totalLines: file.totalLines,
          truncated: file.truncated,
        };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return errorContent(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const searchText: AgentTool = {
    name: 'search_text',
    label: 'Search workspace text',
    description:
      'Search a bounded set of safe workspace text files using a literal or terminable regular expression.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      path: Type.Optional(Type.String()),
      regex: Type.Optional(Type.Boolean()),
      caseSensitive: Type.Optional(Type.Boolean()),
      glob: Type.Optional(Type.String({ maxLength: 256 })),
      cursor: Type.Optional(Type.String({ maxLength: 8 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      respectGitIgnore: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const input = params as {
          query: string;
          path?: string;
          regex?: boolean;
          caseSensitive?: boolean;
          glob?: string;
          cursor?: string;
          limit?: number;
          respectGitIgnore?: boolean;
        };
        const page = await searchWorkspaceTextPage(options.workspaceRoot, input);
        const result = { matches: page.items, ...page, items: undefined };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return errorContent(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const applyPatch: AgentTool = {
    name: 'apply_patch',
    label: 'Apply workspace patch',
    description:
      'Request one-time approval, then atomically apply exact text replacements guarded by the file hash.',
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      expectedBeforeHash: Type.Union([Type.String(), Type.Null()]),
      replacements: Type.Optional(
        Type.Array(
          Type.Object({ original: Type.String({ minLength: 1 }), replacement: Type.String() })
        )
      ),
      createContent: Type.Optional(Type.String()),
      deleteFile: Type.Optional(Type.Boolean()),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal) => {
      if (options.permissionMode !== 'workspace-write') {
        return errorContent('This project is read-only; file mutations are not permitted.');
      }
      const input = params as ApplyPatchInput;
      try {
        const preview = JSON.stringify({
          operation: input.deleteFile
            ? 'delete'
            : input.createContent !== undefined
              ? 'create'
              : 'modify',
          path: input.path,
          replacements: input.replacements?.slice(0, 20),
          createContent: input.createContent?.slice(0, 4_000),
        }).slice(0, 8_000);
        const approval: ToolApproval = {
          id: createId(),
          kind: input.deleteFile ? 'file-delete' : 'file-mutation',
          argv: null,
          path: input.path,
          cwd: options.workspaceRoot,
          risk: input.deleteFile ? 'high' : 'medium',
          reason: `Review this exact workspace mutation before it runs: ${preview}`,
        };
        const decision = await options.requestApproval(approval, signal);
        if (decision !== 'allow-once') {
          return errorContent('The requested file mutation was denied.');
        }
        const result = await applyWorkspacePatch(options.workspaceRoot, input, {
          deletionApproved: input.deleteFile === true,
        });
        options.emit('file.change', {
          path: result.path,
          status:
            result.after === null ? 'deleted' : result.before === null ? 'created' : 'modified',
          beforeBase64:
            result.before === null ? null : Buffer.from(result.before, 'utf8').toString('base64'),
          afterBase64:
            result.after === null ? null : Buffer.from(result.after, 'utf8').toString('base64'),
          beforeHash: result.beforeHash,
          afterHash: result.afterHash,
        });
        options.emit('diff.change', { path: result.path, afterHash: result.afterHash });
        const details = {
          path: result.path,
          beforeHash: result.beforeHash,
          afterHash: result.afterHash,
        };
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      } catch (error) {
        return errorContent(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const structuredFileTool = (
    name: 'copy_path' | 'move_path' | 'delete_path' | 'restore_path'
  ): AgentTool => ({
    name,
    label:
      name === 'copy_path'
        ? 'Copy file or directory'
        : name === 'move_path'
          ? 'Move file or directory'
          : name === 'delete_path'
            ? 'Delete to recovery vault'
            : 'Restore from recovery vault',
    description:
      'Prepare an immutable, hash-bound operation; request allow-once approval; then execute it through the main-process operation broker.',
    parameters:
      name === 'copy_path' || name === 'move_path'
        ? Type.Object({
            source: Type.String({ minLength: 1 }),
            destination: Type.String({ minLength: 1 }),
          })
        : name === 'delete_path'
          ? Type.Object({ path: Type.String({ minLength: 1 }) })
          : Type.Object({ recoveryId: Type.String({ minLength: 36, maxLength: 36 }) }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal) => {
      if (options.permissionMode !== 'workspace-write') {
        return errorContent('This project is read-only; structured mutations are not permitted.');
      }
      if (!options.executeOperation) {
        return errorContent('The structured operation broker is unavailable.');
      }
      try {
        const input = params as {
          source?: string;
          destination?: string;
          path?: string;
          recoveryId?: string;
        };
        const manifest =
          name === 'restore_path'
            ? await createRestoreManifest({
                threadId: options.threadId,
                turnId: options.turnId,
                workspaceRoot: options.workspaceRoot,
                recoveryId: input.recoveryId ?? '',
              })
            : await createStructuredFileManifest({
                capability:
                  name === 'copy_path'
                    ? 'file.copy'
                    : name === 'move_path'
                      ? 'file.move'
                      : 'file.delete',
                threadId: options.threadId,
                turnId: options.turnId,
                workspaceRoot: options.workspaceRoot,
                source: name === 'delete_path' ? (input.path ?? '') : (input.source ?? ''),
                ...(input.destination ? { destination: input.destination } : {}),
              });
        const target = manifest.targets.map((candidate) => candidate.path).join(' → ');
        const decision = await options.requestApproval(
          {
            version: 2,
            id: manifest.operationId,
            kind: 'structured-operation',
            argv: manifest.argv,
            path: target,
            cwd: manifest.workspace,
            risk: name === 'delete_path' ? 'high' : 'medium',
            reason: `Allow this exact ${manifest.capability} operation once. Before-state binding: ${manifest.binding}.`,
            operationManifest: manifest,
            expiresAt: manifest.expiresAt,
          },
          signal
        );
        if (decision !== 'allow-once') {
          return errorContent('The structured file operation was denied.');
        }
        const result = await options.executeOperation(manifest, signal);
        options.emit('operation.completed', {
          operationId: manifest.operationId,
          capability: manifest.capability,
          binding: manifest.binding,
          result,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: result,
        };
      } catch (error) {
        return errorContent(error instanceof Error ? error.message : String(error));
      }
    },
  });

  const fetchUrl: AgentTool = {
    name: 'fetch_url',
    label: 'Retrieve approved HTTPS resource',
    description:
      'Bind an HTTPS GET or HEAD request to reviewed public DNS addresses, request allow-once approval, reject redirects, and cap the response at 10 MiB.',
    parameters: Type.Object({
      url: Type.String({ minLength: 1, maxLength: 8_192 }),
      method: Type.Optional(Type.Union([Type.Literal('GET'), Type.Literal('HEAD')])),
      maxResponseBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 * 1024 * 1024 })),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal) => {
      if (!options.executeOperation) {
        return errorContent('The structured operation broker is unavailable.');
      }
      try {
        const input = params as {
          url: string;
          method?: 'GET' | 'HEAD';
          maxResponseBytes?: number;
        };
        const manifest = await createNetworkFetchManifest({
          threadId: options.threadId,
          turnId: options.turnId,
          workspaceRoot: options.workspaceRoot,
          method: input.method ?? 'GET',
          url: input.url,
          maxResponseBytes: input.maxResponseBytes,
        });
        const network = manifest.network;
        if (!network) throw new Error('The network binding is unavailable.');
        const decision = await options.requestApproval(
          {
            version: 2,
            id: manifest.operationId,
            kind: 'network-operation',
            argv: null,
            path: network.url,
            cwd: manifest.workspace,
            risk: 'medium',
            reason: `Allow one ${network.method} request to ${network.url} at ${network.resolvedAddresses.join(', ')} with a ${network.maxResponseBytes}-byte cap. Redirects are denied.`,
            operationManifest: manifest,
            expiresAt: manifest.expiresAt,
          },
          signal
        );
        if (decision !== 'allow-once') return errorContent('The network retrieval was denied.');
        const result = await options.executeOperation(manifest, signal);
        const body =
          typeof result.bodyBase64 === 'string'
            ? Buffer.from(result.bodyBase64, 'base64').toString('utf8')
            : '';
        const content = body.slice(0, 256 * 1024);
        const modelResult = {
          status: result.status,
          headers: result.headers,
          size: result.size,
          content,
          truncated: body.length > content.length,
        };
        options.emit('operation.completed', {
          operationId: manifest.operationId,
          capability: manifest.capability,
          binding: manifest.binding,
          status: result.status,
          size: result.size,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(modelResult) }],
          details: modelResult,
        };
      } catch (error) {
        return errorContent(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const scriptTool = (name: 'run_project_script' | 'run_lifecycle_script'): AgentTool => ({
    name,
    label: name === 'run_project_script' ? 'Run reviewed project script' : 'Run lifecycle script',
    description:
      name === 'run_project_script'
        ? 'Run an exact package.json test/build/lint/format/check/typecheck script in the network-denied OS sandbox after allow-once approval.'
        : 'Run any exact package.json script only after a separate high-risk allow-once approval; network and protected credentials remain denied.',
    parameters: Type.Object({ script: Type.String({ minLength: 1, maxLength: 128 }) }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal) => {
      if (options.permissionMode !== 'workspace-write') {
        return errorContent('This project is read-only; package scripts are not permitted.');
      }
      if (!options.executeOperation) {
        return errorContent('The structured operation broker is unavailable.');
      }
      try {
        const script = (params as { script: string }).script;
        const manifest = await createScriptOperationManifest({
          capability: name === 'run_project_script' ? 'script.run' : 'dependency.lifecycle',
          threadId: options.threadId,
          turnId: options.turnId,
          workspaceRoot: options.workspaceRoot,
          script,
        });
        const decision = await options.requestApproval(
          {
            version: 2,
            id: manifest.operationId,
            kind: 'dependency-operation',
            argv: manifest.argv,
            path: 'package.json',
            cwd: manifest.workspace,
            risk: name === 'run_lifecycle_script' ? 'high' : 'medium',
            reason: `Allow this exact package script once in the network-denied OS sandbox. Manifest binding: ${manifest.binding}.`,
            operationManifest: manifest,
            expiresAt: manifest.expiresAt,
          },
          signal
        );
        if (decision !== 'allow-once') return errorContent('The package script was denied.');
        const result = await options.executeOperation(manifest, signal);
        options.emit('operation.completed', {
          operationId: manifest.operationId,
          capability: manifest.capability,
          binding: manifest.binding,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          cancelled: result.cancelled,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return errorContent(error instanceof Error ? error.message : String(error));
      }
    },
  });

  const previewDependency: AgentTool = {
    name: 'preview_dependency_change',
    label: 'Preview dependency change',
    description:
      'Run npm, pnpm, or Yarn in a temporary mirror with network and lifecycle scripts disabled; retain only a bounded package manifest/lock proposal.',
    parameters: Type.Object({
      manager: Type.Union([Type.Literal('npm'), Type.Literal('pnpm'), Type.Literal('yarn')]),
      action: Type.Union([Type.Literal('add'), Type.Literal('remove')]),
      packageSpec: Type.String({ minLength: 1, maxLength: 300 }),
      dev: Type.Optional(Type.Boolean()),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal) => {
      if (options.permissionMode !== 'workspace-write') {
        return errorContent('This project is read-only; dependency changes are not permitted.');
      }
      if (!options.executeOperation) {
        return errorContent('The structured operation broker is unavailable.');
      }
      try {
        const input = params as {
          manager: 'npm' | 'pnpm' | 'yarn';
          action: 'add' | 'remove';
          packageSpec: string;
          dev?: boolean;
        };
        const manifest = await createDependencyPreviewManifest({
          threadId: options.threadId,
          turnId: options.turnId,
          workspaceRoot: options.workspaceRoot,
          ...input,
        });
        const decision = await options.requestApproval(
          {
            version: 2,
            id: manifest.operationId,
            kind: 'dependency-operation',
            argv: manifest.argv,
            path: manifest.targets.map((target) => target.path).join(', '),
            cwd: manifest.workspace,
            risk: 'medium',
            reason: `Allow one temporary dependency preview. It is offline, ignores lifecycle scripts, cannot mutate the workspace, and is bound to ${manifest.binding}.`,
            operationManifest: manifest,
            expiresAt: manifest.expiresAt,
          },
          signal
        );
        if (decision !== 'allow-once') return errorContent('The dependency preview was denied.');
        const result = DependencyPreviewResultSchema.parse(
          await options.executeOperation(manifest, signal)
        );
        dependencyPreviews.set(result.previewId, result);
        options.emit('operation.completed', {
          operationId: manifest.operationId,
          capability: manifest.capability,
          binding: manifest.binding,
          previewId: result.previewId,
          digest: result.digest,
          changes: result.dependencyChanges,
          lifecycleScriptsExecuted: false,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return errorContent(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const applyDependency: AgentTool = {
    name: 'apply_dependency_preview',
    label: 'Apply dependency preview',
    description:
      'Apply the exact in-memory package.json and lockfile proposal from a prior preview after a second allow-once decision. Lifecycle scripts are never run.',
    parameters: Type.Object({ previewId: Type.String({ minLength: 36, maxLength: 36 }) }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal) => {
      if (options.permissionMode !== 'workspace-write') {
        return errorContent('This project is read-only; dependency changes are not permitted.');
      }
      if (!options.executeOperation) {
        return errorContent('The structured operation broker is unavailable.');
      }
      try {
        const previewId = (params as { previewId: string }).previewId;
        const preview = dependencyPreviews.get(previewId);
        if (!preview) {
          return errorContent('The dependency preview is unavailable or belongs to another task.');
        }
        const manifest = createDependencyApplyManifest({
          threadId: options.threadId,
          turnId: options.turnId,
          preview,
        });
        const decision = await options.requestApproval(
          {
            version: 2,
            id: manifest.operationId,
            kind: 'dependency-operation',
            argv: manifest.argv,
            path: preview.changes.map((change) => change.path).join(', '),
            cwd: manifest.workspace,
            risk: 'high',
            reason: `Apply this exact dependency proposal once: ${JSON.stringify(preview.dependencyChanges)}. Lock/manifest digest: ${preview.digest}. Lifecycle scripts remain disabled.`,
            operationManifest: manifest,
            expiresAt: manifest.expiresAt,
          },
          signal
        );
        if (decision !== 'allow-once') return errorContent('The dependency apply was denied.');
        const result = await options.executeOperation(manifest, signal);
        dependencyPreviews.delete(previewId);
        options.emit('operation.completed', {
          operationId: manifest.operationId,
          capability: manifest.capability,
          binding: manifest.binding,
          previewId,
          digest: preview.digest,
          applied: result.applied,
          lifecycleScriptsExecuted: false,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return errorContent(error instanceof Error ? error.message : String(error));
      }
    },
  };

  type GitToolName =
    | 'git_create_branch'
    | 'git_switch_branch'
    | 'git_stage_paths'
    | 'git_commit'
    | 'git_push';

  const gitCapability = (name: GitToolName): GitWriteCapability =>
    name === 'git_create_branch'
      ? 'git.branch.create'
      : name === 'git_switch_branch'
        ? 'git.switch'
        : name === 'git_stage_paths'
          ? 'git.stage'
          : name === 'git_commit'
            ? 'git.commit'
            : 'git.push';

  const gitTool = (name: GitToolName): AgentTool => ({
    name,
    label:
      name === 'git_create_branch'
        ? 'Create Git branch'
        : name === 'git_switch_branch'
          ? 'Switch Git branch'
          : name === 'git_stage_paths'
            ? 'Stage exact Git paths'
            : name === 'git_commit'
              ? 'Create exact Git commit'
              : 'Push exact Git ref',
    description:
      'Prepare a Git before-state/OID-bound operation and execute it once through the credential-isolating main-process broker. Force, reset, ref deletion, and hooks are denied.',
    parameters:
      name === 'git_create_branch' || name === 'git_switch_branch'
        ? Type.Object({ branch: Type.String({ minLength: 1, maxLength: 255 }) })
        : name === 'git_stage_paths'
          ? Type.Object({
              paths: Type.Array(Type.String({ minLength: 1 }), {
                minItems: 1,
                maxItems: 32,
              }),
            })
          : name === 'git_commit'
            ? Type.Object({ message: Type.String({ minLength: 1, maxLength: 2_000 }) })
            : Type.Object({
                remote: Type.String({ minLength: 1, maxLength: 128 }),
                remoteRef: Type.String({ minLength: 12, maxLength: 255 }),
              }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal) => {
      if (options.permissionMode !== 'workspace-write') {
        return errorContent('This project is read-only; Git writes are not permitted.');
      }
      if (!options.executeOperation) {
        return errorContent('The structured operation broker is unavailable.');
      }
      try {
        const input = params as {
          branch?: string;
          paths?: string[];
          message?: string;
          remote?: string;
          remoteRef?: string;
        };
        const manifest = await createGitOperationManifest({
          capability: gitCapability(name),
          threadId: options.threadId,
          turnId: options.turnId,
          workspaceRoot: options.workspaceRoot,
          ...input,
        });
        const decision = await options.requestApproval(
          {
            version: 2,
            id: manifest.operationId,
            kind: 'git-operation',
            argv: manifest.argv,
            path: manifest.targets.map((target) => target.path).join(', ') || null,
            cwd: manifest.workspace,
            risk: name === 'git_push' || name === 'git_commit' ? 'high' : 'medium',
            reason: `Allow this exact ${manifest.capability} operation once. Git before-state: ${JSON.stringify(manifest.git)}. Binding: ${manifest.binding}.`,
            operationManifest: manifest,
            expiresAt: manifest.expiresAt,
          },
          signal
        );
        if (decision !== 'allow-once') return errorContent('The Git operation was denied.');
        const result = await options.executeOperation(manifest, signal);
        options.emit('operation.completed', {
          operationId: manifest.operationId,
          capability: manifest.capability,
          binding: manifest.binding,
          exitCode: result.exitCode,
          before: result.before,
          after: result.after,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return errorContent(error instanceof Error ? error.message : String(error));
      }
    },
  });

  const delegateTask: AgentTool = {
    name: 'delegate_task',
    label: 'Delegate bounded child task',
    description:
      'Start one visible, independently cancellable child task in the same trusted project. Delegation is depth-one, capped at three children, and requires a fresh high-risk allow-once decision.',
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 120 }),
      prompt: Type.String({ minLength: 1, maxLength: 8_192 }),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal) => {
      if (!options.delegationEnabled) {
        return errorContent('Delegated tasks are disabled for this project.');
      }
      if (!options.executeOperation) {
        return errorContent('The structured operation broker is unavailable.');
      }
      try {
        const input = params as { title: string; prompt: string };
        const manifest = await createDelegationManifest({
          threadId: options.threadId,
          turnId: options.turnId,
          workspaceRoot: options.workspaceRoot,
          ...input,
        });
        const decision = await options.requestApproval(
          {
            version: 2,
            id: manifest.operationId,
            kind: 'delegation',
            argv: manifest.argv,
            path: null,
            cwd: manifest.workspace,
            risk: 'high',
            reason: `Allow one depth-one delegated task titled “${input.title}”. It receives only this explicit prompt, uses an independent conversation, remains subject to the same sandbox and approvals, and is bound to ${manifest.binding}.`,
            operationManifest: manifest,
            expiresAt: manifest.expiresAt,
          },
          signal
        );
        if (decision !== 'allow-once') return errorContent('The delegated task was denied.');
        const result = await options.executeOperation(manifest, signal);
        options.emit('operation.completed', {
          operationId: manifest.operationId,
          capability: manifest.capability,
          binding: manifest.binding,
          childThreadId: result.childThreadId,
          childTurnId: result.childTurnId,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return errorContent(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const fileTools = [
    listFiles,
    readFile,
    searchText,
    applyPatch,
    structuredFileTool('copy_path'),
    structuredFileTool('move_path'),
    structuredFileTool('delete_path'),
    structuredFileTool('restore_path'),
    fetchUrl,
    previewDependency,
    applyDependency,
    scriptTool('run_project_script'),
    scriptTool('run_lifecycle_script'),
    gitTool('git_create_branch'),
    gitTool('git_switch_branch'),
    gitTool('git_stage_paths'),
    gitTool('git_commit'),
    gitTool('git_push'),
    ...(options.delegationEnabled ? [delegateTask] : []),
  ];
  return options.commandsEnabled === false
    ? fileTools
    : [
        ...fileTools,
        commandTool(withAllowed, 'run_command'),
        commandTool(withAllowed, 'git_status'),
        commandTool(withAllowed, 'git_diff'),
      ];
};
