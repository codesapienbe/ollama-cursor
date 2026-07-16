/*  Central settings accessor.
 *  Single Responsibility: read & validate user configuration.
 *  Open/Closed: modification only by adding new getters.        */

 import * as vscode from 'vscode';

 export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max';

 const DEFAULT_URL = 'http://localhost:11434';
 const DEFAULT_MODEL = 'gemma4:12b-it-qat';
 const DEFAULT_EFFORT: ReasoningEffort = 'medium';
 const VALID_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'max'];

 export function isReasoningEffort(value: string): value is ReasoningEffort {
   return VALID_EFFORTS.includes(value as ReasoningEffort);
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
 
   reload(): void {
     this.cfg = vscode.workspace.getConfiguration('olliberty');
   }
 }
 