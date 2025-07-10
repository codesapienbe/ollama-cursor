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

    // Check connection first
    try {
      const isHealthy = await this.client.isHealthy();
      if (!isHealthy) {
        vscode.window.showErrorMessage(
          'Ollama Connection Failed',
          {
            detail: 'Unable to connect to Ollama server. Please ensure Ollama is running on localhost:11434.',
            modal: false,
          }
        );
        return;
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        'Ollama Connection Error',
        {
          detail: `Failed to check Ollama connection: ${error instanceof Error ? error.message : String(error)}`,
          modal: false,
        }
      );
      return;
    }

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
            const errorMsg = this._formatErrorMessage(err);
            vscode.window.showErrorMessage(`Ollama error: ${errorMsg}`);
          }
        }
      },
    );
  }

  private _formatErrorMessage(error: any): string {
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    if (errorMsg.includes('Failed to connect') || errorMsg.includes('ECONNREFUSED')) {
      return 'Ollama server is not running. Please start Ollama on localhost:11434.';
    }
    
    if (errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT')) {
      return 'Ollama server is not responding. Please check if Ollama is running.';
    }
    
    if (errorMsg.includes('HTTP 404')) {
      return 'The specified model is not available. Please check your Ollama model configuration.';
    }
    
    if (errorMsg.includes('HTTP 500')) {
      return 'Ollama server encountered an internal error. Please restart Ollama.';
    }
    
    return errorMsg;
  }
}
