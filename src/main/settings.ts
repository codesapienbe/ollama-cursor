/*  Central settings accessor.
 *  Single Responsibility: read & validate user configuration.
 *  Open/Closed: modification only by adding new getters.        */

 import * as vscode from 'vscode';

 export class Settings {
   private cfg = vscode.workspace.getConfiguration('ollama');
 
   get model(): string         { return this.cfg.get('model')         ?? 'codellama'; }
   get temperature(): number   { return this.cfg.get('temperature')   ?? 0.2;        }
   get maxTokens(): number     { return this.cfg.get('maxTokens')     ?? 2048;       }
   get contextLength(): number { return this.cfg.get('contextLength') ?? 4096;       }
   get timeoutMs(): number     { return 45_000; }   // hard-coded for simplicity
 
   reload(): void {
     this.cfg = vscode.workspace.getConfiguration('ollama');
   }
 }
 