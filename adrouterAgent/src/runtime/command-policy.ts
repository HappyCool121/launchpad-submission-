import type { ApprovalDecision } from '../shared/contracts';

export type CommandDisposition = 'allow' | 'approval' | 'deny';

export interface CommandAssessment {
  disposition: CommandDisposition;
  risk: 'low' | 'medium' | 'high';
  reason: string;
}

const NETWORK_BINARIES = new Set([
  'curl',
  'wget',
  'ftp',
  'ssh',
  'scp',
  'sftp',
  'nc',
  'ncat',
  'telnet',
  'ping',
  'git-remote-https',
]);

const DENIED_BINARIES = new Set([
  'sudo',
  'su',
  'doas',
  'chmod',
  'chown',
  'chflags',
  'launchctl',
  'osascript',
  'kill',
  'killall',
  'pkill',
  'dd',
  'mkfs',
  'diskutil',
  'mount',
  'umount',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'touch',
]);

const READ_ONLY_BINARIES = new Set([
  'pwd',
  'ls',
  'find',
  'rg',
  'grep',
  'sed',
  'head',
  'tail',
  'cat',
  'wc',
  'git',
  'node',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'python',
  'python3',
]);

const SENSITIVE_PATH_SEGMENT =
  /(?:^|[/:\\])(?:\.env(?:\.[^/:\\]+)?|\.ssh|\.aws|\.netrc|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|service-account\.json|secrets?\.json)(?:$|[/:\\])/i;

const argumentValue = (argument: string): string => {
  const separator = argument.indexOf('=');
  return separator >= 0 ? argument.slice(separator + 1) : argument;
};

const referencesOutsideWorkspace = (argv: readonly string[]): boolean =>
  argv.some((argument) => {
    const value = argumentValue(argument);
    return (
      value.startsWith('/') ||
      value.startsWith('~') ||
      /^[a-z]:[\\/]/i.test(value) ||
      /^\\\\/.test(value) ||
      value.startsWith('file:') ||
      value === '..' ||
      value.startsWith('../') ||
      value.startsWith('..\\') ||
      value.includes('/../') ||
      value.includes('\\..\\')
    );
  });

const referencesSensitivePath = (argv: readonly string[]): boolean =>
  argv.some((argument) => SENSITIVE_PATH_SEGMENT.test(argumentValue(argument)));

const isDependencyOperation = (command: string, args: readonly string[]): boolean => {
  if (command === 'npm' || command === 'pnpm' || command === 'yarn' || command === 'bun') {
    return args.some((arg) =>
      /^(add|install|i|ci|remove|uninstall|update|upgrade|publish|dlx|exec)$/i.test(arg)
    );
  }
  return command === 'npx';
};

const isGitReadOnly = (args: readonly string[]): boolean => {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    return false;
  }
  if (
    ['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'remote', 'ls-files', 'grep'].includes(
      subcommand
    )
  ) {
    return !rest.some((arg) => ['--cached', '--staged', '--no-index'].includes(arg));
  }
  return false;
};

const isTestCommand = (command: string, args: readonly string[]): boolean => {
  if (command === 'npm' || command === 'pnpm' || command === 'yarn' || command === 'bun') {
    return (
      args[0] === 'test' ||
      (args[0] === 'run' && /^(test|lint|typecheck|check)$/i.test(args[1] ?? ''))
    );
  }
  return /(?:^|[-_])(?:test|spec|lint|typecheck)(?:$|[-_])/i.test(command);
};

const containsShellSyntax = (argv: readonly string[]): boolean =>
  argv.some((arg) => /[|;&`$<>]/.test(arg) || arg.includes('\n') || arg.includes('\r'));

const commandName = (executable: string): string =>
  (executable.replaceAll('\\', '/').split('/').at(-1) ?? '')
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/i, '');

export const classifyCommand = (argv: readonly string[]): CommandAssessment => {
  const executable = argv[0];
  if (!executable?.trim()) {
    return {
      disposition: 'deny',
      risk: 'high',
      reason: 'Commands must include a program argv[0].',
    };
  }
  if (argv.some((arg) => !arg || arg.length > 8_192)) {
    return {
      disposition: 'deny',
      risk: 'high',
      reason: 'Command arguments must be non-empty and bounded.',
    };
  }
  const command = commandName(executable);
  const isShell = ['sh', 'bash', 'zsh', 'pwsh', 'powershell', 'cmd'].includes(command);
  if (!isShell && containsShellSyntax(argv)) {
    return {
      disposition: 'deny',
      risk: 'high',
      reason:
        'Shell operators and command interpolation are not accepted; provide a plain argv array.',
    };
  }
  if (referencesOutsideWorkspace(argv)) {
    return {
      disposition: 'deny',
      risk: 'high',
      reason: 'Commands cannot access paths outside the selected workspace.',
    };
  }
  if (referencesSensitivePath(argv)) {
    return {
      disposition: 'deny',
      risk: 'high',
      reason: 'Credential-bearing and protected paths are unavailable to agent commands.',
    };
  }

  const args = argv.slice(1);

  if (NETWORK_BINARIES.has(command)) {
    return { disposition: 'deny', risk: 'high', reason: 'Agent command networking is disabled.' };
  }
  if (DENIED_BINARIES.has(command)) {
    return {
      disposition: 'deny',
      risk: 'high',
      reason: 'This command is outside the desktop agent safety policy.',
    };
  }
  if (isShell) {
    return {
      disposition: 'approval',
      risk: 'high',
      reason: 'Shell execution requires approval of the exact argv and remains sandboxed.',
    };
  }
  if (isDependencyOperation(command, args)) {
    return {
      disposition: 'deny',
      risk: 'high',
      reason: 'Dependency installation and package changes are disabled.',
    };
  }
  if (command === 'git') {
    if (
      args.some((arg) =>
        [
          'reset',
          'clean',
          'checkout',
          'restore',
          'rebase',
          'merge',
          'commit',
          'push',
          'pull',
        ].includes(arg)
      )
    ) {
      return {
        disposition: 'deny',
        risk: 'high',
        reason: 'Destructive or remote Git operations are disabled.',
      };
    }
    if (isGitReadOnly(args)) {
      return { disposition: 'allow', risk: 'low', reason: 'Read-only Git inspection is allowed.' };
    }
    return {
      disposition: 'approval',
      risk: 'medium',
      reason: 'This Git command needs explicit approval.',
    };
  }
  if (
    command === 'find' &&
    args.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(arg))
  ) {
    return {
      disposition: 'deny',
      risk: 'high',
      reason: 'find actions that execute or delete are disabled.',
    };
  }
  if (command === 'sed' && args.some((arg) => arg === '-i' || arg.startsWith('-i'))) {
    return {
      disposition: 'deny',
      risk: 'high',
      reason: 'In-place command edits must use apply_patch instead.',
    };
  }
  if (command === 'node' || command === 'python' || command === 'python3') {
    if (args.length === 1 && ['--version', '-v'].includes(args[0] ?? '')) {
      return {
        disposition: 'allow',
        risk: 'low',
        reason: 'Runtime version inspection is allowed.',
      };
    }
    return {
      disposition: 'approval',
      risk: 'medium',
      reason: 'Interpreted code requires explicit approval.',
    };
  }
  if (isTestCommand(command, args)) {
    return {
      disposition: 'allow',
      risk: 'low',
      reason: 'A local test, lint, or typecheck command is allowed.',
    };
  }
  if (READ_ONLY_BINARIES.has(command)) {
    return {
      disposition: 'allow',
      risk: 'low',
      reason: 'A conservative workspace inspection command is allowed.',
    };
  }

  return {
    disposition: 'approval',
    risk: 'medium',
    reason: 'Unknown commands require explicit approval.',
  };
};

export const approvalAllowsCommand = (
  decision: ApprovalDecision,
  expectedArgv: readonly string[],
  actualArgv: readonly string[]
): boolean =>
  decision !== 'deny' &&
  expectedArgv.length === actualArgv.length &&
  expectedArgv.every((part, index) => actualArgv[index] === part);
