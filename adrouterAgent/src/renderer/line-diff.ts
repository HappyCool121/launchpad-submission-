export const MAX_DIFF_LINES = 20_000;
const MAX_LCS_CELLS = 4_000_000;

export type ChangedLine =
  | {
      kind: 'removed' | 'added';
      oldLine: number | null;
      newLine: number | null;
      text: string;
    }
  | { kind: 'ellipsis'; oldLine: number; newLine: number; text: string }
  | { kind: 'meta'; text: string };

export interface ChangedLineDiff {
  rows: ChangedLine[];
  tooLarge: boolean;
}

interface SourceLines {
  lines: string[];
  trailingNewline: boolean;
}

type Operation = { kind: 'equal' | 'removed' | 'added'; text: string };

const sourceLines = (source: string): SourceLines => {
  if (!source) return { lines: [], trailingNewline: false };
  const normalized = source.replaceAll('\r\n', '\n');
  const trailingNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
};

const changedMiddle = (original: string[], current: string[]): Operation[] => {
  if (original.length === 0) return current.map((text) => ({ kind: 'added', text }));
  if (current.length === 0) return original.map((text) => ({ kind: 'removed', text }));

  if (original.length * current.length > MAX_LCS_CELLS) {
    return [
      ...original.map((text): Operation => ({ kind: 'removed', text })),
      ...current.map((text): Operation => ({ kind: 'added', text })),
    ];
  }

  const width = current.length + 1;
  const table = new Uint32Array((original.length + 1) * width);
  for (let oldIndex = original.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = current.length - 1; newIndex >= 0; newIndex -= 1) {
      const cell = oldIndex * width + newIndex;
      const diagonal = table[(oldIndex + 1) * width + newIndex + 1] ?? 0;
      const below = table[(oldIndex + 1) * width + newIndex] ?? 0;
      const right = table[cell + 1] ?? 0;
      table[cell] =
        original[oldIndex] === current[newIndex] ? diagonal + 1 : Math.max(below, right);
    }
  }

  const operations: Operation[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < original.length && newIndex < current.length) {
    const oldText = original[oldIndex];
    const newText = current[newIndex];
    if (oldText === newText) {
      operations.push({ kind: 'equal', text: oldText ?? '' });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      (table[(oldIndex + 1) * width + newIndex] ?? 0) >=
      (table[oldIndex * width + newIndex + 1] ?? 0)
    ) {
      operations.push({ kind: 'removed', text: oldText ?? '' });
      oldIndex += 1;
    } else {
      operations.push({ kind: 'added', text: newText ?? '' });
      newIndex += 1;
    }
  }
  while (oldIndex < original.length) {
    operations.push({ kind: 'removed', text: original[oldIndex] ?? '' });
    oldIndex += 1;
  }
  while (newIndex < current.length) {
    operations.push({ kind: 'added', text: current[newIndex] ?? '' });
    newIndex += 1;
  }
  return operations;
};

export const buildChangedLineDiff = (
  originalSource: string,
  currentSource: string
): ChangedLineDiff => {
  const original = sourceLines(originalSource);
  const current = sourceLines(currentSource);
  if (original.lines.length + current.lines.length > MAX_DIFF_LINES) {
    return { rows: [], tooLarge: true };
  }

  const operations = changedMiddle(original.lines, current.lines);
  const rows: ChangedLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let omitted = false;

  for (const operation of operations) {
    if (operation.kind === 'equal') {
      omitted = rows.length > 0;
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (omitted) {
      rows.push({ kind: 'ellipsis', oldLine, newLine, text: 'Unchanged lines omitted' });
      omitted = false;
    }
    if (operation.kind === 'removed') {
      rows.push({ kind: 'removed', oldLine, newLine: null, text: operation.text });
      oldLine += 1;
    } else {
      rows.push({ kind: 'added', oldLine: null, newLine, text: operation.text });
      newLine += 1;
    }
  }

  if (original.trailingNewline !== current.trailingNewline) {
    rows.push({
      kind: 'meta',
      text: current.trailingNewline
        ? 'New file ends with a newline'
        : 'New file does not end with a newline',
    });
  }

  return { rows, tooLarge: false };
};
