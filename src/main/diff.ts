// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Minimal unified diff generator.
 *  Used to show every proposed and applied change inline in the chat, so the
 *  user never has to guess what the agent touched. The structured hunks are
 *  what the CLI paints as a diff panel; the unified text is what the webview
 *  renders in a fenced block.                                              */

export interface DiffStats {
  additions: number;
  removals: number;
}

export type DiffLineType = 'equal' | 'add' | 'remove';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** 1-based line number in the original file, when the line exists there. */
  oldLine?: number;
  /** 1-based line number in the new file, when the line exists there. */
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff extends DiffStats {
  filePath: string;
  isNewFile: boolean;
  unified: string;
  truncated: boolean;
  hunks: DiffHunk[];
}

const CONTEXT_LINES = 3;
const MAX_DIFF_LINES = 400;

type Op = { type: DiffLineType; line: string };

export function computeFileDiff(filePath: string, before: string, after: string): FileDiff {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const ops = diffLines(beforeLines, afterLines);

  const additions = ops.filter(op => op.type === 'add').length;
  const removals = ops.filter(op => op.type === 'remove').length;
  const { hunks, truncated } = buildHunks(ops);

  return {
    filePath,
    isNewFile: before.length === 0,
    additions,
    removals,
    unified: renderUnified(hunks),
    truncated,
    hunks
  };
}

export function formatDiffStats(diff: DiffStats): string {
  const parts: string[] = [];
  if (diff.additions) {
    parts.push(`${diff.additions} addition${diff.additions === 1 ? '' : 's'}`);
  }
  if (diff.removals) {
    parts.push(`${diff.removals} removal${diff.removals === 1 ? '' : 's'}`);
  }
  return parts.length ? parts.join(' and ') : 'no line changes';
}

/** Chat-ready block: a Claude-style header line plus a fenced diff. */
export function formatDiffForChat(diff: FileDiff, verb: 'Update' | 'Create' | 'Applied'): string {
  const label = diff.isNewFile && verb === 'Update' ? 'Create' : verb;
  const lines = [
    `● ${label}(${diff.filePath})`,
    `  ⎿ ${formatDiffStats(diff)}${diff.truncated ? ' (diff truncated)' : ''}`
  ];

  if (diff.unified.trim()) {
    lines.push('', '```diff', diff.unified, '```');
  }

  return lines.join('\n');
}

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  /* A trailing newline yields a final empty element that is not a real line. */
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** Classic LCS diff. Falls back to a wholesale replace on very large files. */
function diffLines(before: string[], after: string[]): Op[] {
  const maxCells = 4_000_000;
  if ((before.length + 1) * (after.length + 1) > maxCells) {
    return [
      ...before.map<Op>(line => ({ type: 'remove', line })),
      ...after.map<Op>(line => ({ type: 'add', line }))
    ];
  }

  const rows = before.length;
  const cols = after.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i][j] = before[i] === after[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;

  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      ops.push({ type: 'equal', line: before[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'remove', line: before[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', line: after[j] });
      j += 1;
    }
  }

  while (i < rows) {
    ops.push({ type: 'remove', line: before[i] });
    i += 1;
  }
  while (j < cols) {
    ops.push({ type: 'add', line: after[j] });
    j += 1;
  }

  return ops;
}

/** Group changed regions (plus context) into hunks with real line numbers. */
function buildHunks(ops: Op[]): { hunks: DiffHunk[]; truncated: boolean } {
  const numbered: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const op of ops) {
    if (op.type === 'equal') {
      oldLine += 1;
      newLine += 1;
      numbered.push({ type: 'equal', text: op.line, oldLine, newLine });
      continue;
    }
    if (op.type === 'remove') {
      oldLine += 1;
      numbered.push({ type: 'remove', text: op.line, oldLine });
      continue;
    }
    newLine += 1;
    numbered.push({ type: 'add', text: op.line, newLine });
  }

  const changedIndexes = numbered
    .map((line, index) => (line.type === 'equal' ? -1 : index))
    .filter(index => index !== -1);

  if (!changedIndexes.length) {
    return { hunks: [], truncated: false };
  }

  const keep = new Set<number>();
  for (const index of changedIndexes) {
    for (let offset = -CONTEXT_LINES; offset <= CONTEXT_LINES; offset += 1) {
      const candidate = index + offset;
      if (candidate >= 0 && candidate < numbered.length) {
        keep.add(candidate);
      }
    }
  }

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  let previousIndex = -1;
  let emitted = 0;
  let truncated = false;

  const flush = () => {
    if (!current.length) {
      return;
    }
    hunks.push(toHunk(current));
    current = [];
  };

  for (const index of Array.from(keep).sort((left, right) => left - right)) {
    if (emitted >= MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    if (previousIndex !== -1 && index > previousIndex + 1) {
      flush();
    }
    current.push(numbered[index]);
    emitted += 1;
    previousIndex = index;
  }
  flush();

  return { hunks, truncated };
}

function toHunk(lines: DiffLine[]): DiffHunk {
  const oldNumbers = lines.filter(line => line.oldLine !== undefined).map(line => line.oldLine as number);
  const newNumbers = lines.filter(line => line.newLine !== undefined).map(line => line.newLine as number);

  return {
    oldStart: oldNumbers.length ? oldNumbers[0] : 0,
    oldLines: oldNumbers.length,
    newStart: newNumbers.length ? newNumbers[0] : 0,
    newLines: newNumbers.length,
    lines
  };
}

/** Standard unified text, so any renderer that knows diffs can read it. */
function renderUnified(hunks: DiffHunk[]): string {
  const output: string[] = [];

  for (const hunk of hunks) {
    output.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      const marker = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      output.push(`${marker}${line.text}`);
    }
  }

  return output.join('\n');
}
