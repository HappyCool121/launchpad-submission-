import { describe, expect, it } from 'vitest';
import { buildChangedLineDiff, MAX_DIFF_LINES } from '@/renderer/line-diff';

describe('changed-lines diff', () => {
  it('renders only removed and added lines with omissions between hunks', () => {
    const result = buildChangedLineDiff(
      'first\nold one\nshared\nshared again\nold two\nlast\n',
      'first\nnew one\nshared\nshared again\nnew two\nlast\n'
    );

    expect(result.tooLarge).toBe(false);
    expect(result.rows).toEqual([
      { kind: 'removed', oldLine: 2, newLine: null, text: 'old one' },
      { kind: 'added', oldLine: null, newLine: 2, text: 'new one' },
      { kind: 'ellipsis', oldLine: 5, newLine: 5, text: 'Unchanged lines omitted' },
      { kind: 'removed', oldLine: 5, newLine: null, text: 'old two' },
      { kind: 'added', oldLine: null, newLine: 5, text: 'new two' },
    ]);
  });

  it('handles created, deleted, reverted, and trailing-newline changes', () => {
    expect(buildChangedLineDiff('', 'created\n').rows).toEqual([
      { kind: 'added', oldLine: null, newLine: 1, text: 'created' },
      { kind: 'meta', text: 'New file ends with a newline' },
    ]);
    expect(buildChangedLineDiff('deleted\n', '').rows).toEqual([
      { kind: 'removed', oldLine: 1, newLine: null, text: 'deleted' },
      { kind: 'meta', text: 'New file does not end with a newline' },
    ]);
    expect(buildChangedLineDiff('same\n', 'same\n').rows).toEqual([]);
    expect(buildChangedLineDiff('same\n', 'same').rows).toEqual([
      { kind: 'meta', text: 'New file does not end with a newline' },
    ]);
  });

  it('returns a bounded explicit state for oversized files', () => {
    const oversized = Array.from({ length: MAX_DIFF_LINES + 1 }, () => 'line').join('\n');
    expect(buildChangedLineDiff(oversized, '')).toEqual({ rows: [], tooLarge: true });
  });
});
