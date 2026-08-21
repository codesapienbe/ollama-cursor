// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Status bar under the composer: workspace, branch, mode, model, and the
 *  pending-approval reminders. Gemini-CLI-style single line, with a second
 *  line only when something is waiting for the user.                     */

import { paint, stringWidth, truncate } from './ansi';
import { palette } from './theme';

export interface FooterInfo {
  width: number;
  workspace: string;
  branch: string;
  scope: string;
  mode: string;
  model: string;
  effort: string;
  attachments: number;
  changes: number;
  connected: boolean;
  busy: boolean;
  pendingPlan: boolean;
  pendingEditFiles: string[];
}

export function renderFooter(info: FooterInfo): string[] {
  const separator = paint(' · ', { fg: palette.border });
  const modeBadge = info.mode === 'plan'
    ? paint(' plan ', { fg: palette.panel, bg: palette.violet, bold: true })
    : paint(' auto ', { fg: palette.panel, bg: palette.amber, bold: true });

  const connection = info.connected
    ? paint('● ollama', { fg: palette.green })
    : paint('○ offline', { fg: palette.red });

  const left = [
    paint(info.workspace, { fg: palette.muted }),
    info.branch ? paint(`⎇ ${info.branch}`, { fg: palette.teal }) : '',
    info.scope ? paint(`scope ${info.scope}`, { fg: palette.faint }) : '',
    paint(info.model, { fg: palette.blue }),
    paint(info.effort, { fg: palette.faint }),
    info.attachments ? paint(`📎 ${info.attachments}`, { fg: palette.teal }) : '',
    info.changes ? paint(`✎ ${info.changes}`, { fg: palette.addFg }) : ''
  ].filter(Boolean).join(separator);

  const right = `${modeBadge} ${connection}`;
  const gap = info.width - stringWidth(left) - stringWidth(right) - 2;
  const line = gap > 1
    ? `  ${left}${' '.repeat(gap)}${right}`
    : truncate(`  ${left} ${right}`, info.width);

  const lines = [line];
  const pending = renderPendingLine(info);
  if (pending) {
    lines.push(pending);
  }

  return lines;
}

function renderPendingLine(info: FooterInfo): string {
  if (info.pendingEditFiles.length) {
    const files = info.pendingEditFiles.length === 1
      ? info.pendingEditFiles[0]
      : `${info.pendingEditFiles.length} files`;
    return paint(
      `  ⚠ ${files} not written yet — /approve to write, /reject to discard`,
      { fg: palette.amber }
    );
  }

  if (info.pendingPlan) {
    return paint('  ⚠ plan waiting for review — /accept to run it, /discard to drop it', { fg: palette.amber });
  }

  if (info.busy) {
    return paint('  esc to interrupt', { fg: palette.faint });
  }

  return '';
}

/** Compact key hints shown right after start-up. */
export function renderShortcutHint(width: number): string {
  return truncate(
    paint(
      '  enter send · alt+enter newline · shift+tab plan/auto · @file to attach · /help',
      { fg: palette.faint }
    ),
    width
  );
}
