/*  Live activity reporting.
 *  Single Responsibility: record every step Olliberty takes and
 *  broadcast it so the chat webview and the output channel can
 *  show the user exactly what is happening in the background.    */

import * as vscode from 'vscode';

export type ActivityStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'info';

export interface ActivityStep {
  id: string;
  label: string;
  detail: string;
  status: ActivityStatus;
  startedAt: number;
  endedAt?: number;
}

const MAX_RETAINED_STEPS = 60;
const MAX_DETAIL_CHARS = 220;

export class ActivityReporter {
  private steps: ActivityStep[] = [];
  private counter = 0;
  private readonly emitter = new vscode.EventEmitter<ActivityStep[]>();
  private readonly output = vscode.window.createOutputChannel('Olliberty');

  readonly onDidChange = this.emitter.event;

  /** Start a step that stays "running" until succeed/fail is called. */
  begin(label: string, detail = ''): string {
    this.counter += 1;
    const id = `step-${this.counter}`;
    this.push({
      id,
      label,
      detail: compact(detail),
      status: 'running',
      startedAt: Date.now()
    });
    this.write('▶', label, detail);
    return id;
  }

  /** Replace the detail line of a running step without ending it. */
  update(id: string, detail: string): void {
    const step = this.steps.find(entry => entry.id === id);
    if (!step) {
      return;
    }
    step.detail = compact(detail);
    this.emit();
  }

  succeed(id: string, detail?: string): void {
    this.end(id, 'done', detail);
  }

  fail(id: string, detail?: string): void {
    this.end(id, 'failed', detail);
  }

  cancel(id: string, detail = 'stopped by user'): void {
    this.end(id, 'cancelled', detail);
  }

  /** Close out every still-running step when the user interrupts a run. */
  cancelRunning(detail = 'stopped by user'): void {
    for (const step of this.steps) {
      if (step.status === 'running') {
        this.end(step.id, 'cancelled', detail);
      }
    }
  }

  /** Record a one-shot event that has no duration. */
  info(label: string, detail = ''): void {
    this.counter += 1;
    this.push({
      id: `step-${this.counter}`,
      label,
      detail: compact(detail),
      status: 'info',
      startedAt: Date.now(),
      endedAt: Date.now()
    });
    this.write('•', label, detail);
  }

  /** Wrap an async unit of work so it always reports a terminal state. */
  async run<T>(label: string, task: (step: { update: (detail: string) => void }) => Promise<T>, detail = ''): Promise<T> {
    const id = this.begin(label, detail);
    try {
      const result = await task({ update: (nextDetail: string) => this.update(id, nextDetail) });
      this.succeed(id);
      return result;
    } catch (error) {
      this.fail(id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** Clear the feed at the start of a new turn so it reads as one run. */
  reset(): void {
    this.steps = [];
    this.emit();
  }

  snapshot(): ActivityStep[] {
    return this.steps.map(step => ({ ...step }));
  }

  hasRunningSteps(): boolean {
    return this.steps.some(step => step.status === 'running');
  }

  showOutput(): void {
    this.output.show(true);
  }

  dispose(): void {
    this.emitter.dispose();
    this.output.dispose();
  }

  private end(id: string, status: Exclude<ActivityStatus, 'running' | 'info'>, detail?: string): void {
    const step = this.steps.find(entry => entry.id === id);
    if (!step || step.status !== 'running') {
      return;
    }

    step.status = status;
    step.endedAt = Date.now();
    if (detail !== undefined) {
      step.detail = compact(detail);
    }
    this.emit();

    const marker = status === 'done' ? '✔' : status === 'cancelled' ? '⏹' : '✖';
    this.write(marker, `${step.label} (${formatDuration(step)})`, step.detail);
  }

  private push(step: ActivityStep): void {
    this.steps.push(step);
    if (this.steps.length > MAX_RETAINED_STEPS) {
      this.steps = this.steps.slice(-MAX_RETAINED_STEPS);
    }
    this.emit();
  }

  private emit(): void {
    this.emitter.fire(this.snapshot());
  }

  private write(marker: string, label: string, detail: string): void {
    const timestamp = new Date().toISOString().slice(11, 23);
    const suffix = detail ? ` — ${compact(detail)}` : '';
    this.output.appendLine(`[${timestamp}] ${marker} ${label}${suffix}`);
  }
}

export function formatDuration(step: ActivityStep): string {
  const elapsed = (step.endedAt ?? Date.now()) - step.startedAt;
  if (elapsed < 1000) {
    return `${elapsed}ms`;
  }
  return `${(elapsed / 1000).toFixed(1)}s`;
}

function compact(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= MAX_DETAIL_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}
