// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Live activity reporting for the IDE host.
 *  Single Responsibility: record every step Olliberty takes and
 *  broadcast it so the chat webview and the output channel can
 *  show the user exactly what is happening in the background.
 *  The step shape and formatting helpers are shared with the CLI
 *  through core/activityContract.                                */

import * as vscode from 'vscode';
import {
  ActivitySink,
  ActivityStatus,
  ActivityStep,
  ActivityTaskHandle,
  MAX_RETAINED_STEPS,
  compactDetail,
  formatDuration
} from './core/activityContract';

export { formatDuration };
export type { ActivitySink, ActivityStatus, ActivityStep };

export class ActivityReporter implements ActivitySink {
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
      detail: compactDetail(detail),
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
    step.detail = compactDetail(detail);
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
      detail: compactDetail(detail),
      status: 'info',
      startedAt: Date.now(),
      endedAt: Date.now()
    });
    this.write('•', label, detail);
  }

  /** Wrap an async unit of work so it always reports a terminal state. */
  async run<T>(label: string, task: (step: ActivityTaskHandle) => Promise<T>, detail = ''): Promise<T> {
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
      step.detail = compactDetail(detail);
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
    const suffix = detail ? ` — ${compactDetail(detail)}` : '';
    this.output.appendLine(`[${timestamp}] ${marker} ${label}${suffix}`);
  }
}
