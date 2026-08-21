/*  Terminal palette.
 *  Cool blue → violet → coral gradient for the wordmark (the Gemini CLI
 *  look the user asked for), with OpenCode-style diff and agent colours
 *  and Claude-Code-style muted chrome.                                  */

import { Rgb } from './ansi';

export const palette = {
  blue: { r: 74, g: 144, b: 226 },
  indigo: { r: 108, g: 118, b: 224 },
  violet: { r: 152, g: 106, b: 214 },
  magenta: { r: 199, g: 102, b: 189 },
  coral: { r: 226, g: 106, b: 118 },
  amber: { r: 224, g: 166, b: 72 },
  green: { r: 86, g: 182, b: 118 },
  teal: { r: 76, g: 184, b: 184 },
  red: { r: 214, g: 88, b: 88 },
  text: { r: 226, g: 228, b: 235 },
  muted: { r: 150, g: 156, b: 170 },
  faint: { r: 104, g: 110, b: 124 },
  border: { r: 72, g: 78, b: 92 },
  panel: { r: 30, g: 33, b: 42 },
  addFg: { r: 150, g: 220, b: 168 },
  addBg: { r: 26, g: 56, b: 38 },
  removeFg: { r: 236, g: 152, b: 156 },
  removeBg: { r: 62, g: 30, b: 34 },
  gutter: { r: 96, g: 102, b: 116 },
  hunk: { r: 122, g: 132, b: 196 }
} satisfies Record<string, Rgb>;

/** Wordmark gradient stops, left to right. */
export const wordmarkGradient: Rgb[] = [
  palette.blue,
  palette.indigo,
  palette.violet,
  palette.magenta,
  palette.coral
];

export const roleColor = {
  user: palette.teal,
  assistant: palette.violet,
  system: palette.amber
} satisfies Record<string, Rgb>;

export const syntax = {
  keyword: palette.magenta,
  string: palette.green,
  number: palette.amber,
  comment: palette.faint,
  punctuation: palette.muted,
  identifier: palette.text
} satisfies Record<string, Rgb>;

export const glyphs = {
  bulletRun: '●',
  bulletDone: '●',
  branch: '⎿',
  arrow: '›',
  check: '✔',
  cross: '✖',
  stop: '⏹',
  info: '•',
  spinnerFrames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  boxTopLeft: '╭',
  boxTopRight: '╮',
  boxBottomLeft: '╰',
  boxBottomRight: '╯',
  boxHorizontal: '─',
  boxVertical: '│',
  treeBranch: '├─',
  treeLast: '╰─',
  treePipe: '│ '
};
