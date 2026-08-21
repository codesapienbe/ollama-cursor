// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  ANSI primitives: colour degradation, display width, and style-preserving
 *  wrapping. Hand-rolled on purpose — Olliberty ships no runtime
 *  dependencies, so the CLI cannot pull in a terminal toolkit.           */

export type ColorDepth = 'none' | 'basic' | 'ansi256' | 'truecolor';

/* Built from a char code so no raw control byte ever lands in the source. */
export const ESC = String.fromCharCode(27);
export const CSI = `${ESC}[`;
const RESET = `${CSI}0m`;
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');
const ANSI_PREFIX = new RegExp(`^${ESC}\\[[0-9;?]*[A-Za-z]`);

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

function detectColorDepth(): ColorDepth {
  if (process.env.NO_COLOR !== undefined || process.env.OLLIBERTY_NO_COLOR !== undefined) {
    return 'none';
  }
  if (process.env.FORCE_COLOR === '0') {
    return 'none';
  }

  const forced = process.env.FORCE_COLOR;
  if (!process.stdout.isTTY && !forced) {
    return 'none';
  }

  const term = (process.env.TERM ?? '').toLowerCase();
  if (term === 'dumb') {
    return 'none';
  }

  const colorTerm = (process.env.COLORTERM ?? '').toLowerCase();
  if (colorTerm.includes('truecolor') || colorTerm.includes('24bit') || forced === '3') {
    return 'truecolor';
  }
  if (term.includes('256') || forced === '2') {
    return 'ansi256';
  }
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') {
    return 'ansi256';
  }
  return 'basic';
}

let colorDepth: ColorDepth = detectColorDepth();

export function setColorDepth(depth: ColorDepth): void {
  colorDepth = depth;
}

export function getColorDepth(): ColorDepth {
  return colorDepth;
}

export function colorsEnabled(): boolean {
  return colorDepth !== 'none';
}

function toAnsi256(color: Rgb): number {
  const { r, g, b } = color;
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    if (r < 8) { return 16; }
    if (r > 248) { return 231; }
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16
    + 36 * Math.round((r / 255) * 5)
    + 6 * Math.round((g / 255) * 5)
    + Math.round((b / 255) * 5);
}

function toBasic(color: Rgb, background: boolean): string {
  const { r, g, b } = color;
  const brightness = (r + g + b) / 3;
  const bit = (value: number) => (value > 110 ? 1 : 0);
  const code = bit(r) + bit(g) * 2 + bit(b) * 4;
  const base = background ? 40 : 30;
  return brightness > 170 ? `${base + 60 + code}` : `${base + code}`;
}

function colorCode(color: Rgb, background: boolean): string {
  switch (colorDepth) {
    case 'truecolor':
      return `${background ? 48 : 38};2;${color.r};${color.g};${color.b}`;
    case 'ansi256':
      return `${background ? 48 : 38};5;${toAnsi256(color)}`;
    case 'basic':
      return toBasic(color, background);
    default:
      return '';
  }
}

export function fg(color: Rgb, text: string): string {
  if (colorDepth === 'none' || !text) {
    return text;
  }
  return `${CSI}${colorCode(color, false)}m${text}${CSI}39m`;
}

export function bg(color: Rgb, text: string): string {
  if (colorDepth === 'none' || !text) {
    return text;
  }
  return `${CSI}${colorCode(color, true)}m${text}${CSI}49m`;
}

export interface PaintOptions {
  fg?: Rgb;
  bg?: Rgb;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
}

export function paint(text: string, options: PaintOptions = {}): string {
  if (colorDepth === 'none' || !text) {
    return text;
  }

  const codes: string[] = [];
  if (options.bold) { codes.push('1'); }
  if (options.dim) { codes.push('2'); }
  if (options.italic) { codes.push('3'); }
  if (options.underline) { codes.push('4'); }
  if (options.inverse) { codes.push('7'); }
  if (options.strike) { codes.push('9'); }
  if (options.fg) { codes.push(colorCode(options.fg, false)); }
  if (options.bg) { codes.push(colorCode(options.bg, true)); }

  return codes.length ? `${CSI}${codes.join(';')}m${text}${RESET}` : text;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd]
];

function isWide(codePoint: number): boolean {
  return WIDE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function isZeroWidth(codePoint: number): boolean {
  return (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x200b && codePoint <= 0x200f)
    || codePoint === 0xfe0e
    || codePoint === 0xfe0f
    || (codePoint >= 0x20d0 && codePoint <= 0x20f0);
}

/** Printable columns a string occupies, ANSI sequences excluded. */
export function stringWidth(text: string): number {
  const plain = stripAnsi(text);
  let width = 0;
  let joinPending = false;

  for (const char of plain) {
    const codePoint = char.codePointAt(0) ?? 0;

    if (codePoint === 0x200d) {
      /* Zero-width joiner: the cluster renders as one glyph, so whatever
         follows must not add width again. */
      joinPending = true;
      continue;
    }
    if (isZeroWidth(codePoint)) {
      continue;
    }
    if (joinPending) {
      joinPending = false;
      continue;
    }
    if (codePoint < 32) {
      continue;
    }

    width += isWide(codePoint) ? 2 : 1;
  }

  return width;
}

/** Truncate to `limit` columns, keeping ANSI styling intact. */
export function truncate(text: string, limit: number, ellipsis = '…'): string {
  if (limit <= 0) {
    return '';
  }
  if (stringWidth(text) <= limit) {
    return text;
  }

  const target = Math.max(0, limit - stringWidth(ellipsis));
  let width = 0;
  let output = '';
  let index = 0;

  while (index < text.length) {
    if (text[index] === ESC) {
      const match = ANSI_PREFIX.exec(text.slice(index));
      if (match) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }

    const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
    const charWidth = stringWidth(char);
    if (width + charWidth > target) {
      break;
    }
    output += char;
    width += charWidth;
    index += char.length;
  }

  return `${output}${RESET}${ellipsis}`;
}

interface Segment {
  kind: 'style' | 'text';
  value: string;
}

function tokenize(text: string): Segment[] {
  const segments: Segment[] = [];
  let index = 0;
  let buffer = '';

  while (index < text.length) {
    if (text[index] === ESC) {
      const match = ANSI_PREFIX.exec(text.slice(index));
      if (match) {
        if (buffer) {
          segments.push({ kind: 'text', value: buffer });
          buffer = '';
        }
        segments.push({ kind: 'style', value: match[0] });
        index += match[0].length;
        continue;
      }
    }
    const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
    buffer += char;
    index += char.length;
  }

  if (buffer) {
    segments.push({ kind: 'text', value: buffer });
  }
  return segments;
}

/** Word-wrap one logical line to `width` columns, re-applying active styles. */
export function wrapLine(text: string, width: number, hangingIndent = ''): string[] {
  if (width <= 1) {
    return [text];
  }

  const segments = tokenize(text);
  const lines: string[] = [];
  let activeStyles: string[] = [];
  let current = '';
  let currentWidth = 0;
  let pendingWord = '';
  let pendingWordWidth = 0;
  let firstLine = true;

  const lineLimit = () => (firstLine ? width : Math.max(1, width - stringWidth(hangingIndent)));

  const pushLine = () => {
    const prefix = firstLine ? '' : hangingIndent;
    lines.push(`${prefix}${current}${activeStyles.length ? RESET : ''}`);
    firstLine = false;
    current = activeStyles.join('');
    currentWidth = 0;
  };

  const commitWord = () => {
    if (!pendingWord) {
      return;
    }
    if (currentWidth + pendingWordWidth > lineLimit() && currentWidth > 0) {
      pushLine();
    }
    current += pendingWord;
    currentWidth += pendingWordWidth;
    pendingWord = '';
    pendingWordWidth = 0;
  };

  for (const segment of segments) {
    if (segment.kind === 'style') {
      if (segment.value === RESET) {
        activeStyles = [];
      } else {
        activeStyles.push(segment.value);
      }
      pendingWord += segment.value;
      continue;
    }

    for (const char of segment.value) {
      if (char === ' ') {
        commitWord();
        if (currentWidth === 0) {
          /* Never start a wrapped line with the space we broke on. */
          continue;
        }
        if (currentWidth + 1 > lineLimit()) {
          pushLine();
          continue;
        }
        current += ' ';
        currentWidth += 1;
        continue;
      }

      const charWidth = stringWidth(char);
      if (pendingWordWidth + charWidth > lineLimit()) {
        /* A single word longer than the line: hard-break it. */
        commitWord();
        if (currentWidth + charWidth > lineLimit()) {
          pushLine();
        }
        current += char;
        currentWidth += charWidth;
        continue;
      }

      pendingWord += char;
      pendingWordWidth += charWidth;
    }
  }

  commitWord();
  const prefix = firstLine ? '' : hangingIndent;
  lines.push(`${prefix}${current}${activeStyles.length ? RESET : ''}`);

  return lines;
}

/** Wrap a block of text (may contain newlines) to `width` columns. */
export function wrapText(text: string, width: number, hangingIndent = ''): string[] {
  return text
    .split('\n')
    .reduce<string[]>((lines, line) => lines.concat(line.trim() ? wrapLine(line, width, hangingIndent) : ['']), []);
}

export function padEnd(text: string, width: number): string {
  const missing = width - stringWidth(text);
  return missing > 0 ? `${text}${' '.repeat(missing)}` : text;
}

export function padStart(text: string, width: number): string {
  const missing = width - stringWidth(text);
  return missing > 0 ? `${' '.repeat(missing)}${text}` : text;
}

export const cursor = {
  hide: `${CSI}?25l`,
  show: `${CSI}?25h`,
  up: (count: number) => (count > 0 ? `${CSI}${count}A` : ''),
  down: (count: number) => (count > 0 ? `${CSI}${count}B` : ''),
  right: (count: number) => (count > 0 ? `${CSI}${count}C` : ''),
  left: (count: number) => (count > 0 ? `${CSI}${count}D` : ''),
  toColumn: (column: number) => `${CSI}${Math.max(1, column)}G`,
  eraseLine: `${CSI}2K`,
  eraseDown: `${CSI}J`,
  clearScreen: `${CSI}2J${CSI}H`
};

export function interpolate(from: Rgb, to: Rgb, ratio: number): Rgb {
  const clamped = Math.min(1, Math.max(0, ratio));
  return {
    r: Math.round(from.r + (to.r - from.r) * clamped),
    g: Math.round(from.g + (to.g - from.g) * clamped),
    b: Math.round(from.b + (to.b - from.b) * clamped)
  };
}

/** Left-to-right gradient across the visible characters of a string. */
export function gradient(text: string, stops: Rgb[]): string {
  if (colorDepth === 'none' || stops.length === 0) {
    return text;
  }
  if (stops.length === 1) {
    return fg(stops[0], text);
  }

  const characters = Array.from(text);
  const printable = characters.filter(char => char.trim().length > 0).length || 1;
  let seen = 0;

  return characters
    .map(char => {
      if (!char.trim()) {
        return char;
      }
      const ratio = printable === 1 ? 0 : seen / (printable - 1);
      seen += 1;
      const scaled = ratio * (stops.length - 1);
      const index = Math.min(stops.length - 2, Math.floor(scaled));
      return fg(interpolate(stops[index], stops[index + 1], scaled - index), char);
    })
    .join('');
}
