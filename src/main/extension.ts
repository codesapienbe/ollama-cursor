/*  ──────────────────────────────────────────────────────────────
 *  VS Code / Cursor entry-point.
 *  - Bootstraps services.
 *  - Wires providers & commands.
 *  - Keeps zero business logic.
 *  ────────────────────────────────────────────────────────────── */

import * as vscode from 'vscode';
import { Settings }          from './settings';
import { OllamaClient }      from './client';
import { InlineProvider }    from './ui/inlineProvider';
import { AskAICommand }      from './ui/askAICommand';

/** Service container shared across the extension host. */
export class Container {
  readonly settings = new Settings();
  readonly client   = new OllamaClient(this.settings);
}

let container: Container;

/*---------------------------------------------------------------*/
export function activate(ctx: vscode.ExtensionContext): void {
  container = new Container();

  /* Inline code completions */
  ctx.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new InlineProvider(container.client),
    ),
  );

  /* Command palette action */
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'ollama.askAI',
      () => new AskAICommand(container.client).execute(),
    ),
  );

  /* React to settings changes */
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('ollama')) {
        container.settings.reload();
        vscode.window.showInformationMessage('Ollama settings reloaded');
      }
    }),
  );
}

/*---------------------------------------------------------------*/
export function deactivate(): void {
  /* Nothing to dispose: everything is bound to ctx.subscriptions */
}
