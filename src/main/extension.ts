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
import { ChatWidgetProvider } from './ui/chatWidget';
import { RightPanelWidgetProvider } from './ui/rightPanelWidget';

/** Service container shared across the extension host. */
export class Container {
  readonly settings = new Settings();
  readonly client   = new OllamaClient(this.settings);
}

let container: Container;
let chatProvider: ChatWidgetProvider;
let rightPanelProvider: RightPanelWidgetProvider;

/*---------------------------------------------------------------*/
export function activate(ctx: vscode.ExtensionContext): void {
  container = new Container();

  /* Chat Widget Provider (Left Sidebar) */
  chatProvider = new ChatWidgetProvider(ctx.extensionUri, container.client);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatWidgetProvider.viewType,
      chatProvider
    )
  );

  /* Right Panel Widget Provider (Secondary Sidebar) */
  rightPanelProvider = new RightPanelWidgetProvider(ctx.extensionUri, container.client);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      RightPanelWidgetProvider.viewType,
      rightPanelProvider
    )
  );

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

  /* Open chat widget command (Left Sidebar) */
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'ollama.openChatWidget',
      async () => {
        try {
          // First, try to show the view container
          await vscode.commands.executeCommand('workbench.view.extension.ollama-sidebar');
          
          // Then focus on the specific chat view
          await vscode.commands.executeCommand('ollama.chatView.focus');
          
          // Show a helpful message
          vscode.window.showInformationMessage('Ollama Chat Widget opened! Look for the 🤖 icon in the Activity Bar.');
          
        } catch (error) {
          // Fallback: try to open the view directly
          try {
            await vscode.commands.executeCommand('workbench.view.extension.ollama-sidebar');
          } catch (fallbackError) {
            vscode.window.showErrorMessage(
              'Could not open Ollama Chat Widget',
              {
                detail: 'Please try clicking the 🤖 icon in the Activity Bar (left sidebar) to open the chat widget.',
                modal: false,
              }
            );
          }
        }
      },
    ),
  );

  /* Open right panel command (Secondary Sidebar) */
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'ollama.openRightPanel',
      async () => {
        try {
          // Show the secondary sidebar view container
          await vscode.commands.executeCommand('workbench.view.extension.ollama-right-panel');
          
          // Focus on the right panel view
          await vscode.commands.executeCommand('ollama.rightPanelView.focus');
          
          // Show a helpful message
          vscode.window.showInformationMessage('Ollama Chat opened in Right Panel! Look for the 🤖 icon in the secondary sidebar.');
          
        } catch (error) {
          // Fallback: try to open the view directly
          try {
            await vscode.commands.executeCommand('workbench.view.extension.ollama-right-panel');
          } catch (fallbackError) {
            vscode.window.showErrorMessage(
              'Could not open Ollama Chat in Right Panel',
              {
                detail: 'Please try clicking the 🤖 icon in the secondary sidebar (right panel) to open the chat widget.',
                modal: false,
              }
            );
          }
        }
      },
    ),
  );

  /* Clear chat command */
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'ollama.clearChat',
      () => {
        // Clear both chat providers
        chatProvider.clearChat();
        rightPanelProvider.clearChat();
      },
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
