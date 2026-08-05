import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { sha256 } from '../shared/security';

export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_LISTED_FILES = 5_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILES = 1_000;
const MAX_READ_LINES = 2_000;
const MAX_READ_BYTES = 256 * 1024;
const MAX_GLOB_LENGTH = 256;
const SECRET_NAMES = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials',
  'credentials.json',
  'service-account.json',
  'secrets.json',
  'secret.json',
  '.netrc',
]);

export class WorkspaceAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceAccessError';
  }
}

export interface WorkspacePath {
  root: string;
  absolute: string;
  relative: string;
}

export interface TextFile {
  path: WorkspacePath;
  content: string;
  hash: string;
  size: number;
}

export interface TextFileRange extends Omit<TextFile, 'content'> {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface SearchResult {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface WorkspacePage<T> {
  items: T[];
  nextCursor: string | null;
  truncated: boolean;
  scanned: number;
}

export interface ListWorkspaceOptions {
  path?: string;
  glob?: string;
  cursor?: string;
  limit?: number;
  respectGitIgnore?: boolean;
}

export interface SearchWorkspaceOptions {
  path?: string;
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  glob?: string;
  cursor?: string;
  limit?: number;
  respectGitIgnore?: boolean;
}

export interface Replacement {
  original: string;
  replacement: string;
}

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const normalizeRelative = (input: string): string => {
  if (!input || isAbsolute(input)) {
    throw new WorkspaceAccessError('A workspace path must be a non-empty relative path.');
  }

  const normalized = input
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(sep);
  if (
    !normalized ||
    normalized === '.' ||
    normalized.split(sep).some((segment) => segment === '..')
  ) {
    throw new WorkspaceAccessError('Path traversal is not permitted.');
  }

  return normalized;
};

export const isProtectedPath = (input: string): boolean => {
  const segments = input.split(/[\\/]+/).filter(Boolean);
  const fileName = segments.at(-1)?.toLowerCase() ?? '';

  return (
    segments.some(
      (segment) =>
        segment === '.git' ||
        segment === '.ssh' ||
        segment === '.aws' ||
        segment === '.adrouter-recovery'
    ) ||
    fileName.startsWith('.env') ||
    SECRET_NAMES.has(fileName) ||
    /\.(pem|key|p12|pfx)$/i.test(fileName)
  );
};

const isContained = (root: string, candidate: string): boolean => {
  const pathRelative = relative(root, candidate);
  return (
    pathRelative === '' ||
    (!pathRelative.startsWith(`..${sep}`) && pathRelative !== '..' && !isAbsolute(pathRelative))
  );
};

const nearestExistingParent = async (path: string): Promise<string> => {
  let current = path;
  while (!(await exists(current))) {
    const next = dirname(current);
    if (next === current) {
      throw new WorkspaceAccessError('Unable to resolve workspace parent.');
    }
    current = next;
  }
  return current;
};

export const resolveWorkspacePath = async (
  workspaceRoot: string,
  input: string,
  options: { allowMissing?: boolean; allowProtected?: boolean } = {}
): Promise<WorkspacePath> => {
  const root = await realpath(workspaceRoot);
  const normalized = normalizeRelative(input);

  if (!options.allowProtected && isProtectedPath(normalized)) {
    throw new WorkspaceAccessError('This file is protected and unavailable to the agent.');
  }

  const absolute = resolve(root, normalized);
  if (!isContained(root, absolute)) {
    throw new WorkspaceAccessError('The requested path escapes the workspace.');
  }

  const present = await exists(absolute);
  if (!present && !options.allowMissing) {
    throw new WorkspaceAccessError('The requested file does not exist.');
  }

  const existingPath = present ? absolute : await nearestExistingParent(absolute);
  const resolvedExistingPath = await realpath(existingPath);
  if (!isContained(root, resolvedExistingPath)) {
    throw new WorkspaceAccessError('Symlinks outside the workspace are not permitted.');
  }

  if (present) {
    const fileStat = await lstat(absolute);
    if (fileStat.isSymbolicLink()) {
      const resolved = await realpath(absolute);
      if (!isContained(root, resolved)) {
        throw new WorkspaceAccessError('Symlinks outside the workspace are not permitted.');
      }
    }
  }

  return { root, absolute, relative: normalized.split(sep).join('/') };
};

export const isBinary = (content: Uint8Array): boolean => {
  const sample = content.subarray(0, Math.min(content.length, 8_192));
  return sample.some((byte) => byte === 0);
};

export const readWorkspaceTextFile = async (
  workspaceRoot: string,
  input: string
): Promise<TextFile> => {
  const path = await resolveWorkspacePath(workspaceRoot, input);
  const fileStat = await stat(path.absolute);
  if (!fileStat.isFile()) {
    throw new WorkspaceAccessError('Only regular files may be read.');
  }
  if (fileStat.size > MAX_TEXT_FILE_BYTES) {
    throw new WorkspaceAccessError(`File exceeds the ${MAX_TEXT_FILE_BYTES} byte safety limit.`);
  }

  const bytes = await readFile(path.absolute);
  if (isBinary(bytes)) {
    throw new WorkspaceAccessError('Binary files are unavailable to the agent.');
  }

  return {
    path,
    content: bytes.toString('utf8'),
    hash: sha256(bytes),
    size: bytes.length,
  };
};

export const readWorkspaceTextRange = async (
  workspaceRoot: string,
  input: string,
  options: { startLine?: number; maxLines?: number; maxBytes?: number } = {}
): Promise<TextFileRange> => {
  const file = await readWorkspaceTextFile(workspaceRoot, input);
  const startLine = options.startLine ?? 1;
  const maxLines = options.maxLines ?? 500;
  const maxBytes = options.maxBytes ?? MAX_READ_BYTES;
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new WorkspaceAccessError('startLine must be a positive integer.');
  }
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > MAX_READ_LINES) {
    throw new WorkspaceAccessError(`maxLines must be between 1 and ${MAX_READ_LINES}.`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) {
    throw new WorkspaceAccessError(`maxBytes must be between 1 and ${MAX_READ_BYTES}.`);
  }

  const lines = file.content.split(/\r?\n/);
  const selected: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(startLine - 1, startLine - 1 + maxLines)) {
    const nextBytes = Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0);
    if (selected.length > 0 && bytes + nextBytes > maxBytes) break;
    selected.push(line);
    bytes += nextBytes;
    if (bytes >= maxBytes) break;
  }
  const endLine = selected.length === 0 ? startLine - 1 : startLine + selected.length - 1;
  return {
    path: file.path,
    content: selected.join('\n'),
    hash: file.hash,
    size: file.size,
    startLine,
    endLine,
    totalLines: lines.length,
    truncated: endLine < lines.length,
  };
};

const walk = async (root: string, directory: string, files: string[]): Promise<void> => {
  if (files.length >= MAX_LISTED_FILES) {
    return;
  }

  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= MAX_LISTED_FILES) {
      return;
    }
    const absolute = resolve(directory, entry.name);
    const fromRoot = relative(root, absolute).split(sep).join('/');
    if (isProtectedPath(fromRoot)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        const resolved = await realpath(absolute);
        if (!isContained(root, resolved)) {
          continue;
        }
      } catch {
        continue;
      }
    }
    if (entry.isDirectory()) {
      await walk(root, absolute, files);
    } else if (entry.isFile()) {
      files.push(fromRoot);
    }
  }
};

const cursorOffset = (value: string | undefined): number => {
  if (!value) return 0;
  if (!/^\d{1,8}$/.test(value)) throw new WorkspaceAccessError('The page cursor is invalid.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_LISTED_FILES) {
    throw new WorkspaceAccessError('The page cursor is outside the bounded result set.');
  }
  return parsed;
};

const globRegex = (value: string | undefined): RegExp | null => {
  if (!value) return null;
  if (value.length > MAX_GLOB_LENGTH || value.includes('\0')) {
    throw new WorkspaceAccessError(`glob must be at most ${MAX_GLOB_LENGTH} characters.`);
  }
  let source = '^';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '*') {
      if (value[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character?.replace(/[\\^$.[\]{}()+|]/g, '\\$&') ?? '';
    }
  }
  return new RegExp(`${source}$`);
};

const gitIgnored = async (root: string, files: string[]): Promise<Set<string>> => {
  if (files.length === 0) return new Set();
  return await new Promise((resolveIgnored) => {
    const ignored = new Set<string>();
    let output = Buffer.alloc(0);
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const entry of output.toString('utf8').split('\0')) if (entry) ignored.add(entry);
      resolveIgnored(ignored);
    };
    const child = spawn('git', ['-C', root, 'check-ignore', '--stdin', '-z'], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, 2_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length <= 1024 * 1024) output = Buffer.concat([output, chunk]);
    });
    child.once('error', finish);
    child.once('close', finish);
    child.stdin.end(`${files.join('\0')}\0`);
  });
};

export const listWorkspaceFiles = async (workspaceRoot: string, input = '.'): Promise<string[]> => {
  const root = await realpath(workspaceRoot);
  const target =
    input === '.'
      ? { root, absolute: root, relative: '' }
      : await resolveWorkspacePath(root, input);
  const fileStat = await stat(target.absolute);
  if (!fileStat.isDirectory()) {
    throw new WorkspaceAccessError('list_files requires a directory.');
  }
  const files: string[] = [];
  await walk(root, target.absolute, files);
  return files.sort();
};

export const listWorkspaceFilesPage = async (
  workspaceRoot: string,
  options: ListWorkspaceOptions = {}
): Promise<WorkspacePage<string>> => {
  const limit = options.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new WorkspaceAccessError('limit must be between 1 and 500.');
  }
  const offset = cursorOffset(options.cursor);
  const matcher = globRegex(options.glob);
  let files = await listWorkspaceFiles(workspaceRoot, options.path ?? '.');
  if (options.respectGitIgnore !== false) {
    const ignored = await gitIgnored(await realpath(workspaceRoot), files);
    files = files.filter((file) => !ignored.has(file));
  }
  if (matcher) files = files.filter((file) => matcher.test(file));
  const items = files.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    items,
    nextCursor: nextOffset < files.length ? String(nextOffset) : null,
    truncated: nextOffset < files.length || files.length >= MAX_LISTED_FILES,
    scanned: files.length,
  };
};

interface RegexWorkerResult {
  matches?: SearchResult[];
  error?: string;
}

const REGEX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
try {
  const pattern = new RegExp(workerData.source, workerData.flags);
  const matches = [];
  for (const file of workerData.files) {
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (!match) continue;
      matches.push({ path: file.path, line: index + 1, column: match.index + 1, preview: line.slice(0, 500) });
      if (matches.length >= workerData.limit) break;
    }
    if (matches.length >= workerData.limit) break;
  }
  parentPort.postMessage({ matches });
} catch (error) {
  parentPort.postMessage({ error: 'Invalid or unsafe regular expression: ' + String(error?.message ?? error) });
}`;

const searchRegexBatch = async (
  files: Array<{ path: string; content: string }>,
  source: string,
  caseSensitive: boolean,
  limit: number
): Promise<SearchResult[]> =>
  await new Promise((resolveMatches, reject) => {
    const worker = new Worker(REGEX_WORKER_SOURCE, {
      eval: true,
      workerData: { files, source, flags: caseSensitive ? '' : 'i', limit },
    });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new WorkspaceAccessError('Regular expression search exceeded its time limit.'));
    }, 500);
    worker.once('message', (value: RegexWorkerResult) => {
      clearTimeout(timeout);
      void worker.terminate();
      if (value.error) reject(new WorkspaceAccessError(value.error));
      else resolveMatches(value.matches ?? []);
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(
        new WorkspaceAccessError(
          `Regular expression worker failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    });
  });

export const searchWorkspaceTextPage = async (
  workspaceRoot: string,
  options: SearchWorkspaceOptions
): Promise<WorkspacePage<SearchResult>> => {
  if (!options.query.trim() || options.query.length > 1_000) {
    throw new WorkspaceAccessError('Search text must contain 1 to 1,000 characters.');
  }
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
    throw new WorkspaceAccessError(`limit must be between 1 and ${MAX_SEARCH_RESULTS}.`);
  }
  const offset = cursorOffset(options.cursor);
  const listing = await listWorkspaceFilesPage(workspaceRoot, {
    path: options.path,
    glob: options.glob,
    limit: 500,
    respectGitIgnore: options.respectGitIgnore,
  });
  const files: string[] = [...listing.items];
  let cursor = listing.nextCursor;
  while (cursor && files.length < MAX_SEARCH_FILES) {
    const page = await listWorkspaceFilesPage(workspaceRoot, {
      path: options.path,
      glob: options.glob,
      cursor,
      limit: Math.min(500, MAX_SEARCH_FILES - files.length),
      respectGitIgnore: options.respectGitIgnore,
    });
    files.push(...page.items);
    cursor = page.nextCursor;
  }

  const allMatches: SearchResult[] = [];
  if (options.regex) {
    const batch: Array<{ path: string; content: string }> = [];
    let batchBytes = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0 || allMatches.length >= offset + limit + 1) return;
      allMatches.push(
        ...(await searchRegexBatch(
          batch.splice(0),
          options.query,
          options.caseSensitive !== false,
          offset + limit + 1 - allMatches.length
        ))
      );
      batchBytes = 0;
    };
    for (const file of files) {
      if (allMatches.length >= offset + limit + 1) break;
      try {
        const text = await readWorkspaceTextFile(workspaceRoot, file);
        if (batch.length > 0 && batchBytes + text.size > 8 * 1024 * 1024) await flush();
        batch.push({ path: file, content: text.content });
        batchBytes += text.size;
      } catch (error) {
        if (!(error instanceof WorkspaceAccessError)) throw error;
      }
    }
    await flush();
  } else {
    const needle =
      options.caseSensitive === false ? options.query.toLocaleLowerCase() : options.query;
    for (const file of files) {
      if (allMatches.length >= offset + limit + 1) break;
      try {
        const text = await readWorkspaceTextFile(workspaceRoot, file);
        const lines = text.content.split(/\r?\n/);
        for (const [index, original] of lines.entries()) {
          const line = options.caseSensitive === false ? original.toLocaleLowerCase() : original;
          const column = line.indexOf(needle);
          if (column < 0) continue;
          allMatches.push({
            path: file,
            line: index + 1,
            column: column + 1,
            preview: original.slice(0, 500),
          });
          if (allMatches.length >= offset + limit + 1) break;
        }
      } catch (error) {
        if (!(error instanceof WorkspaceAccessError)) throw error;
      }
    }
  }
  const items = allMatches.slice(offset, offset + limit);
  const hasMore = allMatches.length > offset + items.length || cursor !== null;
  return {
    items,
    nextCursor: hasMore ? String(offset + items.length) : null,
    truncated: hasMore || files.length >= MAX_SEARCH_FILES,
    scanned: files.length,
  };
};

export const searchWorkspaceText = async (
  workspaceRoot: string,
  query: string,
  input = '.'
): Promise<SearchResult[]> => {
  return (
    await searchWorkspaceTextPage(workspaceRoot, {
      query,
      path: input,
      limit: MAX_SEARCH_RESULTS,
      respectGitIgnore: true,
    })
  ).items;
};

const applyReplacements = (current: string, replacements: readonly Replacement[]): string => {
  let next = current;
  for (const replacement of replacements) {
    if (!replacement.original) {
      throw new WorkspaceAccessError('Patch replacements require a non-empty original block.');
    }
    const first = next.indexOf(replacement.original);
    if (
      first === -1 ||
      next.indexOf(replacement.original, first + replacement.original.length) !== -1
    ) {
      throw new WorkspaceAccessError('Patch original block must occur exactly once.');
    }
    next = `${next.slice(0, first)}${replacement.replacement}${next.slice(first + replacement.original.length)}`;
  }
  return next;
};

const atomicWrite = async (filePath: string, contents: string): Promise<void> => {
  const temp = resolve(dirname(filePath), `.${basename(filePath)}.adrouter-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, filePath);
  } finally {
    if (await exists(temp)) {
      await unlink(temp);
    }
  }
};

export interface ApplyPatchInput {
  path: string;
  expectedBeforeHash: string | null;
  replacements?: Replacement[];
  createContent?: string;
  deleteFile?: boolean;
}

export interface AppliedPatch {
  path: string;
  before: string | null;
  after: string | null;
  beforeHash: string | null;
  afterHash: string | null;
}

export const applyWorkspacePatch = async (
  workspaceRoot: string,
  input: ApplyPatchInput,
  options: { deletionApproved: boolean }
): Promise<AppliedPatch> => {
  const path = await resolveWorkspacePath(workspaceRoot, input.path, { allowMissing: true });
  const filePresent = await exists(path.absolute);
  const before = filePresent ? await readWorkspaceTextFile(workspaceRoot, input.path) : undefined;

  if (before && input.expectedBeforeHash !== before.hash) {
    throw new WorkspaceAccessError(
      'The file changed since the agent read it. Refresh before applying a patch.'
    );
  }
  if (!before && input.expectedBeforeHash !== null) {
    throw new WorkspaceAccessError('Expected hash must be null when creating a file.');
  }

  if (input.deleteFile) {
    if (!before) {
      throw new WorkspaceAccessError('Cannot delete a file that does not exist.');
    }
    if (!options.deletionApproved) {
      throw new WorkspaceAccessError('File deletion requires explicit approval.');
    }
    await unlink(path.absolute);
    return {
      path: path.relative,
      before: before.content,
      after: null,
      beforeHash: before.hash,
      afterHash: null,
    };
  }

  const after = before
    ? applyReplacements(before.content, input.replacements ?? [])
    : (input.createContent ??
      (() => {
        throw new WorkspaceAccessError('Creating a file requires createContent.');
      })());

  if (Buffer.byteLength(after, 'utf8') > MAX_TEXT_FILE_BYTES) {
    throw new WorkspaceAccessError(
      `Patched file exceeds the ${MAX_TEXT_FILE_BYTES} byte safety limit.`
    );
  }

  await mkdir(dirname(path.absolute), { recursive: true });
  await atomicWrite(path.absolute, after);
  return {
    path: path.relative,
    before: before?.content ?? null,
    after,
    beforeHash: before?.hash ?? null,
    afterHash: sha256(after),
  };
};
