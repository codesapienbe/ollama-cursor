// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Central settings accessor for the IDE host.
 *  Single Responsibility: read & validate user configuration.
 *  Open/Closed: modification only by adding new getters.
 *  The shape it satisfies (OllibertySettings) lives in core/settingsContract
 *  so the CLI can supply a file-backed implementation of the same contract. */

import * as vscode from 'vscode';
import {
  AgentMode,
  DEFAULT_CODE_INDEX_EXCLUDE_GLOB,
  DEFAULT_DELEGATION_MODE,
  DEFAULT_EFFORT,
  DEFAULT_MODE,
  DEFAULT_MODEL,
  DEFAULT_URL,
  DelegationMode,
  MAX_DELEGATED_AGENTS,
  OllibertySettings,
  ReasoningEffort,
  assertUrlAllowedFor,
  formatPrivacySummary,
  isAgentMode,
  isDelegationMode,
  isReasoningEffort,
  normalizeAllowedHosts
} from './core/settingsContract';

export {
  DEFAULT_MODEL,
  isAgentMode,
  isDelegationMode,
  isReasoningEffort
};
export type { AgentMode, DelegationMode, OllibertySettings, ReasoningEffort };

export class Settings implements OllibertySettings {
  private cfg = vscode.workspace.getConfiguration('olliberty');

  get url(): string           { return this.cfg.get<string>('url')?.trim() || DEFAULT_URL; }
  get model(): string         { return this.cfg.get('model')         ?? DEFAULT_MODEL; }
  get systemPrompt(): string  { return this.cfg.get('systemPrompt')  ?? '';          }
  get temperature(): number   { return this.cfg.get('temperature')   ?? 0.2;        }
  get maxTokens(): number     { return this.cfg.get('maxTokens')     ?? 2048;       }
  get contextLength(): number { return this.cfg.get('contextLength') ?? 4096;       }
  get effort(): ReasoningEffort {
    const effort = (this.cfg.get<string>('effort') ?? DEFAULT_EFFORT).trim().toLowerCase();
    return isReasoningEffort(effort) ? effort : DEFAULT_EFFORT;
  }
  get mode(): AgentMode {
    const mode = (this.cfg.get<string>('mode') ?? DEFAULT_MODE).trim().toLowerCase();
    return isAgentMode(mode) ? mode : DEFAULT_MODE;
  }
  get planFirst(): boolean { return this.mode === 'plan'; }
  /* Plan mode always gates writes behind an explicit approval, whatever
     autoApplyEdits says — accepting a plan is not accepting the diff. */
  get autoApplyEdits(): boolean {
    if (this.planFirst) {
      return false;
    }
    return this.cfg.get<boolean>('autoApplyEdits') ?? false;
  }
  get showActivityFeed(): boolean { return this.cfg.get<boolean>('showActivityFeed') ?? true; }
  get streamResponses(): boolean { return this.cfg.get<boolean>('streamResponses') ?? true; }
  get autoIndexWorkspace(): boolean { return this.cfg.get<boolean>('codeIndex.autoIndexWorkspace') ?? true; }
  get codeIndexMaxFiles(): number { return this.cfg.get<number>('codeIndex.maxFiles') ?? 500; }
  get codeIndexMaxFileSizeKb(): number { return this.cfg.get<number>('codeIndex.maxFileSizeKb') ?? 256; }
  get codeIndexPreviewLines(): number { return this.cfg.get<number>('codeIndex.previewLines') ?? 35; }
  get codeIndexStaleAfterMinutes(): number { return this.cfg.get<number>('codeIndex.staleAfterMinutes') ?? 10; }
  get codeIndexExcludeGlob(): string {
    return this.cfg.get<string>('codeIndex.excludeGlob') ?? DEFAULT_CODE_INDEX_EXCLUDE_GLOB;
  }
  get networkKillSwitchEnabled(): boolean {
    return this.cfg.get<boolean>('privacy.networkKillSwitchEnabled') ?? true;
  }
  get allowedHosts(): string[] {
    return normalizeAllowedHosts(this.cfg.get<string[]>('privacy.allowedHosts'));
  }
  /* Idle budget only: a stream that has started and then goes silent this
     long is dead. The wait for the *first* token is queueTimeoutMs. */
  get timeoutMs(): number {
    return clampNumber(this.cfg.get<number>('timeoutMs'), 90_000, 5_000, 600_000);
  }
  /* Ollama runs one request per loaded model at a time, so a fanned-out agent
     can legitimately sit in the queue for minutes on a large local model.
     Killing it at 45s is what turned a slow agent into a failed one. */
  get queueTimeoutMs(): number {
    return clampNumber(this.cfg.get<number>('queueTimeoutMs'), 600_000, 10_000, 3_600_000);
  }
  get delegationMode(): DelegationMode {
    const mode = (this.cfg.get<string>('agents.delegation') ?? DEFAULT_DELEGATION_MODE).trim().toLowerCase();
    return isDelegationMode(mode) ? mode : DEFAULT_DELEGATION_MODE;
  }
  get agentsMaxCount(): number {
    return clampNumber(this.cfg.get<number>('agents.maxCount'), MAX_DELEGATED_AGENTS, 1, MAX_DELEGATED_AGENTS);
  }
  get agentsMaxParallel(): number {
    return clampNumber(this.cfg.get<number>('agents.maxParallel'), 2, 1, MAX_DELEGATED_AGENTS);
  }
  get agentMaxTokens(): number {
    return clampNumber(this.cfg.get<number>('agents.maxTokens'), 900, 128, 8192);
  }

  async setModel(model: string): Promise<void> {
    await vscode.workspace.getConfiguration('olliberty').update(
      'model',
      model.trim() || DEFAULT_MODEL,
      vscode.ConfigurationTarget.Global
    );
    this.reload();
  }

  async setEffort(effort: ReasoningEffort): Promise<void> {
    await vscode.workspace.getConfiguration('olliberty').update(
      'effort',
      effort,
      vscode.ConfigurationTarget.Global
    );
    this.reload();
  }

  async setMode(mode: AgentMode): Promise<void> {
    await vscode.workspace.getConfiguration('olliberty').update(
      'mode',
      mode,
      vscode.ConfigurationTarget.Global
    );
    this.reload();
  }

  reload(): void {
    this.cfg = vscode.workspace.getConfiguration('olliberty');
  }

  isHostAllowed(host: string): boolean {
    const normalizedHost = host.trim().toLowerCase();
    return this.allowedHosts.includes(normalizedHost);
  }

  assertUrlAllowed(urlLike: URL | string): void {
    assertUrlAllowedFor(this, urlLike);
  }

  privacySummary(): string {
    return formatPrivacySummary(this);
  }
}

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}
