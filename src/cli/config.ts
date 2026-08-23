// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  File-backed settings for the CLI.
 *  Same keys, defaults, and semantics as the VS Code configuration, layered
 *  defaults < ~/.olliberty/config.json < <project>/.olliberty/config.json
 *  < environment < command-line flags. Writes land in the user config file,
 *  mirroring the extension's ConfigurationTarget.Global.                   */

import * as fs from 'fs';
import * as path from 'path';
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
} from '../main/core/settingsContract';
import { projectConfigPath, userConfigPath } from './paths';

type ConfigValue = unknown;
type ConfigLayer = Record<string, ConfigValue>;

export interface SettingsOverrides {
  url?: string;
  model?: string;
  mode?: AgentMode;
  effort?: ReasoningEffort;
  autoApplyEdits?: boolean;
  streamResponses?: boolean;
  autoIndexWorkspace?: boolean;
  delegation?: DelegationMode;
}

const CONFIG_KEYS = [
  'url',
  'model',
  'mode',
  'systemPrompt',
  'temperature',
  'maxTokens',
  'contextLength',
  'effort',
  'showActivityFeed',
  'streamResponses',
  'autoApplyEdits',
  'timeoutMs',
  'queueTimeoutMs',
  'agents.delegation',
  'agents.maxCount',
  'agents.maxParallel',
  'agents.maxTokens',
  'codeIndex.autoIndexWorkspace',
  'codeIndex.maxFiles',
  'codeIndex.maxFileSizeKb',
  'codeIndex.previewLines',
  'codeIndex.staleAfterMinutes',
  'codeIndex.excludeGlob',
  'privacy.networkKillSwitchEnabled',
  'privacy.allowedHosts'
] as const;

export type ConfigKey = typeof CONFIG_KEYS[number];

export function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(stripPrefix(key));
}

export function listConfigKeys(): readonly string[] {
  return CONFIG_KEYS;
}

function stripPrefix(key: string): string {
  return key.startsWith('olliberty.') ? key.slice('olliberty.'.length) : key;
}

function readJsonFile(filePath: string): ConfigLayer {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ConfigLayer)
      : {};
  } catch {
    /* A missing or malformed config file must never stop the CLI from
       starting; defaults are always valid. */
    return {};
  }
}

/** Reads `codeIndex.maxFiles` whether it was written flat or nested. */
function lookup(layer: ConfigLayer, key: string): ConfigValue {
  const normalizedKey = stripPrefix(key);
  if (Object.prototype.hasOwnProperty.call(layer, normalizedKey)) {
    return layer[normalizedKey];
  }
  if (Object.prototype.hasOwnProperty.call(layer, `olliberty.${normalizedKey}`)) {
    return layer[`olliberty.${normalizedKey}`];
  }

  const segments = normalizedKey.split('.');
  let cursor: ConfigValue = layer;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as ConfigLayer)[segment];
  }
  return cursor;
}

function envUrl(): string | undefined {
  const raw = (process.env.OLLIBERTY_URL ?? process.env.OLLAMA_HOST)?.trim();
  if (!raw) {
    return undefined;
  }
  /* OLLAMA_HOST is conventionally bare host:port. */
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
}

/* Flag names stay short on the command line; config keys stay grouped. */
const OVERRIDE_KEY_ALIASES: Record<string, string> = {
  autoIndexWorkspace: 'codeIndex.autoIndexWorkspace',
  delegation: 'agents.delegation'
};

function environmentLayer(): ConfigLayer {
  const layer: ConfigLayer = {};
  const url = envUrl();
  if (url) {
    layer.url = url;
  }
  const model = process.env.OLLIBERTY_MODEL?.trim();
  if (model) {
    layer.model = model;
  }
  const mode = process.env.OLLIBERTY_MODE?.trim().toLowerCase();
  if (mode) {
    layer.mode = mode;
  }
  const effort = process.env.OLLIBERTY_EFFORT?.trim().toLowerCase();
  if (effort) {
    layer.effort = effort;
  }
  const delegation = process.env.OLLIBERTY_DELEGATION?.trim().toLowerCase();
  if (delegation) {
    layer['agents.delegation'] = delegation;
  }
  return layer;
}

export class FileSettings implements OllibertySettings {
  private userLayer: ConfigLayer = {};
  private projectLayer: ConfigLayer = {};
  private envLayer: ConfigLayer = {};
  private readonly overrideLayer: ConfigLayer = {};

  constructor(
    private readonly workspaceRoot: string,
    overrides: SettingsOverrides = {}
  ) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        this.overrideLayer[OVERRIDE_KEY_ALIASES[key] ?? key] = value;
      }
    }
    this.reload();
  }

  reload(): void {
    this.userLayer = readJsonFile(userConfigPath());
    this.projectLayer = readJsonFile(projectConfigPath(this.workspaceRoot));
    this.envLayer = environmentLayer();
  }

  /** Highest-priority layer that defines `key`, or undefined. */
  private read<T>(key: ConfigKey): T | undefined {
    for (const layer of [this.overrideLayer, this.envLayer, this.projectLayer, this.userLayer]) {
      const value = lookup(layer, key);
      if (value !== undefined && value !== null) {
        return value as T;
      }
    }
    return undefined;
  }

  private readNumber(key: ConfigKey, fallback: number, min: number, max: number): number {
    const raw = this.read<unknown>(key);
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
  }

  private readBoolean(key: ConfigKey, fallback: boolean): boolean {
    const raw = this.read<unknown>(key);
    if (typeof raw === 'boolean') {
      return raw;
    }
    if (typeof raw === 'string') {
      if (/^(true|yes|on|1)$/i.test(raw)) { return true; }
      if (/^(false|no|off|0)$/i.test(raw)) { return false; }
    }
    return fallback;
  }

  private readString(key: ConfigKey, fallback: string): string {
    const raw = this.read<unknown>(key);
    return typeof raw === 'string' && raw.trim() ? raw : fallback;
  }

  get url(): string { return this.readString('url', DEFAULT_URL).trim() || DEFAULT_URL; }
  get model(): string { return this.readString('model', DEFAULT_MODEL); }
  get systemPrompt(): string {
    const raw = this.read<unknown>('systemPrompt');
    return typeof raw === 'string' ? raw : '';
  }
  get temperature(): number { return this.readNumber('temperature', 0.2, 0, 1); }
  get maxTokens(): number { return this.readNumber('maxTokens', 2048, 1, 8192); }
  get contextLength(): number { return this.readNumber('contextLength', 4096, 512, 131_072); }

  get effort(): ReasoningEffort {
    const effort = this.readString('effort', DEFAULT_EFFORT).trim().toLowerCase();
    return isReasoningEffort(effort) ? effort : DEFAULT_EFFORT;
  }

  get mode(): AgentMode {
    const mode = this.readString('mode', DEFAULT_MODE).trim().toLowerCase();
    return isAgentMode(mode) ? mode : DEFAULT_MODE;
  }

  get planFirst(): boolean { return this.mode === 'plan'; }

  /* Plan mode always gates writes behind an explicit approval, whatever
     autoApplyEdits says — accepting a plan is not accepting the diff. */
  get autoApplyEdits(): boolean {
    if (this.planFirst) {
      return false;
    }
    return this.readBoolean('autoApplyEdits', false);
  }

  get showActivityFeed(): boolean { return this.readBoolean('showActivityFeed', true); }
  get streamResponses(): boolean { return this.readBoolean('streamResponses', true); }
  get autoIndexWorkspace(): boolean { return this.readBoolean('codeIndex.autoIndexWorkspace', true); }
  get codeIndexMaxFiles(): number { return this.readNumber('codeIndex.maxFiles', 500, 50, 5000); }
  get codeIndexMaxFileSizeKb(): number { return this.readNumber('codeIndex.maxFileSizeKb', 256, 16, 2048); }
  get codeIndexPreviewLines(): number { return this.readNumber('codeIndex.previewLines', 35, 5, 200); }
  get codeIndexStaleAfterMinutes(): number { return this.readNumber('codeIndex.staleAfterMinutes', 10, 1, 1440); }
  get codeIndexExcludeGlob(): string {
    return this.readString('codeIndex.excludeGlob', DEFAULT_CODE_INDEX_EXCLUDE_GLOB);
  }
  get networkKillSwitchEnabled(): boolean {
    return this.readBoolean('privacy.networkKillSwitchEnabled', true);
  }
  get allowedHosts(): string[] {
    const raw = this.read<unknown>('privacy.allowedHosts');
    return normalizeAllowedHosts(Array.isArray(raw) ? raw.filter((host): host is string => typeof host === 'string') : undefined);
  }
  /* Idle budget only: a stream that has started and then goes silent this
     long is dead. The wait for the *first* token is queueTimeoutMs. */
  get timeoutMs(): number { return this.readNumber('timeoutMs', 90_000, 5_000, 600_000); }
  /* Ollama runs one request per loaded model at a time, so a fanned-out agent
     can legitimately sit in the queue for minutes on a large local model.
     Killing it at 45s is what turned a slow agent into a failed one. */
  get queueTimeoutMs(): number { return this.readNumber('queueTimeoutMs', 600_000, 10_000, 3_600_000); }

  get delegationMode(): DelegationMode {
    const mode = this.readString('agents.delegation', DEFAULT_DELEGATION_MODE).trim().toLowerCase();
    return isDelegationMode(mode) ? mode : DEFAULT_DELEGATION_MODE;
  }
  get agentsMaxCount(): number {
    return this.readNumber('agents.maxCount', MAX_DELEGATED_AGENTS, 1, MAX_DELEGATED_AGENTS);
  }
  get agentsMaxParallel(): number {
    return this.readNumber('agents.maxParallel', 2, 1, MAX_DELEGATED_AGENTS);
  }
  get agentMaxTokens(): number {
    return this.readNumber('agents.maxTokens', 900, 128, 8192);
  }

  async setModel(model: string): Promise<void> {
    await this.writeUserValue('model', model.trim() || DEFAULT_MODEL);
  }

  async setEffort(effort: ReasoningEffort): Promise<void> {
    await this.writeUserValue('effort', effort);
  }

  async setMode(mode: AgentMode): Promise<void> {
    await this.writeUserValue('mode', mode);
  }

  /** Persist one key to the user config file, then re-layer. */
  async writeUserValue(key: string, value: ConfigValue): Promise<void> {
    const normalizedKey = stripPrefix(key);
    const target = userConfigPath();
    const existing = readJsonFile(target);
    const next: ConfigLayer = { ...existing };

    /* Keep the file shaped the way the user already wrote it. */
    if (Object.prototype.hasOwnProperty.call(existing, normalizedKey) || !normalizedKey.includes('.')) {
      next[normalizedKey] = value;
    } else {
      const [group, ...rest] = normalizedKey.split('.');
      const groupValue = existing[group];
      const groupLayer: ConfigLayer =
        groupValue && typeof groupValue === 'object' && !Array.isArray(groupValue)
          ? { ...(groupValue as ConfigLayer) }
          : {};
      groupLayer[rest.join('.')] = value;
      next[group] = groupLayer;
    }

    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    /* Command-line flags outrank the file for the rest of this process; drop
       the override for a key the user just changed on purpose. */
    delete this.overrideLayer[normalizedKey];
    this.reload();
  }

  /**
   * Every configurable key with its effective value. Lives here rather than in
   * the command that prints it, so adding a key to CONFIG_KEYS without giving
   * it a value is a compile error instead of a `/config` line reading
   * `undefined`.
   */
  snapshot(): Record<ConfigKey, unknown> {
    return {
      'url': this.url,
      'model': this.model,
      'mode': this.mode,
      'systemPrompt': this.systemPrompt,
      'temperature': this.temperature,
      'maxTokens': this.maxTokens,
      'contextLength': this.contextLength,
      'effort': this.effort,
      'showActivityFeed': this.showActivityFeed,
      'streamResponses': this.streamResponses,
      'autoApplyEdits': this.autoApplyEdits,
      'timeoutMs': this.timeoutMs,
      'queueTimeoutMs': this.queueTimeoutMs,
      'agents.delegation': this.delegationMode,
      'agents.maxCount': this.agentsMaxCount,
      'agents.maxParallel': this.agentsMaxParallel,
      'agents.maxTokens': this.agentMaxTokens,
      'codeIndex.autoIndexWorkspace': this.autoIndexWorkspace,
      'codeIndex.maxFiles': this.codeIndexMaxFiles,
      'codeIndex.maxFileSizeKb': this.codeIndexMaxFileSizeKb,
      'codeIndex.previewLines': this.codeIndexPreviewLines,
      'codeIndex.staleAfterMinutes': this.codeIndexStaleAfterMinutes,
      'codeIndex.excludeGlob': this.codeIndexExcludeGlob,
      'privacy.networkKillSwitchEnabled': this.networkKillSwitchEnabled,
      'privacy.allowedHosts': this.allowedHosts
    };
  }

  /** Where a value is coming from — shown by `/config`. */
  describeSource(key: ConfigKey): 'flag' | 'env' | 'project' | 'user' | 'default' {
    if (lookup(this.overrideLayer, key) !== undefined) { return 'flag'; }
    if (lookup(this.envLayer, key) !== undefined) { return 'env'; }
    if (lookup(this.projectLayer, key) !== undefined) { return 'project'; }
    if (lookup(this.userLayer, key) !== undefined) { return 'user'; }
    return 'default';
  }

  isHostAllowed(host: string): boolean {
    return this.allowedHosts.includes(host.trim().toLowerCase());
  }

  assertUrlAllowed(urlLike: URL | string): void {
    assertUrlAllowedFor(this, urlLike);
  }

  privacySummary(): string {
    return formatPrivacySummary(this);
  }
}
