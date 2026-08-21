/*  Host-agnostic activity reporting contract.
 *  Both hosts record the same step stream: the extension mirrors it into a
 *  webview plus an output channel, the CLI paints it in the terminal.      */

export type ActivityStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'info';

export interface ActivityStep {
  id: string;
  label: string;
  detail: string;
  status: ActivityStatus;
  startedAt: number;
  endedAt?: number;
}

export interface ActivityTaskHandle {
  update: (detail: string) => void;
}

/** What the shared services (plan, edit, multi-agent) need to report. */
export interface ActivitySink {
  begin(label: string, detail?: string): string;
  update(id: string, detail: string): void;
  succeed(id: string, detail?: string): void;
  fail(id: string, detail?: string): void;
  cancel(id: string, detail?: string): void;
  cancelRunning(detail?: string): void;
  info(label: string, detail?: string): void;
  run<T>(label: string, task: (step: ActivityTaskHandle) => Promise<T>, detail?: string): Promise<T>;
  reset(): void;
  snapshot(): ActivityStep[];
  hasRunningSteps(): boolean;
}

export const MAX_RETAINED_STEPS = 60;
export const MAX_DETAIL_CHARS = 220;

export function formatDuration(step: ActivityStep): string {
  const elapsed = (step.endedAt ?? Date.now()) - step.startedAt;
  if (elapsed < 1000) {
    return `${elapsed}ms`;
  }
  return `${(elapsed / 1000).toFixed(1)}s`;
}

export function compactDetail(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= MAX_DETAIL_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

export function statusMarker(status: ActivityStatus): string {
  switch (status) {
    case 'done': return '✔';
    case 'failed': return '✖';
    case 'cancelled': return '⏹';
    case 'running': return '▶';
    default: return '•';
  }
}
