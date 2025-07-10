/*  UI: simple Q&A command.
 *  - Shows InputBox → streams answer in Notification.
 *  - Keeps zero domain logic (delegates to OllamaClient).       */

import * as vscode     from 'vscode';
import { OllamaClient } from '../client';

export class AskAICommand {
  constructor(private readonly client: OllamaClient) {}

  async execute(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const question = await vscode.window.showInputBox({
      prompt: 'Ask Ollama',
      ignoreFocusOut: true,
      validateInput: v => v.trim() ? null : 'Type a question',
    });
    if (!question) return;

    /* Combine user question with current file to keep UX simple */
    const prompt = `${question}\n\n${editor.document.getText()}`;
    const abort  = new AbortController();

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Ollama', cancellable: true },
      async (progress, token) => {
        token.onCancellationRequested(() => abort.abort());

        let answer = '';
        try {
          answer = await this.client.generate({ prompt, stream: true }, abort.signal);
          progress.report({ message: answer.slice(-80) });
          vscode.window.showInformationMessage(answer);
        } catch (err) {
          if (!abort.signal.aborted) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Ollama error: ${msg}`);
          }
        }
      },
    );
  }
}
