// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Diff painting: the OpenCode-style file panel — a path header with the
 *  +/− tally, then numbered rows with tinted add/remove backgrounds and
 *  hunk separators. Everything is driven from standard unified text, so the
 *  same renderer handles pending proposals, applied changes, and any diff
 *  the model happens to print in a fenced block.                          */

import { FileDiff } from '../../main/diff';
import { padStart, paint, stringWidth, truncate } from './ansi';
import { palette } from './theme';

const MAX_ROWS_PER_FILE = 240;

interface HunkPosition {
  oldLine: number;
  newLine: number;
}

function parseHunkHeader(row: string): HunkPosition | null {
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(row);
  if (!match) {
    return null;
  }
  return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}

/** Render unified diff text with real line numbers recovered from `@@`. */
export function renderUnifiedText(unified: string, width: number): string[] {
  const rows = unified.split('\n');
  const gutterWidth = Math.max(3, String(highestLineNumber(rows)).length);
  const contentWidth = Math.max(8, width - gutterWidth - 4);
  const output: string[] = [];

  let position: HunkPosition | null = null;
  let emitted = 0;

  for (const row of rows) {
    if (emitted >= MAX_ROWS_PER_FILE) {
      output.push(paint('    … diff truncated', { fg: palette.faint, italic: true }));
      break;
    }

    const hunk = parseHunkHeader(row);
    if (hunk) {
      position = { ...hunk };
      output.push(
        `${' '.repeat(gutterWidth)} ${paint('⋮', { fg: palette.gutter })} ${paint(row, { fg: palette.hunk })}`
      );
      continue;
    }

    const marker = row.charAt(0);
    const text = row.slice(1).replace(/\t/g, '  ');
    const content = truncate(text, contentWidth);
    const padding = Math.max(0, contentWidth - stringWidth(content));

    if (marker === '+') {
      const number = position ? position.newLine : undefined;
      if (position) {
        position.newLine += 1;
      }
      output.push(
        paint(padStart(number === undefined ? '' : String(number), gutterWidth), { fg: palette.addFg })
          + paint(` + ${content}${' '.repeat(padding)}`, { fg: palette.addFg, bg: palette.addBg })
      );
      emitted += 1;
      continue;
    }

    if (marker === '-') {
      const number = position ? position.oldLine : undefined;
      if (position) {
        position.oldLine += 1;
      }
      output.push(
        paint(padStart(number === undefined ? '' : String(number), gutterWidth), { fg: palette.removeFg })
          + paint(` - ${content}${' '.repeat(padding)}`, { fg: palette.removeFg, bg: palette.removeBg })
      );
      emitted += 1;
      continue;
    }

    const number = position ? position.newLine : undefined;
    if (position) {
      position.oldLine += 1;
      position.newLine += 1;
    }
    output.push(
      paint(padStart(number === undefined ? '' : String(number), gutterWidth), { fg: palette.gutter })
        + `   ${paint(content, { fg: palette.muted })}`
    );
    emitted += 1;
  }

  return output;
}

function highestLineNumber(rows: string[]): number {
  let highest = 0;
  let position: HunkPosition | null = null;

  for (const row of rows) {
    const hunk = parseHunkHeader(row);
    if (hunk) {
      position = { ...hunk };
      continue;
    }
    if (!position) {
      continue;
    }
    if (row.startsWith('+')) {
      position.newLine += 1;
    } else if (row.startsWith('-')) {
      position.oldLine += 1;
    } else {
      position.oldLine += 1;
      position.newLine += 1;
    }
    highest = Math.max(highest, position.oldLine, position.newLine);
  }

  return highest;
}

/** One-line summary used for pending-change banners. */
export function renderDiffSummaryLine(diff: FileDiff, width: number): string {
  const line = [
    paint('⎿', { fg: palette.border }),
    paint(diff.filePath, { fg: palette.text }),
    paint(`+${diff.additions}`, { fg: palette.addFg }),
    paint(`−${diff.removals}`, { fg: palette.removeFg }),
    diff.isNewFile ? paint('(new file)', { fg: palette.faint }) : ''
  ].filter(Boolean).join(' ');

  return truncate(`  ${line}`, width);
}
