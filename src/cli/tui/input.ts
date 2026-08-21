/*  The composer: a Claude-Code-style input box with a completion popup, plus
 *  the line-editing keys people expect from a shell (word motion, kill ring
 *  basics, history, bracketed paste, multi-line entry).                   */

import { Key } from './keys';
import { CompletionResult } from './completion';
import { padEnd, paint, stringWidth, truncate } from './ansi';
import { glyphs, palette } from './theme';

export type EditorAction =
  | { type: 'none' }
  | { type: 'submit'; value: string }
  | { type: 'interrupt' }
  | { type: 'exit' }
  | { type: 'toggle-mode' }
  | { type: 'redraw' }
  | { type: 'history-note'; message: string };

export type CompletionProvider = (text: string, cursor: number) => Promise<CompletionResult | null>;

const MAX_VISIBLE_COMPLETIONS = 8;
const DOUBLE_PRESS_WINDOW_MS = 1500;

export interface ComposerRender {
  lines: string[];
  cursorRow: number;
  cursorColumn: number;
}

export class Composer {
  private text = '';
  private cursor = 0;
  private history: string[];
  private historyIndex: number;
  private draftBeforeHistory = '';
  private completion: CompletionResult | null = null;
  private selectedCompletion = 0;
  private lastCtrlC = 0;
  private hint = '';

  constructor(
    history: string[],
    private readonly completionProvider: CompletionProvider,
    private readonly placeholder = 'Ask anything, or /help for commands'
  ) {
    this.history = [...history];
    this.historyIndex = this.history.length;
  }

  value(): string {
    return this.text;
  }

  isEmpty(): boolean {
    return this.text.trim().length === 0;
  }

  completionOpen(): boolean {
    return this.completion !== null;
  }

  setHint(hint: string): void {
    this.hint = hint;
  }

  reset(): void {
    this.text = '';
    this.cursor = 0;
    this.completion = null;
    this.selectedCompletion = 0;
    this.historyIndex = this.history.length;
  }

  remember(entry: string): void {
    const trimmed = entry.trim();
    if (!trimmed) {
      return;
    }
    if (this.history[this.history.length - 1] !== trimmed) {
      this.history.push(trimmed);
    }
    this.historyIndex = this.history.length;
  }

  historyEntries(): string[] {
    return [...this.history];
  }

  async handleKey(key: Key): Promise<EditorAction> {
    this.hint = '';

    if (key.paste && key.text) {
      this.insert(key.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
      await this.refreshCompletion();
      return { type: 'none' };
    }

    /* Completion navigation first: while the popup is open it owns the
       arrows, Tab and Enter. */
    if (this.completion) {
      if (key.name === 'up' && !key.ctrl) {
        this.selectedCompletion = (this.selectedCompletion - 1 + this.completion.items.length) % this.completion.items.length;
        return { type: 'none' };
      }
      if (key.name === 'down' && !key.ctrl) {
        this.selectedCompletion = (this.selectedCompletion + 1) % this.completion.items.length;
        return { type: 'none' };
      }
      if (key.name === 'escape') {
        this.completion = null;
        return { type: 'none' };
      }
      /* Tab accepts, Enter always submits: an open popup must never swallow
         a deliberate send. */
      if (key.name === 'tab' && !key.shift) {
        this.acceptCompletion();
        await this.refreshCompletion();
        return { type: 'none' };
      }
      if (key.name === 'return' && !key.meta) {
        this.completion = null;
      }
    }

    if (key.name === 'tab' && key.shift) {
      return { type: 'toggle-mode' };
    }

    if (key.name === 'escape') {
      return { type: 'interrupt' };
    }

    if (key.ctrl) {
      switch (key.name) {
        case 'c': {
          const now = Date.now();
          if (this.text.length) {
            this.reset();
            return { type: 'none' };
          }
          if (now - this.lastCtrlC < DOUBLE_PRESS_WINDOW_MS) {
            return { type: 'exit' };
          }
          this.lastCtrlC = now;
          return { type: 'history-note', message: 'Press Ctrl+C again to exit.' };
        }
        case 'd':
          if (!this.text.length) {
            return { type: 'exit' };
          }
          this.deleteForward();
          await this.refreshCompletion();
          return { type: 'none' };
        case 'l':
          return { type: 'redraw' };
        case 'a':
          this.cursor = this.lineStart();
          return { type: 'none' };
        case 'e':
          this.cursor = this.lineEnd();
          return { type: 'none' };
        case 'k':
          this.text = this.text.slice(0, this.cursor) + this.text.slice(this.lineEnd());
          await this.refreshCompletion();
          return { type: 'none' };
        case 'u':
          this.text = this.text.slice(0, this.lineStart()) + this.text.slice(this.cursor);
          this.cursor = this.lineStart();
          await this.refreshCompletion();
          return { type: 'none' };
        case 'w':
          this.deleteWordBackward();
          await this.refreshCompletion();
          return { type: 'none' };
        case 'left':
          this.cursor = this.previousWord();
          return { type: 'none' };
        case 'right':
          this.cursor = this.nextWord();
          return { type: 'none' };
        default:
          return { type: 'none' };
      }
    }

    switch (key.name) {
      case 'return': {
        /* Alt+Enter, or a trailing backslash, means "keep typing". */
        if (key.meta) {
          this.insert('\n');
          return { type: 'none' };
        }
        if (this.text.endsWith('\\')) {
          this.text = `${this.text.slice(0, -1)}\n`;
          this.cursor = this.text.length;
          return { type: 'none' };
        }
        const value = this.text;
        if (!value.trim()) {
          return { type: 'none' };
        }
        this.remember(value);
        this.reset();
        return { type: 'submit', value };
      }
      case 'backspace':
        if (key.meta) {
          this.deleteWordBackward();
        } else if (this.cursor > 0) {
          const previous = this.previousIndex();
          this.text = this.text.slice(0, previous) + this.text.slice(this.cursor);
          this.cursor = previous;
        }
        await this.refreshCompletion();
        return { type: 'none' };
      case 'delete':
        this.deleteForward();
        await this.refreshCompletion();
        return { type: 'none' };
      case 'left':
        this.cursor = Math.max(0, this.previousIndex());
        return { type: 'none' };
      case 'right':
        this.cursor = Math.min(this.text.length, this.nextIndex());
        return { type: 'none' };
      case 'home':
        this.cursor = this.lineStart();
        return { type: 'none' };
      case 'end':
        this.cursor = this.lineEnd();
        return { type: 'none' };
      case 'up':
        if (this.currentRow() > 0) {
          this.moveVertically(-1);
          return { type: 'none' };
        }
        this.recallHistory(-1);
        return { type: 'none' };
      case 'down':
        if (this.currentRow() < this.logicalRows().length - 1) {
          this.moveVertically(1);
          return { type: 'none' };
        }
        this.recallHistory(1);
        return { type: 'none' };
      case 'tab':
        await this.refreshCompletion(true);
        return { type: 'none' };
      default:
        if (key.text) {
          this.insert(key.text);
          await this.refreshCompletion();
        }
        return { type: 'none' };
    }
  }

  /* ─────────────────────────────── editing ─────────────────────────── */

  private insert(value: string): void {
    this.text = this.text.slice(0, this.cursor) + value + this.text.slice(this.cursor);
    this.cursor += value.length;
  }

  private deleteForward(): void {
    if (this.cursor < this.text.length) {
      this.text = this.text.slice(0, this.cursor) + this.text.slice(this.nextIndex());
    }
  }

  private deleteWordBackward(): void {
    const start = this.previousWord();
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  private previousIndex(): number {
    if (this.cursor <= 0) {
      return 0;
    }
    /* Step over a surrogate pair as one character. */
    const before = this.text.slice(0, this.cursor);
    const characters = Array.from(before);
    const last = characters[characters.length - 1] ?? '';
    return this.cursor - last.length;
  }

  private nextIndex(): number {
    if (this.cursor >= this.text.length) {
      return this.text.length;
    }
    const codePoint = this.text.codePointAt(this.cursor) ?? 0;
    return this.cursor + String.fromCodePoint(codePoint).length;
  }

  private lineStart(): number {
    const index = this.text.lastIndexOf('\n', Math.max(0, this.cursor - 1));
    return index === -1 ? 0 : index + 1;
  }

  private lineEnd(): number {
    const index = this.text.indexOf('\n', this.cursor);
    return index === -1 ? this.text.length : index;
  }

  private previousWord(): number {
    let index = this.cursor;
    while (index > 0 && /\s/.test(this.text[index - 1])) {
      index -= 1;
    }
    while (index > 0 && !/\s/.test(this.text[index - 1])) {
      index -= 1;
    }
    return index;
  }

  private nextWord(): number {
    let index = this.cursor;
    while (index < this.text.length && /\s/.test(this.text[index])) {
      index += 1;
    }
    while (index < this.text.length && !/\s/.test(this.text[index])) {
      index += 1;
    }
    return index;
  }

  private logicalRows(): string[] {
    return this.text.split('\n');
  }

  private currentRow(): number {
    return this.text.slice(0, this.cursor).split('\n').length - 1;
  }

  private moveVertically(delta: number): void {
    const rows = this.logicalRows();
    const row = this.currentRow();
    const column = this.cursor - this.lineStart();
    const targetRow = Math.min(rows.length - 1, Math.max(0, row + delta));

    let offset = 0;
    for (let index = 0; index < targetRow; index += 1) {
      offset += rows[index].length + 1;
    }
    this.cursor = offset + Math.min(column, rows[targetRow].length);
  }

  private recallHistory(delta: number): void {
    if (!this.history.length) {
      return;
    }

    if (this.historyIndex === this.history.length && delta < 0) {
      this.draftBeforeHistory = this.text;
    }

    const nextIndex = this.historyIndex + delta;
    if (nextIndex < 0) {
      return;
    }
    if (nextIndex >= this.history.length) {
      this.historyIndex = this.history.length;
      this.text = this.draftBeforeHistory;
      this.cursor = this.text.length;
      return;
    }

    this.historyIndex = nextIndex;
    this.text = this.history[nextIndex];
    this.cursor = this.text.length;
    this.completion = null;
  }

  private acceptCompletion(): void {
    if (!this.completion) {
      return;
    }
    const item = this.completion.items[this.selectedCompletion];
    if (!item) {
      return;
    }

    const before = this.text.slice(0, this.completion.replaceStart);
    const after = this.text.slice(this.completion.replaceEnd);
    /* Directory suggestions end in '/', so do not append a space after them. */
    const suffix = item.value.endsWith('/') ? '' : this.completion.suffix;
    this.text = `${before}${item.value}${suffix}${after}`;
    this.cursor = before.length + item.value.length + suffix.length;
    this.completion = null;
    this.selectedCompletion = 0;
  }

  private async refreshCompletion(force = false): Promise<void> {
    try {
      const result = await this.completionProvider(this.text, this.cursor);
      if (!result || !result.items.length) {
        this.completion = null;
        this.selectedCompletion = 0;
        return;
      }
      if (!force && result.items.length === 1 && this.text.endsWith(' ')) {
        this.completion = null;
        return;
      }
      this.completion = result;
      this.selectedCompletion = Math.min(this.selectedCompletion, result.items.length - 1);
    } catch {
      /* Completion is a convenience; never let it break typing. */
      this.completion = null;
    }
  }

  /* ────────────────────────────── rendering ────────────────────────── */

  render(width: number, options: { busy: boolean }): ComposerRender {
    const innerWidth = Math.max(8, width - 6);
    const lines: string[] = [];

    if (this.completion) {
      lines.push(...this.renderCompletion(width));
    }

    const border = (left: string, right: string) =>
      paint(`${left}${glyphs.boxHorizontal.repeat(Math.max(2, width - 2))}${right}`, {
        fg: this.completion ? palette.violet : palette.border
      });

    lines.push(border(glyphs.boxTopLeft, glyphs.boxTopRight));

    const rows = this.wrapForDisplay(innerWidth);
    const bar = paint(glyphs.boxVertical, { fg: palette.border });
    const promptGlyph = paint(this.busyPrompt(options.busy), { fg: options.busy ? palette.amber : palette.violet });

    const contentStartRow = lines.length;
    rows.segments.forEach((segment, index) => {
      const prefix = index === 0 ? `${promptGlyph} ` : '  ';
      const body = index === 0 && !this.text.length
        ? paint(truncate(this.placeholder, innerWidth), { fg: palette.faint })
        : paint(segment.text, { fg: palette.text });
      lines.push(`${bar} ${prefix}${padEnd(body, innerWidth)} ${bar}`);
    });

    lines.push(border(glyphs.boxBottomLeft, glyphs.boxBottomRight));

    const cursorRow = contentStartRow + rows.cursorSegment;
    const cursorColumn = 2 + 2 + rows.cursorColumn;

    return { lines, cursorRow, cursorColumn };
  }

  hintLine(): string {
    return this.hint ? paint(`  ${this.hint}`, { fg: palette.amber }) : '';
  }

  private busyPrompt(busy: boolean): string {
    return busy ? glyphs.arrow : '›';
  }

  /** Hard-wrap so the cursor's screen position is exactly computable. */
  private wrapForDisplay(innerWidth: number): {
    segments: Array<{ text: string }>;
    cursorSegment: number;
    cursorColumn: number;
  } {
    const segments: Array<{ text: string }> = [];
    let cursorSegment = 0;
    let cursorColumn = 0;
    let consumed = 0;

    const logicalLines = this.text.split('\n');

    logicalLines.forEach((line, lineIndex) => {
      const characters = Array.from(line);
      let start = 0;

      do {
        const chunk: string[] = [];
        let chunkWidth = 0;
        while (start < characters.length) {
          const nextWidth = stringWidth(characters[start]);
          if (chunkWidth + nextWidth > innerWidth) {
            break;
          }
          chunk.push(characters[start]);
          chunkWidth += nextWidth;
          start += 1;
        }

        const segmentText = chunk.join('');
        const segmentIndex = segments.length;
        segments.push({ text: segmentText });

        const segmentStartOffset = consumed;
        const segmentEndOffset = consumed + segmentText.length;
        if (this.cursor >= segmentStartOffset && this.cursor <= segmentEndOffset) {
          cursorSegment = segmentIndex;
          cursorColumn = stringWidth(this.text.slice(segmentStartOffset, this.cursor));
        }
        consumed = segmentEndOffset;
      } while (start < characters.length);

      if (lineIndex < logicalLines.length - 1) {
        /* Account for the newline separator itself. */
        consumed += 1;
      }
    });

    if (!segments.length) {
      segments.push({ text: '' });
    }

    return { segments, cursorSegment, cursorColumn };
  }

  private renderCompletion(width: number): string[] {
    if (!this.completion) {
      return [];
    }

    const items = this.completion.items;
    const windowStart = Math.max(
      0,
      Math.min(items.length - MAX_VISIBLE_COMPLETIONS, this.selectedCompletion - Math.floor(MAX_VISIBLE_COMPLETIONS / 2))
    );
    const visible = items.slice(windowStart, windowStart + MAX_VISIBLE_COMPLETIONS);
    const labelWidth = Math.min(28, Math.max(...visible.map(item => stringWidth(item.label))));

    const rows = visible.map((item, index) => {
      const isSelected = windowStart + index === this.selectedCompletion;
      const label = padEnd(truncate(item.label, labelWidth), labelWidth);
      const description = item.description ? truncate(item.description, Math.max(0, width - labelWidth - 8)) : '';
      const body = `${label}${description ? `  ${description}` : ''}`;

      return isSelected
        ? paint(`  ${glyphs.arrow} ${padEnd(body, Math.max(0, width - 6))}`, { fg: palette.text, bg: palette.panel, bold: true })
        : paint(`    ${body}`, { fg: palette.muted });
    });

    if (items.length > visible.length) {
      rows.push(paint(`    … ${items.length - visible.length} more`, { fg: palette.faint }));
    }

    return rows;
  }
}
