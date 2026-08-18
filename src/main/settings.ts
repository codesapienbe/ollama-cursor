/*  Central settings accessor.
 *  Single Responsibility: read & validate user configuration.
 *  Open/Closed: modification only by adding new getters.        */

 import * as vscode from 'vscode';

 export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max';
 export type AgentMode = 'plan' | 'auto';

 const DEFAULT_URL = 'http://localhost:11434';
 export const DEFAULT_MODEL = 'qwen3.8:latest';
 const DEFAULT_EFFORT: ReasoningEffort = 'medium';
 const DEFAULT_MODE: AgentMode = 'plan';
 const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];
 const VALID_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'max'];
 const VALID_MODES: AgentMode[] = ['plan', 'auto'];

 export function isReasoningEffort(value: string): value is ReasoningEffort {
   return VALID_EFFORTS.includes(value as ReasoningEffort);
 }

 export function isAgentMode(value: string): value is AgentMode {
   return VALID_MODES.includes(value as AgentMode);
 }

 export class Settings {
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
     return this.cfg.get<string>('codeIndex.excludeGlob')
       ?? '**/{.git,node_modules,dist,build,out,target,coverage,.next,.ollama,.olliberty}/**';
   }
   get networkKillSwitchEnabled(): boolean {
     return this.cfg.get<boolean>('privacy.networkKillSwitchEnabled') ?? true;
   }
   get allowedHosts(): string[] {
     const configured = this.cfg.get<string[]>('privacy.allowedHosts') ?? DEFAULT_ALLOWED_HOSTS;
     const normalized = configured
       .map(host => host.trim().toLowerCase())
       .filter(host => host.length > 0);

     if (!normalized.length) {
       return DEFAULT_ALLOWED_HOSTS;
     }

     return Array.from(new Set(normalized));
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
     if (!this.networkKillSwitchEnabled) {
       return;
     }

     const url = typeof urlLike === 'string' ? new URL(urlLike) : urlLike;
     const host = url.hostname.trim().toLowerCase();
     if (!this.isHostAllowed(host)) {
       throw new Error(
         `Network kill switch blocked host '${url.hostname}'. Allowed hosts: ${this.allowedHosts.join(', ')}.`
       );
     }
   }

   privacySummary(): string {
     return [
       `🛡️ **Network kill switch:** ${this.networkKillSwitchEnabled ? 'enabled' : 'disabled'}`,
       `✅ **Allowed hosts:** ${this.allowedHosts.join(', ')}`
     ].join('\n');
   }
 }
 