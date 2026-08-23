// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Host-agnostic settings contract.
 *  The VS Code extension reads these values from workspace configuration
 *  and the CLI reads them from config files, but every consumer below
 *  (client, plan/agent services, slash commands) only sees this shape.  */

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max';
export type AgentMode = 'plan' | 'auto';
/*  When a request is split across sub-agents.
    `auto`   — a router decides per request: trivial asks answer directly,
               substantial ones fan out. This is the default path, so the
               split happens without anyone typing `/agents`.
    `always` — every request that reaches the model fans out.
    `off`    — only an explicit `/agents` command fans out.               */
export type DelegationMode = 'auto' | 'always' | 'off';

export const DEFAULT_URL = 'http://localhost:11434';
export const DEFAULT_MODEL = 'qwen3.8:latest';
export const DEFAULT_EFFORT: ReasoningEffort = 'medium';
export const DEFAULT_MODE: AgentMode = 'plan';
export const DEFAULT_DELEGATION_MODE: DelegationMode = 'auto';
/*  Five is the ceiling the roles library is written for, and past it a local
    model server spends all its time context-switching rather than answering. */
export const MAX_DELEGATED_AGENTS = 5;
export const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];
export const DEFAULT_CODE_INDEX_EXCLUDE_GLOB =
  '**/{.git,node_modules,dist,build,out,target,coverage,.next,.ollama,.olliberty}/**';

const VALID_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'max'];
const VALID_MODES: AgentMode[] = ['plan', 'auto'];
const VALID_DELEGATION_MODES: DelegationMode[] = ['auto', 'always', 'off'];

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return VALID_EFFORTS.includes(value as ReasoningEffort);
}

export function isAgentMode(value: string): value is AgentMode {
  return VALID_MODES.includes(value as AgentMode);
}

export function isDelegationMode(value: string): value is DelegationMode {
  return VALID_DELEGATION_MODES.includes(value as DelegationMode);
}

/** Every setting the shared engine is allowed to ask its host for. */
export interface OllibertySettings {
  readonly url: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly contextLength: number;
  readonly effort: ReasoningEffort;
  readonly mode: AgentMode;
  readonly planFirst: boolean;
  readonly autoApplyEdits: boolean;
  readonly showActivityFeed: boolean;
  readonly streamResponses: boolean;
  readonly autoIndexWorkspace: boolean;
  readonly codeIndexMaxFiles: number;
  readonly codeIndexMaxFileSizeKb: number;
  readonly codeIndexPreviewLines: number;
  readonly codeIndexStaleAfterMinutes: number;
  readonly codeIndexExcludeGlob: string;
  readonly networkKillSwitchEnabled: boolean;
  readonly allowedHosts: string[];
  /** Idle budget: how long a started stream may go quiet before it is dead. */
  readonly timeoutMs: number;
  /** Queue budget: how long to wait for the model server's first token. */
  readonly queueTimeoutMs: number;
  readonly delegationMode: DelegationMode;
  readonly agentsMaxCount: number;
  readonly agentsMaxParallel: number;
  readonly agentMaxTokens: number;

  setModel(model: string): Promise<void>;
  setEffort(effort: ReasoningEffort): Promise<void>;
  setMode(mode: AgentMode): Promise<void>;
  reload(): void;
  isHostAllowed(host: string): boolean;
  assertUrlAllowed(urlLike: URL | string): void;
  privacySummary(): string;
}

/** Kill-switch check shared by both hosts so the rule cannot drift. */
export function assertUrlAllowedFor(settings: OllibertySettings, urlLike: URL | string): void {
  if (!settings.networkKillSwitchEnabled) {
    return;
  }

  const url = typeof urlLike === 'string' ? new URL(urlLike) : urlLike;
  const host = url.hostname.trim().toLowerCase();
  if (!settings.isHostAllowed(host)) {
    throw new Error(
      `Network kill switch blocked host '${url.hostname}'. Allowed hosts: ${settings.allowedHosts.join(', ')}.`
    );
  }
}

export function normalizeAllowedHosts(configured: string[] | undefined): string[] {
  const normalized = (configured ?? DEFAULT_ALLOWED_HOSTS)
    .map(host => host.trim().toLowerCase())
    .filter(host => host.length > 0);

  return normalized.length ? Array.from(new Set(normalized)) : [...DEFAULT_ALLOWED_HOSTS];
}

export function formatPrivacySummary(settings: OllibertySettings): string {
  return [
    `🛡️ **Network kill switch:** ${settings.networkKillSwitchEnabled ? 'enabled' : 'disabled'}`,
    `✅ **Allowed hosts:** ${settings.allowedHosts.join(', ')}`
  ].join('\n');
}
