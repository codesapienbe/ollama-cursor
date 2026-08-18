/*  Minimal unified diff generator.
 *  Used to show every proposed and applied change inline in the chat,
 *  so the user never has to guess what the agent touched.           */

export interface DiffStats {
  additions: number;
  removals: number;
}

export interface FileDiff extends DiffStats {
  filePath: string;
  isNewFile: boolean;
  unified: string;
  truncated: boolean;
}

const CONTEXT_LINES = 3;
const MAX_DIFF_LINES = 400;

type Op = { type: 'equal' | 'add' | 'remove'; line: string };

export function computeFileDiff(filePath: string, before: string, after: string): FileDiff {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const ops = diffLines(beforeLines, afterLines);

  const additions = ops.filter(op => op.type === 'add').length;
  const removals = ops.filter(op => op.type === 'remove').length;
  const rendered = renderUnified(ops);

  return {
    filePath,
    isNewFile: before.length === 0,
    additions,
    removals,
    unified: rendered.text,
    truncated: rendered.truncated
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

/** Emit only changed regions plus a few lines of surrounding context. */
function renderUnified(ops: Op[]): { text: string; truncated: boolean } {
  const changedIndexes = ops
    .map((op, index) => (op.type === 'equal' ? -1 : index))
    .filter(index => index !== -1);

  if (!changedIndexes.length) {
    return { text: '', truncated: false };
  }

  const keep = new Set<number>();
  for (const index of changedIndexes) {
    for (let offset = -CONTEXT_LINES; offset <= CONTEXT_LINES; offset += 1) {
      const candidate = index + offset;
      if (candidate >= 0 && candidate < ops.length) {
        keep.add(candidate);
      }
    }
  }

  const output: string[] = [];
  let truncated = false;
  let previousIndex = -1;

  for (const index of Array.from(keep).sort((left, right) => left - right)) {
    if (output.length >= MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    if (previousIndex !== -1 && index > previousIndex + 1) {
      output.push('@@');
    }
    const op = ops[index];
    const marker = op.type === 'add' ? '+' : op.type === 'remove' ? '-' : ' ';
    output.push(`${marker}${op.line}`);
    previousIndex = index;
  }

  return { text: output.join('\n'), truncated };
}
