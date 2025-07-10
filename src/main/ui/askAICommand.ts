/*  UI: simple Q&A command.
 *  - Shows InputBox → streams answer in Notification.
 *  - Keeps zero domain logic (delegates to OllamaClient).       */

import * as vscode     from 'vscode';
import { OllamaClient } from '../client';
import { OllamaInstaller } from './ollamaInstaller';

export class AskAICommand {
  constructor(private readonly client: OllamaClient) {}

  async execute(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // Check connection first
    try {
      const isHealthy = await this.client.isHealthy();
      if (!isHealthy) {
        await this._showInstallationOptions();
        return;
      }
    } catch (error) {
      await this._showInstallationOptions();
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

  private async _showInstallationOptions(): Promise<void> {
    const osInfo = OllamaInstaller.detectOS();
    
    const action = await vscode.window.showErrorMessage(
      `Ollama Not Available on ${osInfo}`,
      {
        modal: true,
        detail: `Ollama is not installed or not running on your system. Would you like to see installation instructions for ${osInfo}?`
      },
      'Show Installation Instructions',
      'Open Download Page',
      'Cancel'
    );

    switch (action) {
      case 'Show Installation Instructions':
        const installInfo = OllamaInstaller.getInstallationInfo();
        await OllamaInstaller.showInstallationInstructions(installInfo);
        break;
      case 'Open Download Page':
        const downloadInfo = OllamaInstaller.getInstallationInfo();
        await vscode.env.openExternal(vscode.Uri.parse(downloadInfo.downloadUrl));
        break;
    }
  }

  private _formatErrorMessage(error: any): string {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const osInfo = OllamaInstaller.detectOS();
    
    if (errorMsg.includes('Failed to connect') || errorMsg.includes('ECONNREFUSED')) {
      return `Ollama server is not running on ${osInfo}. Please install and start Ollama.`;
    }
    
    if (errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT')) {
      return `Ollama server is not responding on ${osInfo}. Please check if Ollama is running.`;
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
