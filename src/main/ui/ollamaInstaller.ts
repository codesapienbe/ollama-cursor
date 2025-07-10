/*  Ollama Installation Helper
 *  - Detects user's operating system
 *  - Provides OS-specific installation instructions
 *  - Handles CLI commands and download links
 *  - Offers automated installation options where possible */

import * as vscode from 'vscode';
import * as os from 'os';

export interface InstallationInfo {
  os: string;
  title: string;
  description: string;
  commands: string[];
  downloadUrl: string;
  additionalNotes?: string;
}

export class OllamaInstaller {
  
  static detectOS(): string {
    const platform = os.platform();
    const arch = os.arch();
    
    switch (platform) {
      case 'win32':
        return 'Windows';
      case 'darwin':
        return 'macOS';
      case 'linux':
        return `Linux (${arch})`;
      default:
        return `${platform} (${arch})`;
    }
  }

  static getInstallationInfo(): InstallationInfo {
    const platform = os.platform();
    
    switch (platform) {
      case 'win32':
        return {
          os: 'Windows',
          title: 'Install Ollama on Windows',
          description: 'Download and install Ollama for Windows',
          commands: [
            '# Download from official website and run installer',
            '# Or use Windows Package Manager:',
            'winget install Ollama.Ollama',
            '',
            '# After installation, verify:',
            'ollama --version',
            '',
            '# Start Ollama service:',
            'ollama serve'
          ],
          downloadUrl: 'https://ollama.com/download/windows',
          additionalNotes: 'After installation, Ollama will run as a Windows service. You can also start it manually using "ollama serve" in Command Prompt or PowerShell.'
        };

      case 'darwin':
        return {
          os: 'macOS',
          title: 'Install Ollama on macOS',
          description: 'Install Ollama using Homebrew or direct download',
          commands: [
            '# Option 1: Using Homebrew (recommended)',
            'brew install ollama',
            '',
            '# Option 2: Direct download from website',
            '# Download .dmg file and install manually',
            '',
            '# After installation, verify:',
            'ollama --version',
            '',
            '# Start Ollama service:',
            'ollama serve'
          ],
          downloadUrl: 'https://ollama.com/download/mac',
          additionalNotes: 'Homebrew installation is recommended for easier updates. After installation, you can start Ollama using "ollama serve" in Terminal.'
        };

      case 'linux':
        const arch = os.arch();
        return {
          os: `Linux (${arch})`,
          title: 'Install Ollama on Linux',
          description: 'Install Ollama using the official installation script',
          commands: [
            '# Option 1: Official installation script (recommended)',
            'curl -fsSL https://ollama.com/install.sh | sh',
            '',
            '# Option 2: Manual installation',
            '# Download binary from GitHub releases',
            'wget https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64',
            'chmod +x ollama-linux-amd64',
            'sudo mv ollama-linux-amd64 /usr/local/bin/ollama',
            '',
            '# After installation, verify:',
            'ollama --version',
            '',
            '# Start Ollama service:',
            'ollama serve',
            '',
            '# Or run as system service:',
            'sudo systemctl enable ollama',
            'sudo systemctl start ollama'
          ],
          downloadUrl: 'https://ollama.com/download/linux',
          additionalNotes: 'For Linux, you can also set up Ollama as a systemd service for automatic startup. Make sure to install required dependencies like CUDA drivers for GPU support.'
        };

      default:
        return {
          os: platform,
          title: 'Install Ollama',
          description: 'Visit the official Ollama website for installation instructions',
          commands: [
            '# Visit the official website for your platform:',
            '# https://ollama.com/download',
            '',
            '# After installation, verify:',
            'ollama --version',
            '',
            '# Start Ollama service:',
            'ollama serve'
          ],
          downloadUrl: 'https://ollama.com/download'
        };
    }
  }

  static async showInstallationDialog(): Promise<void> {
    const installInfo = this.getInstallationInfo();
    
    const action = await vscode.window.showErrorMessage(
      `Ollama Not Found on ${installInfo.os}`,
      {
        modal: true,
        detail: `Ollama is not installed or not running on your system. Would you like to see installation instructions for ${installInfo.os}?`
      },
      'Show Installation Instructions',
      'Open Download Page',
      'Cancel'
    );

    switch (action) {
      case 'Show Installation Instructions':
        await this.showInstallationInstructions(installInfo);
        break;
      case 'Open Download Page':
        await vscode.env.openExternal(vscode.Uri.parse(installInfo.downloadUrl));
        break;
    }
  }

  static async showInstallationInstructions(installInfo: InstallationInfo): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      'ollamaInstallation',
      installInfo.title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = this.getInstallationHtml(installInfo);

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'openDownload':
            await vscode.env.openExternal(vscode.Uri.parse(installInfo.downloadUrl));
            break;
          case 'copyCommand':
            await vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage('Command copied to clipboard!');
            break;
          case 'closePanel':
            panel.dispose();
            break;
        }
      },
      undefined,
      []
    );
  }

  private static getInstallationHtml(installInfo: InstallationInfo): string {
    const commands = installInfo.commands.join('\n');
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${installInfo.title}</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            line-height: 1.6;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            margin: 0;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
        }
        .header {
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 20px;
            margin-bottom: 30px;
        }
        .header h1 {
            margin: 0;
            color: var(--vscode-textLink-foreground);
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .os-badge {
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.8em;
            font-weight: normal;
        }
        .description {
            margin: 15px 0;
            opacity: 0.9;
        }
        .section {
            margin: 30px 0;
        }
        .section h2 {
            color: var(--vscode-textLink-foreground);
            margin-bottom: 15px;
            border-left: 3px solid var(--vscode-textLink-foreground);
            padding-left: 12px;
        }
        .code-block {
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 20px;
            margin: 15px 0;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
            position: relative;
            overflow-x: auto;
        }
        .code-block pre {
            margin: 0;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .copy-button {
            position: absolute;
            top: 10px;
            right: 10px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 0.8em;
            transition: background-color 0.2s;
        }
        .copy-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .action-buttons {
            display: flex;
            gap: 12px;
            margin: 30px 0;
            flex-wrap: wrap;
        }
        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
            font-weight: 500;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s;
        }
        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .notes {
            background-color: var(--vscode-textCodeBlock-background);
            border-left: 4px solid var(--vscode-textLink-foreground);
            padding: 15px;
            margin: 20px 0;
            border-radius: 0 4px 4px 0;
        }
        .notes strong {
            color: var(--vscode-textLink-foreground);
        }
        .icon {
            font-size: 1.2em;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>
                <span class="icon">🤖</span>
                ${installInfo.title}
                <span class="os-badge">${installInfo.os}</span>
            </h1>
            <div class="description">${installInfo.description}</div>
        </div>

        <div class="action-buttons">
            <button class="btn btn-primary" onclick="openDownload()">
                <span>📥</span> Download Ollama
            </button>
            <button class="btn btn-secondary" onclick="copyAllCommands()">
                <span>📋</span> Copy All Commands
            </button>
        </div>

        <div class="section">
            <h2>Installation Commands</h2>
            <div class="code-block">
                <button class="copy-button" onclick="copyAllCommands()">Copy All</button>
                <pre>${commands}</pre>
            </div>
        </div>

        ${installInfo.additionalNotes ? `
        <div class="section">
            <h2>Additional Notes</h2>
            <div class="notes">
                <strong>💡 Tip:</strong> ${installInfo.additionalNotes}
            </div>
        </div>
        ` : ''}

        <div class="section">
            <h2>After Installation</h2>
            <div class="code-block">
                <button class="copy-button" onclick="copyCommand('ollama serve')">Copy</button>
                <pre># Start Ollama service
ollama serve

# Download a model (example)
ollama pull codellama

# Verify installation
ollama list</pre>
            </div>
        </div>

        <div class="action-buttons">
            <button class="btn btn-secondary" onclick="closePanel()">
                <span>✕</span> Close
            </button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function openDownload() {
            vscode.postMessage({
                command: 'openDownload'
            });
        }

        function copyCommand(text) {
            vscode.postMessage({
                command: 'copyCommand',
                text: text
            });
        }

        function copyAllCommands() {
            const commands = \`${commands}\`;
            vscode.postMessage({
                command: 'copyCommand',
                text: commands
            });
        }

        function closePanel() {
            vscode.postMessage({
                command: 'closePanel'
            });
        }
    </script>
</body>
</html>`;
  }

  static async quickInstallCheck(): Promise<boolean> {
    const installInfo = this.getInstallationInfo();
    
    const action = await vscode.window.showWarningMessage(
      `Ollama not found on ${installInfo.os}`,
      {
        detail: 'Would you like to see installation instructions?'
      },
      'Install Instructions',
      'Download',
      'Ignore'
    );

    switch (action) {
      case 'Install Instructions':
        await this.showInstallationInstructions(installInfo);
        return false;
      case 'Download':
        await vscode.env.openExternal(vscode.Uri.parse(installInfo.downloadUrl));
        return false;
      default:
        return false;
    }
  }
} 