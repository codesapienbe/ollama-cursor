/*  Live status blocks: the activity feed and the delegated sub-agent tree.
 *  These are the moving parts of the frame, repainted on every tick while a
 *  run is in flight — the CLI's version of the plugin's activity panel and
 *  agent-run list.                                                        */

import { ActivityStep, formatDuration } from '../../main/core/activityContract';
import { AgentRunView } from '../session';
import { padEnd, paint, stringWidth, truncate } from './ansi';
import { glyphs, palette } from './theme';

export function spinnerFrame(tick: number): string {
  return glyphs.spinnerFrames[tick % glyphs.spinnerFrames.length];
}

export interface StatusOptions {
  width: number;
  tick: number;
  maxRows?: number;
}

/** Steps for the current run, newest last, running ones spinning. */
export function renderActivity(steps: ActivityStep[], options: StatusOptions): string[] {
  if (!steps.length) {
    return [];
  }

  const maxRows = options.maxRows ?? 6;
  const running = steps.filter(step => step.status === 'running');
  const finished = steps.filter(step => step.status !== 'running');
  /* Always keep every running step visible; trim the finished tail. */
  const visible = [...finished.slice(-Math.max(1, maxRows - running.length)), ...running];

  return visible.map(step => {
    const marker = step.status === 'running'
      ? paint(spinnerFrame(options.tick), { fg: palette.violet })
      : step.status === 'done'
        ? paint(glyphs.check, { fg: palette.green })
        : step.status === 'failed'
          ? paint(glyphs.cross, { fg: palette.red })
          : step.status === 'cancelled'
            ? paint(glyphs.stop, { fg: palette.amber })
            : paint(glyphs.info, { fg: palette.faint });

    const label = paint(step.label, { fg: step.status === 'running' ? palette.text : palette.muted });
    const detail = step.detail ? paint(` — ${step.detail}`, { fg: palette.faint }) : '';
    const duration = paint(formatDuration(step), { fg: palette.faint });
    const left = `  ${marker} ${label}${detail}`;
    const gap = options.width - stringWidth(left) - stringWidth(duration) - 1;

    return gap > 1
      ? `${left}${' '.repeat(gap)}${duration}`
      : truncate(`${left} ${duration}`, options.width);
  });
}

/** Sub-agent fan-out, drawn as a tree so parallel work reads as parallel. */
export function renderAgents(agents: AgentRunView[], options: StatusOptions): string[] {
  if (!agents.length) {
    return [];
  }

  const header = `  ${paint('🤝', {})} ${paint('Delegated agents', { fg: palette.text, bold: true })} ${paint(`(${agents.filter(agent => agent.status === 'completed').length}/${agents.length} done)`, { fg: palette.faint })}`;
  const nameWidth = Math.min(24, Math.max(...agents.map(agent => stringWidth(agent.name))));

  const rows = agents.map((agent, index) => {
    const isLast = index === agents.length - 1;
    const connector = paint(isLast ? glyphs.treeLast : glyphs.treeBranch, { fg: palette.border });
    const marker = agent.status === 'running'
      ? paint(spinnerFrame(options.tick), { fg: palette.violet })
      : agent.status === 'completed'
        ? paint(glyphs.check, { fg: palette.green })
        : agent.status === 'failed'
          ? paint(glyphs.cross, { fg: palette.red })
          : paint('·', { fg: palette.faint });

    const name = paint(padEnd(agent.name, nameWidth), {
      fg: agent.status === 'running' ? palette.text : palette.muted
    });
    const detail = agent.detail || (agent.status === 'queued' ? 'queued' : agent.status === 'running' ? agent.goal : '');
    const suffix = detail ? paint(` ${detail}`, { fg: palette.faint }) : '';

    return truncate(`  ${connector} ${marker} ${name}${suffix}`, options.width);
  });

  return [header, ...rows];
}

/** One-line "working" indicator shown while a turn is in flight. */
export function renderWorkingLine(label: string, elapsedMs: number, options: StatusOptions): string {
  const seconds = (elapsedMs / 1000).toFixed(1);
  return truncate(
    [
      ` ${paint(spinnerFrame(options.tick), { fg: palette.violet })}`,
      paint(label, { fg: palette.text }),
      paint(`(${seconds}s · esc to interrupt)`, { fg: palette.faint })
    ].join(' '),
    options.width
  );
}

/** Streaming assistant text, tailed to the last few lines while it grows. */
export function renderStreamTail(text: string, options: StatusOptions & { maxRows: number }): string[] {
  if (!text) {
    return [];
  }

  const rows = text.split('\n');
  const tail = rows.slice(-options.maxRows);
  return tail.map(row => `  ${paint(truncate(row, options.width - 2), { fg: palette.muted })}`);
}
