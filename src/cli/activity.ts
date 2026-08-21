/*  CLI activity reporting.
 *  Same step stream the IDE shows in its feed and output channel: the
 *  terminal paints it live, and every line is mirrored to a log file so
 *  `/activity` can point at something durable.                          */

import * as fs from 'fs';
import * as path from 'path';
import {
  ActivitySink,
  ActivityStatus,
  ActivityStep,
  ActivityTaskHandle,
  MAX_RETAINED_STEPS,
  compactDetail,
  formatDuration
} from '../main/core/activityContract';

export type ActivityListener = (steps: ActivityStep[]) => void;

export class CliActivityReporter implements ActivitySink {
  private steps: ActivityStep[] = [];
  private counter = 0;
  private readonly listeners = new Set<ActivityListener>();
  private logStream?: fs.WriteStream;

  constructor(private readonly logFilePath: string) {}

  onDidChange(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

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

  cancelRunning(detail = 'stopped by user'): void {
    for (const step of this.steps) {
      if (step.status === 'running') {
        this.end(step.id, 'cancelled', detail);
      }
    }
  }

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

  logPath(): string {
    return this.logFilePath;
  }

  dispose(): void {
    this.listeners.clear();
    this.logStream?.end();
    this.logStream = undefined;
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
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private write(marker: string, label: string, detail: string): void {
    const timestamp = new Date().toISOString().slice(11, 23);
    const suffix = detail ? ` — ${compactDetail(detail)}` : '';
    this.appendLine(`[${timestamp}] ${marker} ${label}${suffix}`);
  }

  private appendLine(line: string): void {
    try {
      if (!this.logStream) {
        fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
        this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
        /* A vanished log directory must never crash a run. */
        this.logStream.on('error', () => { this.logStream = undefined; });
      }
      this.logStream.write(`${line}\n`);
    } catch {
      // Logging is best-effort; the live feed is the primary surface.
    }
  }
}
