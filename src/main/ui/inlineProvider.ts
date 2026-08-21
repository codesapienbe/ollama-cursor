// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  UI: InlineCompletionProvider
 *  - Provides auto-completion suggestions in real-time
 *  - Integrates with VS Code's built-in IntelliSense
 *  - Handles context-aware code completion using Ollama     */

import * as vscode from 'vscode';
import { OllamaClient } from '../client';
import { OllamaInstaller } from './ollamaInstaller';

export class InlineProvider implements vscode.InlineCompletionItemProvider {
  private statusBarItem: vscode.StatusBarItem;
  private hasShownInstallationDialog = false;

  constructor(private readonly client: OllamaClient) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.text = "$(loading~spin) Ollama";
    this.statusBarItem.tooltip = "Ollama Status";
    this.statusBarItem.show();

    this.checkConnection();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
    // Check connection first
    try {
      const isHealthy = await this.client.isHealthy();
      if (!isHealthy) {
        await this._showInstallationIfNeeded();
        return null;
      }
    } catch (error) {
      await this._showInstallationIfNeeded();
      return null;
    }

    const line = document.lineAt(position.line);
    const textBeforeCursor = document.getText(new vscode.Range(0, 0, position.line, position.character));
    const currentLine = line.text;
    
    // Only provide completions if we have some context
    if (textBeforeCursor.trim().length < 3) {
      return null;
    }

    try {
      const prompt = `Complete this code:\n\n${textBeforeCursor}`;
      
      // Create an AbortController for the cancellation token
      const abortController = new AbortController();
      token.onCancellationRequested(() => abortController.abort());
      
      const completion = await this.client.generate({ 
        prompt, 
        stream: false 
      }, abortController.signal);
      
      // Extract only the new part (not the original text)
      const newContent = completion.replace(textBeforeCursor, '').trim();
      
      if (newContent && newContent.length > 0) {
        return [
          new vscode.InlineCompletionItem(
            newContent,
            new vscode.Range(position, position)
          )
        ];
      }
    } catch (error) {
      if (!token.isCancellationRequested) {
        await this._showInstallationIfNeeded();
      }
    }

    return null;
  }

  private async checkConnection(): Promise<void> {
    try {
      const isHealthy = await this.client.isHealthy();
      if (isHealthy) {
        this.statusBarItem.text = "$(check) Ollama Connected";
        this.statusBarItem.color = undefined;
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.tooltip = "Ollama is connected and ready";
        this.hasShownInstallationDialog = false;
      } else {
        const osInfo = OllamaInstaller.detectOS();
        this.statusBarItem.text = `$(warning) Ollama Not Found (${osInfo})`;
        this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.statusBarItem.tooltip = `Ollama is not installed on ${osInfo}. Click to install.`;
        this.statusBarItem.command = 'olliberty.showInstallationInstructions';
        
        if (!this.hasShownInstallationDialog) {
          this.hasShownInstallationDialog = true;
          await this._showInstallationDialog();
        }
      }
    } catch (error) {
      const osInfo = OllamaInstaller.detectOS();
      this.statusBarItem.text = `$(error) Ollama Error (${osInfo})`;
      this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.statusBarItem.tooltip = `Failed to connect to Ollama on ${osInfo}. Click to install.`;
      this.statusBarItem.command = 'olliberty.showInstallationInstructions';
      
      if (!this.hasShownInstallationDialog) {
        this.hasShownInstallationDialog = true;
        await this._showInstallationDialog();
      }
    }
  }

  private async _showInstallationIfNeeded(): Promise<void> {
    if (!this.hasShownInstallationDialog) {
      this.hasShownInstallationDialog = true;
      await this._showInstallationDialog();
    }
  }

  private async _showInstallationDialog(): Promise<void> {
    const osInfo = OllamaInstaller.detectOS();
    
    const action = await vscode.window.showWarningMessage(
      `Ollama Not Available on ${osInfo}`,
      {
        detail: `Ollama is not installed or not running. Code completion will not work until Ollama is installed.`
      },
      'Install Ollama',
      'Show Instructions',
      'Ignore'
    );

    switch (action) {
      case 'Install Ollama':
        const downloadInfo = OllamaInstaller.getInstallationInfo();
        await vscode.env.openExternal(vscode.Uri.parse(downloadInfo.downloadUrl));
        break;
      case 'Show Instructions':
        const installInfo = OllamaInstaller.getInstallationInfo();
        await OllamaInstaller.showInstallationInstructions(installInfo);
        break;
    }
  }

  public dispose(): void {
    this.statusBarItem.dispose();
  }
}
