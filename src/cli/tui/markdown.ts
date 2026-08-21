/*  Markdown → ANSI.
 *  Every transcript entry the engine produces is markdown (the plugin renders
 *  the same strings in a webview), so this is the CLI's whole rendering
 *  surface: headings, lists, tables, fenced code with light syntax tinting,
 *  and ```diff blocks routed to the OpenCode-style diff painter.          */

import { padEnd, paint, stringWidth, truncate, wrapText } from './ansi';
import { renderUnifiedText } from './diffview';
import { glyphs, palette, syntax } from './theme';

const KEYWORDS = [
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new',
  'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'interface',
  'type', 'enum', 'extends', 'implements', 'public', 'private', 'protected', 'static', 'readonly',
  'def', 'elif', 'lambda', 'pass', 'raise', 'with', 'yield', 'fn', 'impl', 'struct', 'match',
  'package', 'func', 'defer', 'select', 'case', 'switch', 'break', 'continue', 'true',
  'false', 'null', 'nil', 'None', 'True', 'False', 'self', 'this'
];

const COMMENT_PREFIXES = ['//', '#', '--', ';'];

/* Sentinel for stashing already-styled inline spans. Built from a char code
   so the source file stays free of raw control bytes. */
const MARK = String.fromCharCode(2);
const MARK_PATTERN = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');

export interface MarkdownOptions {
  width: number;
  /** Indent applied to every produced line (used for message gutters). */
  indent?: string;
}

export function renderMarkdown(markdown: string, options: MarkdownOptions): string[] {
  const width = Math.max(20, options.width);
  const indent = options.indent ?? '';
  const contentWidth = Math.max(16, width - stringWidth(indent));
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = /^\s*```(\S*)\s*$/.exec(line);

    if (fence) {
      const language = fence[1].toLowerCase();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      output.push(...renderCodeBlock(body, language, contentWidth));
      continue;
    }

    output.push(...renderBlockLine(line, contentWidth));
    index += 1;
  }

  return indent ? output.map(entry => `${indent}${entry}`) : output;
}

function renderBlockLine(line: string, width: number): string[] {
  if (!line.trim()) {
    return [''];
  }

  /* Claude-style tool lines produced by formatDiffForChat. */
  const toolLine = /^●\s+(.*)$/.exec(line);
  if (toolLine) {
    return [`${paint('●', { fg: palette.violet })} ${paint(toolLine[1], { fg: palette.text, bold: true })}`];
  }
  const branchLine = /^(\s*)⎿\s+(.*)$/.exec(line);
  if (branchLine) {
    return [`${branchLine[1]}${paint(glyphs.branch, { fg: palette.border })} ${paint(branchLine[2], { fg: palette.muted })}`];
  }

  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    const level = heading[1].length;
    const color = level <= 2 ? palette.violet : level === 3 ? palette.blue : palette.teal;
    return wrapText(paint(renderInline(heading[2]), { fg: color, bold: level <= 3 }), width);
  }

  if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
    return [paint(glyphs.boxHorizontal.repeat(Math.max(4, Math.min(width, 48))), { fg: palette.border })];
  }

  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote) {
    const marker = paint('▎', { fg: palette.violet });
    return wrapText(renderInline(quote[1]), width - 2, '  ').map(entry => `${marker} ${entry}`);
  }

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) {
    const depth = Math.floor(bullet[1].length / 2);
    const pad = '  '.repeat(depth);
    const marker = paint(depth === 0 ? '•' : '◦', { fg: palette.violet });
    const wrapped = wrapText(renderInline(bullet[2]), Math.max(8, width - stringWidth(pad) - 2), '  ');
    return wrapped.map((entry, position) => (position === 0 ? `${pad}${marker} ${entry}` : `${pad}  ${entry}`));
  }

  const ordered = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line);
  if (ordered) {
    const pad = '  '.repeat(Math.floor(ordered[1].length / 2));
    const marker = paint(`${ordered[2]}.`, { fg: palette.blue });
    const wrapped = wrapText(renderInline(ordered[4]), Math.max(8, width - stringWidth(pad) - ordered[2].length - 2), '   ');
    return wrapped.map((entry, position) =>
      position === 0 ? `${pad}${marker} ${entry}` : `${pad}${' '.repeat(ordered[2].length + 1)} ${entry}`
    );
  }

  if (isTableRow(line)) {
    return [renderTableRow(line, width)];
  }

  return wrapText(renderInline(line), width);
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2;
}

function renderTableRow(line: string, width: number): string {
  const cells = line.trim().slice(1, -1).split('|');
  const columnWidth = Math.max(6, Math.floor((width - cells.length * 3) / Math.max(1, cells.length)));

  if (cells.every(cell => /^\s*:?-{2,}:?\s*$/.test(cell))) {
    return paint(
      cells.map(() => glyphs.boxHorizontal.repeat(columnWidth)).join(`${glyphs.boxHorizontal}┼${glyphs.boxHorizontal}`),
      { fg: palette.border }
    );
  }

  return truncate(
    cells
      .map(cell => padEnd(truncate(renderInline(cell.trim()), columnWidth), columnWidth))
      .join(paint(' │ ', { fg: palette.border })),
    width
  );
}

function renderCodeBlock(body: string[], language: string, width: number): string[] {
  if (language === 'diff') {
    return renderUnifiedText(body.join('\n'), width);
  }

  const label = language && language !== 'plaintext' ? ` ${language} ` : '';
  const innerWidth = Math.max(8, width - 4);
  const top = paint(
    `${glyphs.boxTopLeft}${glyphs.boxHorizontal}${label}${glyphs.boxHorizontal.repeat(Math.max(0, innerWidth - stringWidth(label)))}`,
    { fg: palette.border }
  );
  const bottom = paint(`${glyphs.boxBottomLeft}${glyphs.boxHorizontal.repeat(innerWidth + 1)}`, { fg: palette.border });
  const bar = paint(glyphs.boxVertical, { fg: palette.border });

  const rows: string[] = [];
  for (const row of body) {
    const expanded = row.replace(/\t/g, '  ');
    if (!expanded.length) {
      rows.push(bar);
      continue;
    }
    for (let start = 0; start < expanded.length; start += innerWidth) {
      rows.push(`${bar} ${highlightCode(expanded.slice(start, start + innerWidth))}`);
    }
  }

  return [top, ...rows, bottom];
}

/** Deliberately shallow tinting: enough structure to read, no parser.
 *  One pass only — a second regex sweep would re-match the digits inside the
 *  colour codes the first sweep just inserted. */
const CODE_TOKEN = /(['"`])(?:\\.|(?!\1)[^\\])*\1|\b\d+(?:\.\d+)?\b|[A-Za-z_][A-Za-z0-9_]*/g;

function highlightCode(code: string): string {
  if (!code.trim()) {
    return code;
  }

  const trimmed = code.trimStart();
  if (COMMENT_PREFIXES.some(prefix => trimmed.startsWith(prefix)) || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
    return paint(code, { fg: syntax.comment });
  }

  return code.replace(CODE_TOKEN, token => {
    const first = token.charAt(0);
    if (first === '"' || first === "'" || first === '`') {
      return paint(token, { fg: syntax.string });
    }
    if (/^\d/.test(token)) {
      return paint(token, { fg: syntax.number });
    }
    return KEYWORDS.includes(token) ? paint(token, { fg: syntax.keyword }) : token;
  });
}

/** Inline markdown: code spans, bold, italic, strikethrough, links. */
export function renderInline(text: string): string {
  const stashed: string[] = [];
  const stash = (rendered: string): string => {
    stashed.push(rendered);
    return `${MARK}${stashed.length - 1}${MARK}`;
  };

  let output = text.replace(/`([^`]+)`/g, (_match, code: string) => stash(paint(code, { fg: palette.teal })));

  output = output.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) =>
    stash(`${paint(label, { fg: palette.blue, underline: true })} ${paint(url, { fg: palette.faint })}`)
  );

  output = output.replace(/\*\*([^*]+)\*\*/g, (_match, inner: string) =>
    stash(paint(inner, { bold: true, fg: palette.text }))
  );

  output = output.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, (_match, lead: string, inner: string) =>
    `${lead}${stash(paint(inner, { italic: true }))}`
  );

  output = output.replace(/(^|[^_\w])_([^_\n]+)_(?![\w_])/g, (_match, lead: string, inner: string) =>
    `${lead}${stash(paint(inner, { italic: true }))}`
  );

  output = output.replace(/~~([^~]+)~~/g, (_match, inner: string) =>
    stash(paint(inner, { strike: true, fg: palette.faint }))
  );

  return output.replace(MARK_PATTERN, (_match, index: string) => stashed[Number(index)] ?? '');
}
