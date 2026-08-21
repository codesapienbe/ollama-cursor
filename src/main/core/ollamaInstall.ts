// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Host-agnostic Ollama installation guidance.
 *  Pure OS detection and instruction text so the IDE plugin can show it in a
 *  modal and the CLI can print it in the terminal from one source of truth. */

import * as os from 'os';

export interface InstallationInfo {
  os: string;
  title: string;
  description: string;
  commands: string[];
  downloadUrl: string;
  additionalNotes?: string;
}

export function detectOS(): string {
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

export function getInstallationInfo(): InstallationInfo {
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
          '# Start the Ollama LLM server:',
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
          '# Start the Ollama LLM server:',
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
          '# Start the Ollama LLM server:',
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
          '# Start the Ollama LLM server:',
          'ollama serve'
        ],
        downloadUrl: 'https://ollama.com/download'
      };
  }
}
