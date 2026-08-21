// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Terminal renderer.
 *  Scrollback stays native: finished output is appended to stdout and never
 *  redrawn, while a small "frame" at the bottom (status + composer) is
 *  repainted in place. That is what keeps a long session scrollable in the
 *  terminal's own buffer instead of an alternate screen.                 */

import { cursor, stringWidth, truncate } from './ansi';

export interface FramePlacement {
  /** Row inside the frame the cursor should rest on (0-based). */
  row: number;
  /** Column on that row (0-based, in display cells). */
  column: number;
}

export class Screen {
  private frame: string[] = [];
  private frameCursor: FramePlacement = { row: 0, column: 0 };
  private paintedRows = 0;
  private paintedCursorRow = 0;
  private resizeListener?: () => void;
  private closed = false;

  constructor(private readonly output: NodeJS.WriteStream = process.stdout) {}

  get columns(): number {
    /* Some pseudo-terminals (CI, `script`) report a size of 0; COLUMNS is
       the conventional fallback before we give up and assume 80. */
    return Math.max(20, this.output.columns || numericEnv('COLUMNS') || 80);
  }

  get rows(): number {
    return Math.max(6, this.output.rows || numericEnv('LINES') || 24);
  }

  onResize(listener: () => void): void {
    this.resizeListener = listener;
    this.output.on('resize', listener);
  }

  /** Append permanent output above the frame. */
  printBlock(lines: string[]): void {
    if (this.closed) {
      return;
    }

    const payload = lines.map(line => truncate(line, this.columns));
    this.erase();
    if (payload.length) {
      this.output.write(`${payload.join('\r\n')}\r\n`);
    }
    this.paint();
  }

  /** Replace the live bottom frame. */
  setFrame(lines: string[], placement: FramePlacement = { row: 0, column: 0 }): void {
    this.frame = lines;
    this.frameCursor = placement;
    this.repaint();
  }

  repaint(): void {
    if (this.closed) {
      return;
    }
    this.erase();
    this.paint();
  }

  /** Full redraw after Ctrl+L. */
  clear(): void {
    if (this.closed) {
      return;
    }
    this.output.write(cursor.clearScreen);
    this.paintedRows = 0;
    this.paintedCursorRow = 0;
    this.paint();
  }

  dispose(): void {
    if (this.closed) {
      return;
    }
    this.erase();
    this.output.write(cursor.show);
    if (this.resizeListener) {
      this.output.off('resize', this.resizeListener);
    }
    this.closed = true;
  }

  /** Remove the painted frame, leaving the cursor where it began. */
  private erase(): void {
    if (!this.paintedRows) {
      return;
    }
    this.output.write(cursor.up(this.paintedCursorRow) + cursor.toColumn(1) + cursor.eraseDown);
    this.paintedRows = 0;
    this.paintedCursorRow = 0;
  }

  private paint(): void {
    const width = this.columns;
    /* Never let the frame exceed the viewport, or the cursor maths that
       assumes "frame height == rows written" stops holding. */
    const maxRows = Math.max(1, this.rows - 1);
    const visible = this.frame.slice(-maxRows).map(line => truncate(line, width));

    if (!visible.length) {
      this.paintedRows = 0;
      this.paintedCursorRow = 0;
      return;
    }

    const trimmedFromTop = Math.max(0, this.frame.length - visible.length);
    const targetRow = Math.min(
      Math.max(0, this.frameCursor.row - trimmedFromTop),
      visible.length - 1
    );

    this.output.write(cursor.hide);
    this.output.write(visible.join('\r\n'));

    /* Land the cursor on the composer position. */
    const rowsUp = visible.length - 1 - targetRow;
    this.output.write(cursor.up(rowsUp));
    const targetColumn = Math.min(this.frameCursor.column, Math.max(0, width - 1));
    this.output.write(cursor.toColumn(targetColumn + 1));
    this.output.write(cursor.show);

    this.paintedRows = visible.length;
    this.paintedCursorRow = targetRow;
  }
}

function numericEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Display width helper re-exported so views do not import ansi twice. */
export function widthOf(text: string): number {
  return stringWidth(text);
}
