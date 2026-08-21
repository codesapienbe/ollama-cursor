// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Right-hand sub-task panel.
 *  While a delegated run is in flight the frame splits in two: the activity
 *  feed and streaming tail keep the left column, and every sub-task gets a
 *  tinted block on the right that updates on the same tick the spinner does.
 *
 *  Background fills are built by hand rather than with `paint`, because
 *  `paint` and `truncate` close their styling with a full SGR reset — that
 *  would drop the row background halfway through the line. Text is coloured
 *  with `fg` (which resets the foreground only) and the finished row is
 *  wrapped in a single `bg`.                                              */

import { AgentRunView } from '../session';
import { CSI, Rgb, bg, colorsEnabled, fg, stringWidth } from './ansi';
import { spinnerFrame } from './statusview';
import { glyphs, palette, taskTint } from './theme';

/** Terminals narrower than this keep the stacked tree; two columns would not fit. */
export const MIN_SPLIT_COLUMNS = 76;
const MIN_PANEL_WIDTH = 26;
const MAX_PANEL_WIDTH = 42;
/** Columns between the left column and the panel. */
export const PANEL_GAP = 2;
const ROWS_PER_TASK = 3;

export interface TaskPanelOptions {
  width: number;
  tick: number;
  /** Hard cap on panel height, header included. */
  maxRows?: number;
}

export function taskPanelWidth(totalWidth: number): number {
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.floor(totalWidth * 0.34)));
}

export function canSplitColumns(totalWidth: number): boolean {
  return totalWidth >= MIN_SPLIT_COLUMNS;
}

/** Width left for the main column once the panel and its gap are taken. */
export function taskPanelBodyWidth(totalWidth: number): number {
  return totalWidth - taskPanelWidth(totalWidth) - PANEL_GAP;
}

/**
 * One tinted block per sub-task: name and elapsed time, a progress bar with
 * the streamed character count, and the current detail line.
 */
export function renderTaskPanel(tasks: AgentRunView[], options: TaskPanelOptions): string[] {
  if (!tasks.length || options.width < MIN_PANEL_WIDTH) {
    return [];
  }

  const width = options.width;
  const maxRows = Math.max(1 + ROWS_PER_TASK, options.maxRows ?? 1 + tasks.length * ROWS_PER_TASK);
  /* Shrink the blocks before dropping tasks: a task the panel does not show
     is a task the user cannot see running at all. */
  const budget = maxRows - 1;
  const rowsPerTask = Math.max(1, Math.min(ROWS_PER_TASK, Math.floor(budget / tasks.length)));
  const visible = tasks.slice(0, Math.max(1, Math.floor(budget / rowsPerTask)));

  const lines = [renderHeader(tasks, width)];
  visible.forEach((task, index) => {
    lines.push(...renderTask(task, index, rowsPerTask, width, options.tick));
  });

  const hidden = tasks.length - visible.length;
  if (hidden > 0) {
    lines.push(padPlain(fg(palette.faint, `  +${hidden} more`), width));
  }

  return lines;
}

function renderHeader(tasks: AgentRunView[], width: number): string {
  const done = tasks.filter(task => task.status === 'completed').length;
  const label = ` Sub-tasks ${done}/${tasks.length} `;
  const rule = Math.max(0, width - stringWidth(label) - 1);
  return `${fg(palette.border, glyphs.boxHorizontal)}${strong(label, palette.text)}${fg(palette.border, glyphs.boxHorizontal.repeat(rule))}`;
}

function renderTask(
  task: AgentRunView,
  index: number,
  rowsPerTask: number,
  width: number,
  tick: number
): string[] {
  const tint = taskTint(index);
  const running = task.status === 'running';
  /* Finished work stays in its own colour but recedes, so the running task is
     the one that reads first. */
  const fill = running ? tint.bg : mix(tint.bg, palette.panel, 0.55);
  const rows = [
    tintedRow(width, fill, tint.accent, {
      left: `${statusMarker(task, tick)} ${task.name}`,
      leftColor: running ? palette.text : palette.muted,
      strong: running,
      right: elapsedLabel(task),
      rightColor: palette.faint
    })
  ];

  if (rowsPerTask >= 2) {
    /* The bar carries its own colours, so it has to be sized to exactly the
       space `tintedRow` will leave it — nothing clips it afterwards. */
    const label = progressLabel(task);
    const barWidth = Math.max(4, width - 3 - stringWidth(label) - 1);
    rows.push(
      tintedRow(width, fill, tint.accent, {
        left: progressBar(barWidth, task, tick, tint.accent),
        leftColor: palette.faint,
        prePainted: true,
        right: label,
        rightColor: palette.faint
      })
    );
  }

  if (rowsPerTask >= 3) {
    rows.push(
      tintedRow(width, fill, tint.accent, {
        left: detailText(task),
        leftColor: palette.muted
      })
    );
  }

  return rows;
}

interface RowContent {
  left: string;
  leftColor: Rgb;
  strong?: boolean;
  /** Set when `left` already carries its own colours. */
  prePainted?: boolean;
  right?: string;
  rightColor?: Rgb;
}

/** One panel row: accent bar, body, and a background that spans the width. */
function tintedRow(width: number, tint: Rgb, accent: Rgb, content: RowContent): string {
  const inner = Math.max(1, width - 3);
  const right = content.right ?? '';
  const rightWidth = right ? stringWidth(right) + 1 : 0;
  const available = Math.max(0, inner - rightWidth);

  const leftText = content.prePainted ? content.left : clip(content.left, available);
  const leftWidth = stringWidth(leftText);
  const padding = ' '.repeat(Math.max(0, available - leftWidth));
  const body = content.prePainted ? leftText : colorize(leftText, content.leftColor, content.strong);
  const rightBody = right ? ` ${fg(content.rightColor ?? palette.faint, right)}` : '';

  return bg(tint, `${fg(accent, glyphs.taskBar)} ${body}${padding}${rightBody} `);
}

function statusMarker(task: AgentRunView, tick: number): string {
  switch (task.status) {
    case 'running':
      return spinnerFrame(tick);
    case 'completed':
      return glyphs.check;
    case 'failed':
      return glyphs.cross;
    default:
      return glyphs.info;
  }
}

/**
 * A local model reports no total, so a running task gets a sweeping block
 * instead of a fake percentage; finished tasks get a solid bar.
 */
function progressBar(width: number, task: AgentRunView, tick: number, accent: Rgb): string {
  const cells = Math.max(4, width);

  if (task.status === 'completed') {
    return fg(palette.green, glyphs.barFill.repeat(cells));
  }
  if (task.status === 'failed') {
    return fg(palette.red, glyphs.barFill.repeat(cells));
  }
  if (task.status !== 'running') {
    return fg(palette.border, glyphs.barTrack.repeat(cells));
  }

  const head = Math.max(2, Math.round(cells / 5));
  const start = tick % cells;
  const lit = new Set<number>();
  for (let offset = 0; offset < head; offset += 1) {
    lit.add((start + offset) % cells);
  }

  let bar = '';
  for (let cell = 0; cell < cells; cell += 1) {
    bar += lit.has(cell)
      ? fg(accent, glyphs.barFill)
      : fg(palette.border, glyphs.barTrack);
  }
  return bar;
}

function progressLabel(task: AgentRunView): string {
  if (task.status === 'queued') {
    return 'queued';
  }
  const chars = task.chars ?? 0;
  if (!chars) {
    if (task.status === 'running') {
      return '…';
    }
    return task.status === 'failed' ? 'failed' : 'done';
  }
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k ch` : `${chars} ch`;
}

function detailText(task: AgentRunView): string {
  const detail = (task.detail ?? '').trim();
  if (detail) {
    return detail;
  }
  return task.status === 'queued' ? `waiting · ${task.goal}` : task.goal;
}

function elapsedLabel(task: AgentRunView): string {
  if (!task.startedAt) {
    return '';
  }
  const elapsed = Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt);
  if (elapsed < 1000) {
    return `${elapsed}ms`;
  }
  if (elapsed < 60_000) {
    return `${(elapsed / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.round((elapsed % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/** Bold without a full reset, so the row background survives. */
function strong(text: string, color: Rgb): string {
  const painted = fg(color, text);
  return colorsEnabled() ? `${CSI}1m${painted}${CSI}22m` : painted;
}

function colorize(text: string, color: Rgb, bold = false): string {
  return bold ? strong(text, color) : fg(color, text);
}

/** Width-safe truncation for plain text that emits no reset sequence. */
function clip(text: string, limit: number): string {
  if (limit <= 0) {
    return '';
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (stringWidth(normalized) <= limit) {
    return normalized;
  }

  let output = '';
  let width = 0;
  for (const char of normalized) {
    const charWidth = stringWidth(char);
    if (width + charWidth > limit - 1) {
      break;
    }
    output += char;
    width += charWidth;
  }
  return `${output}…`;
}

function padPlain(text: string, width: number): string {
  const missing = width - stringWidth(text);
  return missing > 0 ? `${text}${' '.repeat(missing)}` : text;
}

function mix(from: Rgb, to: Rgb, ratio: number): Rgb {
  return {
    r: Math.round(from.r + (to.r - from.r) * ratio),
    g: Math.round(from.g + (to.g - from.g) * ratio),
    b: Math.round(from.b + (to.b - from.b) * ratio)
  };
}

/**
 * Glue the main column and the panel into one block of frame lines. Either
 * side may be shorter; the missing rows become blanks.
 */
export function composeColumns(body: string[], panel: string[], bodyWidth: number, gap = PANEL_GAP): string[] {
  const rows = Math.max(body.length, panel.length);
  const spacer = ' '.repeat(Math.max(0, gap));
  const lines: string[] = [];

  for (let row = 0; row < rows; row += 1) {
    const left = body[row] ?? '';
    const right = panel[row] ?? '';
    if (!right) {
      lines.push(left);
      continue;
    }
    lines.push(`${padPlain(left, bodyWidth)}${spacer}${right}`);
  }

  return lines;
}
