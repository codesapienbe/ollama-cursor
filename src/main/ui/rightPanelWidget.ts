/*  UI: Right Panel Chat Widget Provider
 *  - Implements webview-based chat interface for the secondary sidebar (right panel)
 *  - Reuses the same chat functionality as the main sidebar widget
 *  - Provides persistent chat session with message history
 *  - Handles secure message passing between webview and extension
 *  - Maintains conversation context for better AI responses         */

import * as vscode from 'vscode';
import { OllamaClient } from '../client';
import { OllamaInstaller } from './ollamaInstaller';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export class RightPanelWidgetProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ollama.rightPanelView';

  private _view?: vscode.WebviewView;
  private _messages: ChatMessage[] = [];
  private _disposables: vscode.Disposable[] = [];
  private _isConnected: boolean = false;
  private _installationShown: boolean = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _client: OllamaClient,
  ) {
    this._checkConnection();
  }

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
          case 'checkConnection':
            this._checkConnection();
            break;
          case 'installOllama':
            this._showInstallationInstructions();
            break;
        }
      },
      null,
      this._disposables,
    );

    // Send initial data to webview
    this._updateWebview();
  }

  private async _checkConnection(): Promise<void> {
    try {
      this._isConnected = await this._client.isHealthy();
      
      if (!this._isConnected) {
        if (!this._installationShown) {
          // Show installation dialog only once per session
          this._installationShown = true;
          await this._showInstallationDialog();
        }
        
        const osInfo = OllamaInstaller.detectOS();
        this._addSystemMessage(`⚠️ **Ollama not found on ${osInfo}**\n\nClick the "Install Ollama" button below to get OS-specific installation instructions.`);
      } else {
        // Clear any previous connection error messages and reset installation flag
        this._installationShown = false;
        this._messages = this._messages.filter(msg => 
          !msg.content.includes('Ollama is not running') && 
          !msg.content.includes('connection failed') &&
          !msg.content.includes('Ollama not found')
        );
        this._updateWebview();
      }
    } catch (error) {
      this._isConnected = false;
      
      if (!this._installationShown) {
        this._installationShown = true;
        await this._showInstallationDialog();
      }
      
      const osInfo = OllamaInstaller.detectOS();
      this._addSystemMessage(`❌ **Failed to connect to Ollama on ${osInfo}**\n\nThis usually means Ollama is not installed. Click "Install Ollama" below for installation instructions.`);
    }
  }

  private async _showInstallationDialog(): Promise<void> {
    // Show installation dialog
    await OllamaInstaller.showInstallationDialog();
  }

  private async _showInstallationInstructions(): Promise<void> {
    const installInfo = OllamaInstaller.getInstallationInfo();
    await OllamaInstaller.showInstallationInstructions(installInfo);
  }

  private _showConnectionError(): void {
    const osInfo = OllamaInstaller.detectOS();
    vscode.window.showErrorMessage(
      `Ollama Connection Failed on ${osInfo}`,
      {
        detail: 'Unable to connect to Ollama server. This usually means Ollama is not installed or not running.',
        modal: false,
      }
    );
  }

  private _addSystemMessage(content: string): void {
    const systemMessage: ChatMessage = {
      id: this._generateId(),
      role: 'system',
      content,
      timestamp: Date.now(),
    };

    this._messages.push(systemMessage);
    this._updateWebview();
  }

  private async _handleSendMessage(message: string): Promise<void> {
    if (!message.trim()) return;

    // Check connection before sending message
    if (!this._isConnected) {
      await this._checkConnection();
      if (!this._isConnected) {
        const osInfo = OllamaInstaller.detectOS();
        this._addSystemMessage(`❌ **Cannot send message: Ollama is not connected**\n\nPlease install Ollama for ${osInfo} first. Click "Install Ollama" below for instructions.`);
        return;
      }
    }

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
        .filter(msg => msg.role !== 'system') // Exclude system messages from context
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
      const errorMessage = this._formatErrorMessage(error);
      const assistantMessage: ChatMessage = {
        id: this._generateId(),
        role: 'assistant',
        content: errorMessage,
        timestamp: Date.now(),
      };

      this._messages.push(assistantMessage);
      this._updateWebview();

      // Show notification for critical errors
      if (errorMessage.includes('Failed to connect') || errorMessage.includes('timeout')) {
        vscode.window.showWarningMessage(
          'Ollama Connection Issue',
          {
            detail: errorMessage,
            modal: false,
          }
        );
      }
    }
  }

  private _formatErrorMessage(error: any): string {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const osInfo = OllamaInstaller.detectOS();
    
    if (errorMsg.includes('Failed to connect') || errorMsg.includes('ECONNREFUSED')) {
      return `❌ **Connection Failed on ${osInfo}**: Ollama server is not running. Please install and start Ollama, or click "Install Ollama" for installation instructions.`;
    }
    
    if (errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT')) {
      return `⏱️ **Request Timeout on ${osInfo}**: Ollama server is not responding. Please check if Ollama is running and try again.`;
    }
    
    if (errorMsg.includes('HTTP 404')) {
      return '🔍 **Model Not Found**: The specified model is not available. Please check your Ollama model configuration.';
    }
    
    if (errorMsg.includes('HTTP 500')) {
      return '⚠️ **Server Error**: Ollama server encountered an internal error. Please restart Ollama and try again.';
    }
    
    return `❌ **Error**: ${errorMsg}`;
  }

  private _clearChat(): void {
    this._messages = [];
    this._updateWebview();
    
    // Check connection after clearing chat
    this._checkConnection();
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
      isConnected: this._isConnected,
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
        <div id="connection-status"></div>
        <div id="messages-container"></div>
        <div id="input-container">
            <div id="context-info"></div>
            <div id="install-button-container" style="display: none;">
                <button id="install-button" class="install-btn">📥 Install Ollama</button>
            </div>
            <textarea id="message-input" placeholder="Ask Ollama..." rows="3"></textarea>
            <button id="send-button">Send</button>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let messages = [];
        let isConnected = false;

        const messagesContainer = document.getElementById('messages-container');
        const messageInput = document.getElementById('message-input');
        const sendButton = document.getElementById('send-button');
        const contextInfo = document.getElementById('context-info');
        const connectionStatus = document.getElementById('connection-status');
        const installButtonContainer = document.getElementById('install-button-container');
        const installButton = document.getElementById('install-button');

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function updateConnectionStatus() {
            if (!isConnected) {
                connectionStatus.innerHTML = '<div class="connection-error">⚠️ Ollama not connected</div>';
                installButtonContainer.style.display = 'block';
                messageInput.disabled = true;
                sendButton.disabled = true;
                messageInput.placeholder = 'Install Ollama to continue...';
            } else {
                connectionStatus.innerHTML = '<div class="connection-success">✅ Ollama connected</div>';
                installButtonContainer.style.display = 'none';
                messageInput.disabled = false;
                sendButton.disabled = false;
                messageInput.placeholder = 'Ask Ollama...';
            }
        }

        function renderMessages() {
            messagesContainer.innerHTML = '';
            
            if (messages.length === 0) {
                const emptyState = document.createElement('div');
                emptyState.className = 'empty-state';
                emptyState.innerHTML = \`
                    <div class="empty-state-icon">🤖</div>
                    <div class="empty-state-title">Ollama Assistant</div>
                    <div class="empty-state-description">
                        Ask me anything about your code!<br>
                        I'll help you with explanations, debugging, and suggestions.
                    </div>
                \`;
                messagesContainer.appendChild(emptyState);
                return;
            }
            
            messages.forEach(message => {
                const messageElement = document.createElement('div');
                messageElement.className = \`message \${message.role}\`;
                
                let content = message.content;
                if (message.role === 'system') {
                    content = content.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
                } else {
                    content = content.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
                        .replace(/\`([^\`]+)\`/g, '<code>$1</code>');
                }
                
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
            if (!message || !isConnected) return;

            vscode.postMessage({
                type: 'sendMessage',
                message: message
            });

            messageInput.value = '';
            messageInput.style.height = 'auto';
        }

        sendButton.addEventListener('click', sendMessage);

        installButton.addEventListener('click', () => {
            vscode.postMessage({
                type: 'installOllama'
            });
        });

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
                    isConnected = message.isConnected;
                    renderMessages();
                    updateConnectionStatus();
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
        
        // Check connection status
        vscode.postMessage({ type: 'checkConnection' });
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