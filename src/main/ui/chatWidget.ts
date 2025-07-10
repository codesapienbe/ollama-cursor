/*  UI: Chat Widget Provider
 *  - Implements webview-based chat interface similar to GitHub Copilot
 *  - Provides persistent chat session with message history
 *  - Handles secure message passing between webview and extension
 *  - Maintains conversation context for better AI responses         */

import * as vscode from 'vscode';
import { OllamaClient } from '../client';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export class ChatWidgetProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ollama.chatView';

  private _view?: vscode.WebviewView;
  private _messages: ChatMessage[] = [];
  private _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _client: OllamaClient,
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      (data) => {
        switch (data.type) {
          case 'sendMessage':
            this._handleSendMessage(data.message);
            break;
          case 'clearChat':
            this._clearChat();
            break;
          case 'getContext':
            this._sendContext();
            break;
        }
      },
      null,
      this._disposables,
    );

    // Send initial data to webview
    this._updateWebview();
  }

  private async _handleSendMessage(message: string): Promise<void> {
    if (!message.trim()) return;

    const userMessage: ChatMessage = {
      id: this._generateId(),
      role: 'user',
      content: message.trim(),
      timestamp: Date.now(),
    };

    this._messages.push(userMessage);
    this._updateWebview();

    try {
      // Get current editor context for better responses
      const editor = vscode.window.activeTextEditor;
      let contextPrompt = message;

      if (editor) {
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);
        
        if (selectedText) {
          contextPrompt = `Based on this selected code:\n\`\`\`${editor.document.languageId}\n${selectedText}\n\`\`\`\n\n${message}`;
        } else {
          const fileName = editor.document.fileName;
          const fileContent = editor.document.getText();
          
          // Include file context if reasonable size
          if (fileContent.length < 2000) {
            contextPrompt = `In the context of file ${fileName}:\n\`\`\`${editor.document.languageId}\n${fileContent}\n\`\`\`\n\n${message}`;
          }
        }
      }

      // Add conversation history for context
      const conversationHistory = this._messages
        .slice(-6) // Keep last 6 messages for context
        .map(msg => `${msg.role}: ${msg.content}`)
        .join('\n\n');

      const fullPrompt = conversationHistory ? 
        `Previous conversation:\n${conversationHistory}\n\nCurrent request: ${contextPrompt}` : 
        contextPrompt;

      const response = await this._client.generate({ 
        prompt: fullPrompt, 
        stream: true 
      });

      const assistantMessage: ChatMessage = {
        id: this._generateId(),
        role: 'assistant',
        content: response,
        timestamp: Date.now(),
      };

      this._messages.push(assistantMessage);
      this._updateWebview();

    } catch (error) {
      const errorMessage: ChatMessage = {
        id: this._generateId(),
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now(),
      };

      this._messages.push(errorMessage);
      this._updateWebview();
    }
  }

  private _clearChat(): void {
    this._messages = [];
    this._updateWebview();
  }

  private _sendContext(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);
    
    this._view?.webview.postMessage({
      type: 'context',
      data: {
        fileName: editor.document.fileName,
        languageId: editor.document.languageId,
        selectedText,
        hasSelection: !selection.isEmpty,
      }
    });
  }

  private _updateWebview(): void {
    if (!this._view) return;

    this._view.webview.postMessage({
      type: 'updateMessages',
      messages: this._messages,
    });
  }

  private _generateId(): string {
    return Math.random().toString(36).substr(2, 9);
  }

  public clearChat(): void {
    this._clearChat();
  }

  public dispose(): void {
    this._disposables.forEach(d => d.dispose());
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css')
    );

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'script.js')
    );

    // Security: Use nonce for inline scripts
    const nonce = this._getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <link href="${styleUri}" rel="stylesheet">
    <title>Ollama Chat</title>
</head>
<body>
    <div id="chat-container">
        <div id="messages-container"></div>
        <div id="input-container">
            <div id="context-info"></div>
            <textarea id="message-input" placeholder="Ask Ollama..." rows="3"></textarea>
            <button id="send-button">Send</button>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let messages = [];

        const messagesContainer = document.getElementById('messages-container');
        const messageInput = document.getElementById('message-input');
        const sendButton = document.getElementById('send-button');
        const contextInfo = document.getElementById('context-info');

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function renderMessages() {
            messagesContainer.innerHTML = '';
            messages.forEach(message => {
                const messageElement = document.createElement('div');
                messageElement.className = \`message \${message.role}\`;
                
                const content = message.content.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
                    .replace(/\`([^\`]+)\`/g, '<code>$1</code>');
                
                messageElement.innerHTML = \`
                    <div class="message-header">
                        <span class="role">\${message.role}</span>
                        <span class="timestamp">\${new Date(message.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <div class="message-content">\${content}</div>
                \`;
                
                messagesContainer.appendChild(messageElement);
            });
            
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        function sendMessage() {
            const message = messageInput.value.trim();
            if (!message) return;

            vscode.postMessage({
                type: 'sendMessage',
                message: message
            });

            messageInput.value = '';
            messageInput.style.height = 'auto';
        }

        sendButton.addEventListener('click', sendMessage);

        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        messageInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = this.scrollHeight + 'px';
        });

        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
                case 'updateMessages':
                    messages = message.messages;
                    renderMessages();
                    break;
                case 'context':
                    const ctx = message.data;
                    if (ctx.hasSelection) {
                        contextInfo.innerHTML = \`📄 \${ctx.fileName} (selection)\`;
                    } else {
                        contextInfo.innerHTML = \`📄 \${ctx.fileName}\`;
                    }
                    break;
            }
        });

        // Request context on load
        vscode.postMessage({ type: 'getContext' });
    </script>
</body>
</html>`;
  }

  private _getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
} 