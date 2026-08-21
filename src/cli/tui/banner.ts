// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  The wordmark shown on start-up: a gradient block logo with the same
 *  left-to-right colour sweep the Gemini CLI uses, plus a compact variant
 *  for narrow terminals.                                                */

import { Rgb, fg, gradient, interpolate, stringWidth } from './ansi';
import { palette, wordmarkGradient } from './theme';

const GLYPH_HEIGHT = 5;

/* 5x5 block glyphs, one entry per letter of the wordmark. */
const GLYPHS: Record<string, string[]> = {
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  L: ['█    ', '█    ', '█    ', '█    ', '█████'],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  B: ['████ ', '█   █', '████ ', '█   █', '████ '],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  Y: ['█   █', ' █ █ ', '  █  ', '  █  ', '  █  ']
};

const WORD = 'OLLIBERTY';

function renderRows(word: string): string[] {
  const rows: string[] = [];
  for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
    rows.push(
      Array.from(word)
        .map(letter => GLYPHS[letter]?.[row] ?? '     ')
        .join(' ')
    );
  }
  return rows;
}

/** Colour every column by its horizontal position, so the sweep lines up
 *  across all five rows instead of restarting per row. */
function paintByColumn(rows: string[], stops: Rgb[]): string[] {
  const widest = Math.max(...rows.map(row => row.length), 1);

  return rows.map(row =>
    Array.from(row)
      .map((char, column) => {
        if (char === ' ') {
          return char;
        }
        const ratio = widest === 1 ? 0 : column / (widest - 1);
        const scaled = ratio * (stops.length - 1);
        const index = Math.min(stops.length - 2, Math.floor(scaled));
        return fg(interpolate(stops[index], stops[index + 1], scaled - index), char);
      })
      .join('')
  );
}

export interface BannerOptions {
  width: number;
  model: string;
  workspace: string;
  mode: string;
  version: string;
}

export function renderBanner(options: BannerOptions): string[] {
  const rows = renderRows(WORD);
  const logoWidth = Math.max(...rows.map(row => row.length));
  const lines: string[] = [];

  if (options.width >= logoWidth + 2) {
    lines.push(...paintByColumn(rows, wordmarkGradient));
  } else {
    lines.push(gradient('◆ OLLIBERTY', wordmarkGradient));
  }

  lines.push('');
  lines.push(
    `${fg(palette.muted, 'Local, private AI coding agent on your Ollama LLM server')}  ${fg(palette.faint, `v${options.version}`)}`
  );
  lines.push('');
  lines.push(`${fg(palette.faint, 'workspace')} ${fg(palette.text, options.workspace)}`);
  lines.push(
    `${fg(palette.faint, 'model')} ${fg(palette.text, options.model)}   ${fg(palette.faint, 'mode')} ${fg(palette.text, options.mode)}`
  );
  lines.push('');
  lines.push(fg(palette.muted, 'Tips for getting started:'));
  lines.push(`${fg(palette.faint, ' 1.')} Ask anything about this project — context comes from the local code index.`);
  lines.push(`${fg(palette.faint, ' 2.')} Mention files inline with ${fg(palette.teal, '@path/to/file')} to attach them.`);
  lines.push(`${fg(palette.faint, ' 3.')} ${fg(palette.teal, '/edit <instruction>')} proposes file changes; nothing is written until you ${fg(palette.teal, '/approve')}.`);
  lines.push(`${fg(palette.faint, ' 4.')} ${fg(palette.teal, '/agents <goal>')} fans out parallel sub-agents on the same local model.`);
  lines.push(`${fg(palette.faint, ' 5.')} ${fg(palette.teal, '/help')} lists every command, ${fg(palette.teal, 'Shift+Tab')} switches plan/auto.`);

  return lines.map(line => (stringWidth(line) > options.width ? line : line));
}
