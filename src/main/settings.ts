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
  DEFAULT_EFFORT,
  DEFAULT_MODE,
  DEFAULT_MODEL,
  DEFAULT_URL,
  OllibertySettings,
  ReasoningEffort,
  assertUrlAllowedFor,
  formatPrivacySummary,
  isAgentMode,
  isReasoningEffort,
  normalizeAllowedHosts
} from './core/settingsContract';

export {
  DEFAULT_MODEL,
  isAgentMode,
  isReasoningEffort
};
export type { AgentMode, OllibertySettings, ReasoningEffort };

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
  get timeoutMs(): number     { return 45_000; }   // hard-coded for simplicity

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
