/*  UI: simple Q&A command.
 *  - Shows InputBox → streams answer to timestamped .md file.
 *  - Keeps zero domain logic (delegates to OllamaClient).       */

import * as vscode     from 'vscode';
import * as path       from 'path';
import * as fs         from 'fs';
import { OllamaClient } from '../client';
import { OllamaInstaller } from './ollamaInstaller';
import { Settings } from '../settings';

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

    // Create output file
    const outputFile = await this._createOutputFile(question);
    if (!outputFile) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Ollama: Generating response...', cancellable: true },
      async (progress, token) => {
        token.onCancellationRequested(() => abort.abort());

        try {
          await this._streamToFile(outputFile, prompt, question, abort.signal, progress);
        } catch (err) {
          if (!abort.signal.aborted) {
            const errorMsg = this._formatErrorMessage(err);
            await this._appendToFile(outputFile, `\n\n**Error:** ${errorMsg}\n`);
            vscode.window.showErrorMessage(`Ollama error: ${errorMsg}`);
          }
        }
      },
    );
  }

  private async _createOutputFile(question: string): Promise<string | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return null;
    }

    // Create .ollama directory
    const ollamaDir = path.join(workspaceFolder.uri.fsPath, '.ollama');
    if (!fs.existsSync(ollamaDir)) {
      fs.mkdirSync(ollamaDir, { recursive: true });
    }

    // Generate timestamp and safe filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeQuestion = question.slice(0, 50).replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    const filename = `${timestamp}_${safeQuestion}.md`;
    const filePath = path.join(ollamaDir, filename);

    // Create initial file content
    const initialContent = `# Ollama Response - ${new Date().toLocaleString()}

## Question
${question}

## Response
`;

    try {
      fs.writeFileSync(filePath, initialContent, 'utf8');
      
      // Open the file
      const document = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
      
      return filePath;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create output file: ${error}`);
      return null;
    }
  }

  private async _streamToFile(
    filePath: string, 
    prompt: string, 
    question: string, 
    abortSignal: AbortSignal,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<void> {
    // Modified client call for streaming to file
    const settings = new Settings();
    const requestData = JSON.stringify({
      model: settings.model,
      prompt: prompt,
      ...(settings.systemPrompt ? { system: settings.systemPrompt } : {}),
      temperature: settings.temperature,
      stream: true,
      options: {
        num_predict: settings.maxTokens,
        num_ctx: settings.contextLength,
      },
    });

    const url = new URL('/api/generate', settings.url);
    const transport = url.protocol === 'https:' ? require('https') : require('http');
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestData)
      }
    };

    return new Promise<void>((resolve, reject) => {
      const req = transport.request(url, options, (res: any) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Ollama: HTTP ${res.statusCode} ${res.statusMessage}`));
          return;
        }

        let responseData = '';
        let fullResponse = '';
        let wordCount = 0;

        res.on('data', (chunk: Buffer) => {
          responseData += chunk.toString();
          
          const lines = responseData.split('\n');
          responseData = lines.pop() || '';
          
          for (const line of lines) {
            if (line.trim()) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.response) {
                  fullResponse += parsed.response;
                  
                  // Update progress and append to file in chunks
                  wordCount += parsed.response.split(' ').length;
                  progress.report({ 
                    message: `Generated ${wordCount} words...` 
                  });
                  
                  // Append to file immediately for real-time viewing
                  this._appendToFile(filePath, parsed.response);
                }
                if (parsed.done) {
                  // Add final newlines and timestamp
                  this._appendToFile(filePath, `\n\n---\n*Generated at ${new Date().toLocaleString()}*\n`);
                  resolve();
                  return;
                }
              } catch (e) {
                // Ignore JSON parsing errors for partial responses
              }
            }
          }
        });

        res.on('end', () => {
          if (fullResponse) {
            resolve();
          } else {
            reject(new Error('No response received from Ollama'));
          }
        });

        res.on('error', (err: Error) => {
          reject(err);
        });
      });

      req.on('error', (err: Error) => {
        reject(new Error(`Failed to connect to Ollama: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request to Ollama timed out'));
      });

      // Handle abort signal
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('Request was aborted'));
        });
      }

      req.setTimeout(settings.timeoutMs);
      req.write(requestData);
      req.end();
    });
  }

  private _appendToFile(filePath: string, content: string): void {
    try {
      fs.appendFileSync(filePath, content, 'utf8');
    } catch (error) {
      console.error('Failed to append to file:', error);
    }
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
