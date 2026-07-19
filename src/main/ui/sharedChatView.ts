import * as path from 'path';
import * as vscode from 'vscode';
import { AgentEditService, EditProposal } from '../agentEditService';
import { OllamaClient } from '../client';
import { CodeIndexStore } from '../codeIndex';
import { ConversationStore } from '../conversationStore';
import { DelegatedAgentProgress, MultiAgentService } from '../multiAgentService';
import { Settings } from '../settings';
import { scrubSensitiveContent } from '../security/secretScrubber';
import { TokenStore } from '../tokenStore';
import { getCurrentWorkspaceFolder } from '../workspaceContext';
import { runChatSlashCommand } from './chatCommands';
import { OllamaInstaller } from './ollamaInstaller';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

type LocalSlashResult =
  | { handled: false }
  | { handled: true; response: string };

type AgentRunView = Pick<DelegatedAgentProgress, 'id' | 'name' | 'status' | 'detail'>;

export class SharedChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _messages: ChatMessage[] = [];
  private _disposables: vscode.Disposable[] = [];
  private _isConnected = false;
  private _installationShown = false;
  private _isGenerating = false;
  private _pendingEdit: EditProposal | null = null;
  private _activeAgentRuns: AgentRunView[] = [];
  private _pathOverride: string | null = null;
  private _sessionId = '';
  private readonly _conversationReady: Promise<void>;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _client: OllamaClient,
    private readonly _settings: Settings,
    private readonly _codeIndex: CodeIndexStore,
    private readonly _editService: AgentEditService,
    private readonly _multiAgentService: MultiAgentService,
    private readonly _conversationStore: ConversationStore,
    private readonly _tokenStore: TokenStore
  ) {
    this._conversationReady = this._loadActiveConversation();
    void this._conversationReady.then(() => this._checkConnection());
    if (this._settings.autoIndexWorkspace) {
      void this._codeIndex.ensureIndexed();
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      async (data: { type?: string; message?: string }) => {
        switch (data.type) {
          case 'sendMessage':
            if (typeof data.message === 'string') {
              await this._handleSendMessage(data.message);
            }
            break;
          case 'clearChat':
            await this._clearChat();
            break;
          case 'getContext':
            this._sendContext();
            break;
          case 'checkConnection':
            await this._checkConnection();
            break;
          case 'installOllama':
            await this._showInstallationInstructions();
            break;
          case 'approvePendingEdit':
            await this._addSystemMessage(await this._approvePendingEdit());
            break;
          case 'rejectPendingEdit':
            this._rejectPendingEdit();
            await this._addSystemMessage('🗑️ Pending edit rejected.');
            break;
          case 'previewPendingEdit':
            await this._addSystemMessage(await this._previewPendingEdit());
            break;
        }
      },
      null,
      this._disposables
    );

    this._updateWebview();
  }

  public async clearChat(): Promise<void> {
    await this._clearChat();
  }

  public async reloadActiveSession(): Promise<void> {
    await this._conversationReady;
    await this._loadActiveConversation();
    this._updateWebview();
  }

  public dispose(): void {
    this._disposables.forEach(disposable => disposable.dispose());
  }

  private async _checkConnection(): Promise<void> {
    await this._conversationReady;

    try {
      this._isConnected = await this._client.isHealthy();

      if (!this._isConnected) {
        if (!this._installationShown) {
          this._installationShown = true;
          await this._showInstallationDialog();
        }
        const osInfo = OllamaInstaller.detectOS();
        await this._addSystemMessage(`⚠️ **Ollama not found on ${osInfo}**\n\nClick "Install Ollama" below for setup instructions.`);
      } else {
        this._installationShown = false;
        this._updateWebview();
      }
    } catch {
      this._isConnected = false;
      if (!this._installationShown) {
        this._installationShown = true;
        await this._showInstallationDialog();
      }
      const osInfo = OllamaInstaller.detectOS();
      await this._addSystemMessage(`❌ **Failed to connect to Ollama on ${osInfo}**\n\nThis usually means Ollama is not installed or not running.`);
    }
  }

  private async _showInstallationDialog(): Promise<void> {
    await OllamaInstaller.showInstallationDialog();
  }

  private async _showInstallationInstructions(): Promise<void> {
    const installInfo = OllamaInstaller.getInstallationInfo();
    await OllamaInstaller.showInstallationInstructions(installInfo);
  }

  private async _handleSendMessage(message: string): Promise<void> {
    await this._conversationReady;
    await this._loadActiveConversation();

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      return;
    }

    const knownTokenValues = await this._tokenStore.listTokenValues();
    const scrubbedInput = scrubSensitiveContent(trimmedMessage, knownTokenValues);

    const localSlashResult = await this._runLocalSlashCommand(trimmedMessage);
    if (localSlashResult.handled) {
      await this._addSystemMessage(localSlashResult.response);
      return;
    }

    try {
      const commandResponse = await runChatSlashCommand(trimmedMessage, this._client);
      if (commandResponse !== null) {
        await this._addSystemMessage(commandResponse);
        return;
      }
    } catch (error) {
      await this._addSystemMessage(this._formatErrorMessage(error));
      return;
    }

    if (!this._isConnected) {
      await this._checkConnection();
      if (!this._isConnected) {
        const osInfo = OllamaInstaller.detectOS();
        await this._addSystemMessage(`❌ **Cannot send message: Ollama is not connected**\n\nPlease install Ollama for ${osInfo} first.`);
        return;
      }
    }

    const tokenResolution = await this._tokenStore.resolvePlaceholders(scrubbedInput.text);

    if (tokenResolution.missingKeys.length) {
      await this._addSystemMessage(
        `⚠️ Missing token value for ${tokenResolution.missingKeys.map(key => `\`::${key}::\``).join(', ')}. Set them with \`/token <key> <value>\`.`
      );
    }

    await this._addMessage('user', scrubbedInput.text);
    this._setGenerating(true);

    try {
      const fullPrompt = await this._buildPrompt(tokenResolution.text);
      const response = await this._client.generate({
        prompt: fullPrompt,
        stream: true
      });

      const scrubbedResponse = scrubSensitiveContent(response, knownTokenValues);
      await this._addMessage('assistant', scrubbedResponse.text);
    } catch (error) {
      await this._addMessage('assistant', this._formatErrorMessage(error));
    } finally {
      this._setGenerating(false);
    }
  }

  private async _addSystemMessage(content: string): Promise<void> {
    await this._addMessage('system', content);
  }

  private async _addMessage(role: ChatMessage['role'], content: string): Promise<void> {
    if (!this._sessionId) {
      throw new Error('No active chat session is available.');
    }

    const stored = await this._conversationStore.appendMessage(this._sessionId, role, content);
    this._messages.push({
      id: stored.id,
      role: stored.role,
      content: stored.content,
      timestamp: stored.timestamp
    });
    this._updateWebview();
  }

  private async _loadActiveConversation(): Promise<void> {
    const activeConversation = await this._conversationStore.getActiveConversation();
    this._sessionId = activeConversation.sessionId;
    this._messages = activeConversation.messages.map(message => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp
    }));
  }

  private async _buildPrompt(trimmedMessage: string): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    const workspaceFolder = this._getCurrentWorkspaceFolder(editor?.document.uri);
    const workspaceRootPath = workspaceFolder?.uri.fsPath ?? '';
    const activeScopePath = this._getEffectiveScopePath(workspaceRootPath);
    const scopePrefix = this._toRelativeScopePrefix(workspaceRootPath, activeScopePath);
    let contextPrompt = trimmedMessage;

    if (editor) {
      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      if (selectedText) {
        contextPrompt = [
          'Based on this selected code:',
          `\`\`\`${editor.document.languageId}`,
          selectedText,
          '```',
          '',
          trimmedMessage
        ].join('\n');
      } else {
        const fileName = editor.document.fileName;
        const fileContent = editor.document.getText();
        if (fileContent.length < 5000) {
          contextPrompt = [
            `In the context of file ${fileName}:`,
            `\`\`\`${editor.document.languageId}`,
            fileContent,
            '```',
            '',
            trimmedMessage
          ].join('\n');
        }
      }
    }

    await this._codeIndex.ensureIndexed();

    const indexedQuery = scopePrefix ? `${trimmedMessage}\n${scopePrefix}` : trimmedMessage;
    const indexedContext = await this._codeIndex.buildPromptContext(indexedQuery, 4, scopePrefix);
    if (indexedContext) {
      contextPrompt = `${contextPrompt}\n\nRelevant indexed workspace snippets:\n${indexedContext}`;
    } else {
      const fallbackContext = await this._codeIndex.buildFallbackContext(4, scopePrefix);
      if (fallbackContext) {
        contextPrompt = `${contextPrompt}\n\nRecent files from the active workspace scope:\n${fallbackContext}`;
      }
    }

    const graphifyContext = await this._conversationStore.buildGraphifyPromptContext(trimmedMessage, 6);
    if (graphifyContext) {
      contextPrompt = `${contextPrompt}\n\n${graphifyContext}`;
    }

    const scopePrompt = this._buildScopePromptHeader(workspaceRootPath, activeScopePath);
    if (scopePrompt) {
      contextPrompt = `${scopePrompt}\n\n${contextPrompt}`;
    }

    const conversationHistory = this._messages
      .slice(-8)
      .filter(message => message.role !== 'system')
      .map(message => `${message.role}: ${message.content}`)
      .join('\n\n');

    return conversationHistory
      ? `Previous conversation:\n${conversationHistory}\n\nCurrent request: ${contextPrompt}`
      : contextPrompt;
  }

  private async _runLocalSlashCommand(input: string): Promise<LocalSlashResult> {
    if (!input.startsWith('/')) {
      return { handled: false };
    }

    const [commandToken, ...args] = input.slice(1).split(/\s+/);
    const command = commandToken.toLowerCase();
    const argument = args.join(' ').trim();

    switch (command) {
      case 'privacy':
        return {
          handled: true,
          response: this._settings.privacySummary()
        };
      case 'token':
        return this._handleTokenCommand(argument);
      case 'path':
        return this._handlePathCommand(argument);
      case 'index':
        if (argument.toLowerCase() === 'status') {
          return {
            handled: true,
            response: await this._indexStatusMessage()
          };
        }
        this._setGenerating(true);
        try {
          const result = await this._codeIndex.rebuild();
          return {
            handled: true,
            response: [
              '📚 **Workspace code index rebuilt**',
              '',
              `Indexed files: **${result.indexedFiles}**`,
              `Skipped files: **${result.skippedFiles}**`,
              `Generated: ${new Date(result.generatedAt).toLocaleTimeString()}`
            ].join('\n')
          };
        } finally {
          this._setGenerating(false);
        }
      case 'edit':
        if (!argument) {
          return {
            handled: true,
            response: '⚠️ Usage: `/edit <instruction>`'
          };
        }
        this._setGenerating(true);
        try {
          const proposal = await this._editService.createProposal(argument, vscode.window.activeTextEditor);
          this._pendingEdit = proposal;
          if (this._settings.autoApplyEdits) {
            const appliedFiles = await this._editService.applyProposal(proposal);
            this._pendingEdit = null;
            return {
              handled: true,
              response: await this._formatAppliedEditMessage(appliedFiles)
            };
          }

          const diffPreviewMessage = await this._openProposalDiffs(proposal);
          this._updateWebview();
          return {
            handled: true,
            response: [
              this._editService.formatProposalForChat(proposal),
              '',
              diffPreviewMessage,
              '',
              'Use **Apply pending edit** (or `/approve`) to write changes, or `/reject` to discard.'
            ].join('\n')
          };
        } catch (error) {
          return {
            handled: true,
            response: `❌ **Failed to prepare edit**: ${this._rawErrorMessage(error)}`
          };
        } finally {
          this._setGenerating(false);
        }
      case 'approve':
        return {
          handled: true,
          response: await this._approvePendingEdit()
        };
      case 'reject':
        this._rejectPendingEdit();
        return {
          handled: true,
          response: '🗑️ Pending edit rejected.'
        };
      case 'agents':
      case 'delegate':
        if (!argument) {
          return {
            handled: true,
            response: '⚠️ Usage: `/agents <goal>`'
          };
        }
        this._setGenerating(true);
        try {
          return {
            handled: true,
            response: await this._runDelegatedAgents(argument)
          };
        } finally {
          this._setGenerating(false);
          this._activeAgentRuns = [];
          this._updateWebview();
        }
      case 'sessions':
        return {
          handled: true,
          response: await this._sessionOverviewMessage()
        };
      case 'session':
        return this._handleSessionCommand(argument);
      case 'note':
        return this._handleNoteCommand(argument);
      case 'notes':
        return {
          handled: true,
          response: await this._sessionNotesMessage()
        };
      case 'graphify':
        return this._handleGraphifyCommand(argument);
      default:
        return { handled: false };
    }
  }

  private async _handleSessionCommand(argument: string): Promise<LocalSlashResult> {
    const normalized = argument.trim().toLowerCase();
    if (!normalized || normalized === 'current') {
      return {
        handled: true,
        response: await this._currentSessionMessage()
      };
    }

    if (normalized === 'new') {
      await this._clearChat();
      return {
        handled: true,
        response: `🆕 **Started new chat session**: \`${this._sessionId}\``
      };
    }

    if (normalized.startsWith('load ')) {
      const sessionId = argument.slice(5).trim();
      if (!sessionId) {
        return {
          handled: true,
          response: '⚠️ Usage: `/session load <session-id>`'
        };
      }

      const activated = await this._conversationStore.activateSession(sessionId);
      if (!activated) {
        return {
          handled: true,
          response: `⚠️ Session \`${sessionId}\` was not found. Run \`/sessions\` to list available sessions.`
        };
      }

      this._sessionId = activated.sessionId;
      this._messages = activated.messages.map(message => ({
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp
      }));
      this._pendingEdit = null;
      this._updateWebview();

      return {
        handled: true,
        response: `✅ Loaded session \`${sessionId}\` with ${activated.messages.length} message(s).`
      };
    }

    return {
      handled: true,
      response: '⚠️ Usage: `/session current`, `/session new`, or `/session load <session-id>`.'
    };
  }

  private async _handleNoteCommand(argument: string): Promise<LocalSlashResult> {
    const trimmed = argument.trim();
    if (!trimmed || trimmed.toLowerCase() === 'list') {
      return {
        handled: true,
        response: await this._sessionNotesMessage()
      };
    }

    if (!this._sessionId) {
      return {
        handled: true,
        response: '⚠️ No active session available for storing a note.'
      };
    }

    const note = await this._conversationStore.addNote(this._sessionId, trimmed);
    return {
      handled: true,
      response: `📝 Saved note \`${note.id}\` for session \`${note.sessionId}\`.`
    };
  }

  private async _handleTokenCommand(argument: string): Promise<LocalSlashResult> {
    try {
      const normalizedArgument = argument.trim();

      if (!normalizedArgument || normalizedArgument.toLowerCase() === 'list') {
        const keys = await this._tokenStore.listTokenKeys();
        const listedKeys = keys.length ? keys.map(key => `- \`${key}\``).join('\n') : '- No tokens stored yet.';
        return {
          handled: true,
          response: [
            '🔐 **Stored token keys**',
            '',
            listedKeys,
            '',
            'Use `/token <key> <value>` to save a token, `/token remove <key>` to delete one, and `::KEY::` placeholders in prompts.'
          ].join('\n')
        };
      }

      const deleteMatch = normalizedArgument.match(/^(?:remove|delete|unset)\s+([A-Za-z][A-Za-z0-9_]*)$/i);
      if (deleteMatch) {
        const removed = await this._tokenStore.deleteToken(deleteMatch[1]);
        return {
          handled: true,
          response: removed
            ? `🗑️ Removed token \`${deleteMatch[1].trim().toUpperCase()}\`.`
            : `⚠️ Token \`${deleteMatch[1].trim().toUpperCase()}\` was not found.`
        };
      }

      const setMatch = normalizedArgument.match(/^([A-Za-z][A-Za-z0-9_]*)\s+(.+)$/s);
      if (!setMatch) {
        return {
          handled: true,
          response: '⚠️ Usage: `/token <key> <value>`, `/token list`, or `/token remove <key>`.'
        };
      }

      const [, key, rawValue] = setMatch;
      const normalizedKey = await this._tokenStore.setToken(key, rawValue);

      return {
        handled: true,
        response: `✅ Stored token \`${normalizedKey}\` securely. Reference it in prompts with \`::${normalizedKey}::\`.`
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        handled: true,
        response: `❌ ${message}`
      };
    }
  }

  private async _handlePathCommand(argument: string): Promise<LocalSlashResult> {
    const workspaceFolder = this._getCurrentWorkspaceFolder();
    if (!workspaceFolder) {
      return {
        handled: true,
        response: '⚠️ No workspace folder is open. Open a project to use `/path`.'
      };
    }

    const workspaceRootPath = workspaceFolder.uri.fsPath;
    const normalizedWorkspaceRoot = path.resolve(workspaceRootPath);
    const normalizedArgument = argument.trim();

    if (!normalizedArgument) {
      const activeScopePath = this._getEffectiveScopePath(workspaceRootPath);
      const defaultScope = path.resolve(activeScopePath) === normalizedWorkspaceRoot;
      return {
        handled: true,
        response: [
          '📁 **Current path scope**',
          '',
          `Workspace root: \`${workspaceRootPath}\``,
          `Active scope: \`${activeScopePath}\`${defaultScope ? ' **(default)**' : ' **(/path override)**'}`,
          '',
          'Relative paths are resolved from the active scope unless you run `/path reset`.'
        ].join('\n')
      };
    }

    const resetTokens = new Set(['reset', 'clear', 'default']);
    if (resetTokens.has(normalizedArgument.toLowerCase())) {
      this._pathOverride = null;
      return {
        handled: true,
        response: `✅ Path scope reset to workspace root: \`${workspaceRootPath}\`.`
      };
    }

    const requestedPath = path.isAbsolute(normalizedArgument)
      ? path.resolve(normalizedArgument)
      : path.resolve(workspaceRootPath, normalizedArgument);

    if (!this._isSameOrChildPath(normalizedWorkspaceRoot, requestedPath)) {
      return {
        handled: true,
        response: `⚠️ Path must stay inside the current workspace root: \`${workspaceRootPath}\`.`
      };
    }

    try {
      const stats = await vscode.workspace.fs.stat(vscode.Uri.file(requestedPath));
      const scopedPath = (stats.type & vscode.FileType.Directory) !== 0
        ? requestedPath
        : path.dirname(requestedPath);

      this._pathOverride = scopedPath;

      return {
        handled: true,
        response: [
          `✅ Active path scope set to \`${scopedPath}\`.`,
          'All relative paths now resolve from this directory until `/path reset`.'
        ].join('\n')
      };
    } catch {
      return {
        handled: true,
        response: `⚠️ Path not found: \`${requestedPath}\`.`
      };
    }
  }

  private async _handleGraphifyCommand(argument: string): Promise<LocalSlashResult> {
    const normalized = argument.trim().toLowerCase();
    if (!normalized || normalized === 'import') {
      const graphifyFiles = await this._findGraphifyJsonFiles();
      if (!graphifyFiles.length) {
        const workspacePath = this._getCurrentWorkspaceFolder()?.uri.fsPath ?? 'current workspace';
        return {
          handled: true,
          response: `⚠️ No Graphify JSON files found under \`${workspacePath}\`. Expected files under \`<project>/graphify-out/*.json\`.`
        };
      }

      this._setGenerating(true);
      try {
        const summary = await this._conversationStore.importGraphifyFiles(graphifyFiles);
        return {
          handled: true,
          response: [
            '🕸️ **Graphify import completed**',
            '',
            `Workspace graph files imported: **${summary.filesImported}**`,
            `Nodes imported: **${summary.nodesImported}**`,
            `Edges imported: **${summary.edgesImported}**`,
            `Communities imported: **${summary.communitiesImported}**`
          ].join('\n')
        };
      } finally {
        this._setGenerating(false);
      }
    }

    if (normalized === 'status') {
      const status = await this._conversationStore.getGraphifyStatus();
      const lastImported = status.lastImportedAt > 0
        ? new Date(status.lastImportedAt).toLocaleString()
        : 'never';
      return {
        handled: true,
        response: [
          '🕸️ **Graphify context status**',
          '',
          `Sources: **${status.sources}**`,
          `Nodes: **${status.nodes}**`,
          `Edges: **${status.edges}**`,
          `Communities: **${status.communities}**`,
          `Last import: ${lastImported}`
        ].join('\n')
      };
    }

    return {
      handled: true,
      response: '⚠️ Usage: `/graphify import` or `/graphify status`.'
    };
  }

  private async _findGraphifyJsonFiles(): Promise<string[]> {
    const workspaceFolder = this._getCurrentWorkspaceFolder();
    if (!workspaceFolder) {
      return [];
    }

    const excludePattern = '**/{.git,node_modules,dist,build,out,target,coverage,.next}/**';
    const graphPattern = new vscode.RelativePattern(workspaceFolder, '**/graphify-out/graph.json');
    const jsonPattern = new vscode.RelativePattern(workspaceFolder, '**/graphify-out/*.json');
    const hiddenJsonPattern = new vscode.RelativePattern(workspaceFolder, '**/graphify-out/.*.json');

    const [graphFiles, jsonFiles, hiddenJsonFiles] = await Promise.all([
      vscode.workspace.findFiles(graphPattern, excludePattern, 100),
      vscode.workspace.findFiles(jsonPattern, excludePattern, 400),
      vscode.workspace.findFiles(hiddenJsonPattern, excludePattern, 400)
    ]);

    const filePaths = [...graphFiles, ...jsonFiles, ...hiddenJsonFiles]
      .filter(file => file.scheme === 'file')
      .map(file => file.fsPath);

    return Array.from(new Set(filePaths));
  }

  private async _indexStatusMessage(): Promise<string> {
    const status = await this._codeIndex.getStatus();
    if (!status.exists) {
      return '📚 **Code index:** not built yet. Run `/index` to build it.';
    }

    return [
      '📚 **Code index status**',
      '',
      `Enabled: **${status.enabled ? 'yes' : 'no'}**`,
      `Indexed files: **${status.fileCount}**`,
      `Last build: ${new Date(status.generatedAt).toLocaleString()}`
    ].join('\n');
  }

  private async _approvePendingEdit(): Promise<string> {
    const proposal = this._pendingEdit;
    if (!proposal) {
      return '⚠️ No pending edit found. Run `/edit <instruction>` first.';
    }

    this._setGenerating(true);
    try {
      const appliedFiles = await this._editService.applyProposal(proposal);
      this._pendingEdit = null;
      return await this._formatAppliedEditMessage(appliedFiles);
    } catch (error) {
      return `❌ **Failed to apply edit**: ${this._formatErrorMessage(error)}`;
    } finally {
      this._setGenerating(false);
      this._updateWebview();
    }
  }

  private _rejectPendingEdit(): void {
    this._pendingEdit = null;
    this._updateWebview();
  }

  private async _previewPendingEdit(): Promise<string> {
    const proposal = this._pendingEdit;
    if (!proposal) {
      return '⚠️ No pending edit found. Run `/edit <instruction>` first.';
    }
    return this._openProposalDiffs(proposal);
  }

  private async _formatAppliedEditMessage(files: string[]): Promise<string> {
    const listedFiles = files.map(file => `- \`${file}\``).join('\n');
    const lines = [
      `✅ **Applied edits to ${files.length} file(s)**`,
      '',
      listedFiles
    ];

    try {
      await this._editService.revealAppliedFiles(files);
      lines.push('', 'Opened each edited file in the IDE editor.');
    } catch (error) {
      lines.push('', `⚠️ Applied edits, but could not open files in the editor: ${this._rawErrorMessage(error)}`);
    }

    return lines.join('\n');
  }

  private async _openProposalDiffs(proposal: EditProposal): Promise<string> {
    try {
      await this._editService.showProposalDiffs(proposal);
      return 'Opened in-editor diff previews for each proposed file.';
    } catch (error) {
      return `⚠️ Proposed edits were generated, but diff preview could not open: ${this._rawErrorMessage(error)}`;
    }
  }

  private async _runDelegatedAgents(goal: string): Promise<string> {
    try {
      const result = await this._multiAgentService.runDelegatedTask(goal, agents => {
        this._activeAgentRuns = agents.map(agent => ({
          id: agent.id,
          name: agent.name,
          status: agent.status,
          detail: agent.detail
        }));
        this._updateWebview();
      });

      const agentLines = result.agents.map(agent => {
        const statusIcon = agent.status === 'completed' ? '✅' : agent.status === 'failed' ? '❌' : '⏳';
        const detailSuffix = agent.detail ? ` — ${agent.detail}` : '';
        return `- ${statusIcon} **${agent.name}**${detailSuffix}`;
      });

      return [
        `🤝 **Delegated multi-agent run completed**`,
        '',
        `Goal: ${goal}`,
        '',
        'Agents:',
        ...agentLines,
        '',
        'Synthesis:',
        result.synthesis
      ].join('\n');
    } catch (error) {
      return `❌ **Delegated multi-agent run failed**: ${this._rawErrorMessage(error)}`;
    }
  }

  private _buildScopePromptHeader(workspaceRootPath: string, activeScopePath: string): string {
    if (!workspaceRootPath) {
      return '';
    }

    const isDefaultScope = path.resolve(workspaceRootPath) === path.resolve(activeScopePath);
    return [
      'Filesystem scope for this request:',
      `- Workspace root: \`${workspaceRootPath}\``,
      `- Active scope: \`${activeScopePath}\`${isDefaultScope ? ' (default)' : ' (/path override)'}`,
      '- Resolve all relative paths from the active scope unless the user changes it with `/path`.'
    ].join('\n');
  }

  private _getCurrentWorkspaceFolder(preferredUri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return getCurrentWorkspaceFolder(preferredUri);
  }

  private _getEffectiveScopePath(workspaceRootPath: string): string {
    if (!workspaceRootPath) {
      return '';
    }

    const normalizedRoot = path.resolve(workspaceRootPath);
    if (!this._pathOverride) {
      return normalizedRoot;
    }

    const normalizedOverride = path.resolve(this._pathOverride);
    if (!this._isSameOrChildPath(normalizedRoot, normalizedOverride)) {
      this._pathOverride = null;
      return normalizedRoot;
    }

    return normalizedOverride;
  }

  private _toRelativeScopePrefix(workspaceRootPath: string, activeScopePath: string): string {
    if (!workspaceRootPath || !activeScopePath) {
      return '';
    }

    const relative = path.relative(workspaceRootPath, activeScopePath).replace(/\\/g, '/');
    if (!relative || relative === '.') {
      return '';
    }

    return relative.startsWith('../') ? '' : relative;
  }

  private _isSameOrChildPath(parentPath: string, candidatePath: string): boolean {
    const relative = path.relative(parentPath, candidatePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private _rawErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private _formatErrorMessage(error: unknown): string {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const osInfo = OllamaInstaller.detectOS();

    if (errorMessage.includes('Network kill switch blocked host')) {
      return `🛡️ ${errorMessage} You can update allowed hosts in \`olliberty.privacy.allowedHosts\`.`;
    }

    if (errorMessage.includes('Failed to connect') || errorMessage.includes('ECONNREFUSED')) {
      return `❌ **Connection Failed on ${osInfo}**: Ollama server is not running.`;
    }

    if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
      return `⏱️ **Request Timeout on ${osInfo}**: Ollama server is not responding.`;
    }

    if (errorMessage.includes('model') && errorMessage.includes('not found')) {
      return '🔍 **Model Not Found**: run `/models` to list available local models, then `/model <name>`.';
    }

    if (errorMessage.includes('HTTP 500')) {
      return '⚠️ **Server Error**: Ollama returned an internal error. Please restart Ollama.';
    }

    return `❌ **Error**: ${errorMessage}`;
  }

  private async _clearChat(): Promise<void> {
    await this._conversationReady;
    const nextSession = await this._conversationStore.startNewSession();
    this._sessionId = nextSession.sessionId;
    this._messages = nextSession.messages.map(message => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp
    }));
    this._pendingEdit = null;
    this._activeAgentRuns = [];
    this._updateWebview();
    void this._checkConnection();
  }

  private async _sessionOverviewMessage(): Promise<string> {
    const overview = await this._conversationStore.getOverview();
    const lines = overview.sessions.map(session => {
      const marker = session.isActive ? ' **(active)**' : '';
      return [
        `- \`${session.id}\`${marker}`,
        `messages: ${session.messageCount}`,
        `notes: ${session.noteCount}`,
        `updated: ${new Date(session.lastMessageAt).toLocaleString()}`
      ].join(' | ');
    });

    return [
      '🗂️ **Conversation sessions**',
      '',
      `Active session: \`${overview.activeSessionId}\``,
      `Total sessions: **${overview.totalSessions}**`,
      '',
      ...(lines.length ? lines : ['- No sessions found.'])
    ].join('\n');
  }

  private async _currentSessionMessage(): Promise<string> {
    const overview = await this._conversationStore.getOverview(1);
    const currentSession = overview.sessions.find(session => session.id === overview.activeSessionId);

    if (!currentSession) {
      return `💬 Active session: \`${overview.activeSessionId}\``;
    }

    return [
      `💬 **Active session:** \`${currentSession.id}\``,
      `Messages: **${currentSession.messageCount}**`,
      `Notes: **${currentSession.noteCount}**`,
      `Created: ${new Date(currentSession.createdAt).toLocaleString()}`,
      `Last update: ${new Date(currentSession.lastMessageAt).toLocaleString()}`
    ].join('\n');
  }

  private async _sessionNotesMessage(): Promise<string> {
    if (!this._sessionId) {
      return '⚠️ No active session available for notes.';
    }

    const notes = await this._conversationStore.listNotes(this._sessionId, 50);
    if (!notes.length) {
      return [
        `📝 **Session notes** for \`${this._sessionId}\``,
        '',
        'No notes yet. Use `/note <text>` to store one.'
      ].join('\n');
    }

    const lines = notes.map((note, index) => {
      const normalizedContent = note.content.trim();
      return [
        `#### ${index + 1}. ${new Date(note.createdAt).toLocaleString()}`,
        normalizedContent
      ].join('\n');
    });

    return [
      `📝 **Session notes** for \`${this._sessionId}\` (${notes.length})`,
      '',
      ...lines
    ].join('\n');
  }

  private _sendContext(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this._view) {
      return;
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);
    this._view.webview.postMessage({
      type: 'context',
      data: {
        fileName: editor.document.fileName,
        languageId: editor.document.languageId,
        selectedText,
        hasSelection: !selection.isEmpty
      }
    });
  }

  private _setGenerating(isGenerating: boolean): void {
    this._isGenerating = isGenerating;
    this._updateWebview();
  }

  private _updateWebview(): void {
    if (!this._view) {
      return;
    }

    this._view.webview.postMessage({
      type: 'updateMessages',
      messages: this._messages,
      isConnected: this._isConnected,
      isGenerating: this._isGenerating,
      agentRuns: this._activeAgentRuns,
      pendingEdit: this._pendingEdit
        ? {
            summary: this._pendingEdit.summary,
            fileCount: this._pendingEdit.edits.length,
            files: this._pendingEdit.edits.map(edit => edit.filePath)
          }
        : null
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css')
    );
    const nonce = this._getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <link href="${styleUri}" rel="stylesheet">
    <title>Olliberty Chat</title>
</head>
<body>
    <div id="chat-container">
        <div id="connection-status"></div>
        <div id="agent-runs-container" style="display: none;">
            <div id="agent-runs-title">🤝 Agents running</div>
            <div id="agent-runs-list"></div>
        </div>
        <div id="messages-container"></div>
        <div id="input-container">
            <div id="context-info"></div>
            <div id="install-button-container" style="display: none;">
                <button id="install-button" class="install-btn">📥 Install Ollama</button>
            </div>
            <div id="pending-edit-container" style="display: none;">
                <div id="pending-edit-summary"></div>
                <div class="pending-edit-actions">
                    <button id="preview-edit-button" class="pending-edit-btn">👀 Preview diff</button>
                    <button id="approve-edit-button" class="pending-edit-btn approve">✅ Apply pending edit</button>
                    <button id="reject-edit-button" class="pending-edit-btn reject">✖ Reject</button>
                </div>
            </div>
            <div class="input-row">
                <textarea id="message-input" placeholder="Ask Ollama..." rows="1"></textarea>
                <button id="send-button" aria-label="Send" title="Send">↑</button>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let messages = [];
        let isConnected = false;
        let isGenerating = false;
        let pendingEdit = null;
        let agentRuns = [];

        const messagesContainer = document.getElementById('messages-container');
        const messageInput = document.getElementById('message-input');
        const sendButton = document.getElementById('send-button');
        const contextInfo = document.getElementById('context-info');
        const connectionStatus = document.getElementById('connection-status');
        const agentRunsContainer = document.getElementById('agent-runs-container');
        const agentRunsList = document.getElementById('agent-runs-list');
        const installButtonContainer = document.getElementById('install-button-container');
        const installButton = document.getElementById('install-button');
        const pendingEditContainer = document.getElementById('pending-edit-container');
        const pendingEditSummary = document.getElementById('pending-edit-summary');
        const previewEditButton = document.getElementById('preview-edit-button');
        const approveEditButton = document.getElementById('approve-edit-button');
        const rejectEditButton = document.getElementById('reject-edit-button');

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function updateConnectionStatus() {
            if (!isConnected) {
                connectionStatus.innerHTML = '<div class="connection-error">⚠️ Ollama not connected</div>';
                installButtonContainer.style.display = 'block';
            } else if (isGenerating) {
                connectionStatus.innerHTML = '<div class="connection-success">⏳ Olliberty is thinking…</div>';
                installButtonContainer.style.display = 'none';
            } else {
                connectionStatus.innerHTML = '<div class="connection-success">✅ Ollama connected</div>';
                installButtonContainer.style.display = 'none';
            }
        }

        function updateComposerState() {
            const disabled = !isConnected || isGenerating;
            messageInput.disabled = disabled;
            sendButton.disabled = disabled;
            sendButton.textContent = isGenerating ? '…' : '↑';
            messageInput.placeholder = !isConnected
                ? 'Install Ollama to continue...'
                : isGenerating
                    ? 'Generating response...'
                    : 'Ask Ollama...';
        }

        function updatePendingEditState() {
            if (!pendingEdit) {
                pendingEditContainer.style.display = 'none';
                pendingEditSummary.textContent = '';
                return;
            }

            pendingEditContainer.style.display = 'block';
            const files = Array.isArray(pendingEdit.files) ? pendingEdit.files : [];
            const fileList = files.slice(0, 4).join(', ');
            const suffix = files.length > 4 ? '…' : '';
            pendingEditSummary.textContent = pendingEdit.summary + ' (' + pendingEdit.fileCount + ' file(s): ' + fileList + suffix + ')';
        }

        function renderAgentRuns() {
            if (!Array.isArray(agentRuns) || agentRuns.length === 0) {
                agentRunsContainer.style.display = 'none';
                agentRunsList.innerHTML = '';
                return;
            }

            agentRunsContainer.style.display = 'block';
            agentRunsList.innerHTML = agentRuns.map(agent => {
                const statusClass = 'agent-status-' + (agent.status || 'queued');
                const statusIcon = agent.status === 'completed'
                    ? '✅'
                    : agent.status === 'failed'
                        ? '❌'
                        : agent.status === 'running'
                            ? '⏳'
                            : '🕓';
                const detail = agent.detail ? '<span class="agent-detail">' + escapeHtml(agent.detail) + '</span>' : '';

                return [
                    '<div class="agent-run-item">',
                    '<div class="agent-run-name">' + statusIcon + ' ' + escapeHtml(agent.name || 'Agent') + '</div>',
                    '<div class="agent-run-status ' + statusClass + '">' + escapeHtml(agent.status || 'queued') + '</div>',
                    detail,
                    '</div>'
                ].join('');
            }).join('');
        }

        function renderMessages() {
            messagesContainer.innerHTML = '';

            if (messages.length === 0) {
                const emptyState = document.createElement('div');
                emptyState.className = 'empty-state';
                emptyState.innerHTML = \`
                    <div class="empty-state-icon">🤖</div>
                    <div class="empty-state-title">Olliberty</div>
                    <div class="empty-state-description">
                        Ask me anything about your code.<br>
                        Use /edit for local diffs and /agents for delegated parallel analysis.
                    </div>
                \`;
                messagesContainer.appendChild(emptyState);
                return;
            }

            messages.forEach(message => {
                const messageElement = document.createElement('div');
                messageElement.className = \`message \${message.role}\`;

                let content = escapeHtml(message.content);
                if (message.role === 'system') {
                    content = content.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
                } else {
                    content = content
                        .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
                        .replace(/\`([^\`]+)\`/g, '<code>$1</code>');
                }

                const avatarIcon = message.role === 'assistant' ? '🤖' : message.role === 'user' ? '🧑' : 'ℹ️';
                messageElement.innerHTML = \`
                    <div class="message-header">
                        <span class="avatar">\${avatarIcon}</span>
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
            if (!message || !isConnected || isGenerating) {
                return;
            }

            vscode.postMessage({
                type: 'sendMessage',
                message
            });

            messageInput.value = '';
            messageInput.style.height = 'auto';
        }

        sendButton.addEventListener('click', sendMessage);

        installButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'installOllama' });
        });

        previewEditButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'previewPendingEdit' });
        });

        approveEditButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'approvePendingEdit' });
        });

        rejectEditButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'rejectPendingEdit' });
        });

        messageInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });

        messageInput.addEventListener('input', function onInput() {
            this.style.height = 'auto';
            this.style.height = this.scrollHeight + 'px';
        });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'updateMessages':
                    messages = message.messages;
                    isConnected = message.isConnected;
                    isGenerating = Boolean(message.isGenerating);
                    agentRuns = Array.isArray(message.agentRuns) ? message.agentRuns : [];
                    pendingEdit = message.pendingEdit ?? null;
                    renderMessages();
                    renderAgentRuns();
                    updateConnectionStatus();
                    updateComposerState();
                    updatePendingEditState();
                    break;
                case 'context': {
                    const ctx = message.data;
                    contextInfo.textContent = ctx.hasSelection
                        ? '📄 ' + ctx.fileName + ' (selection)'
                        : '📄 ' + ctx.fileName;
                    break;
                }
            }
        });

        vscode.postMessage({ type: 'getContext' });
        vscode.postMessage({ type: 'checkConnection' });
    </script>
</body>
</html>`;
  }

  private _getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i += 1) {
      nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
  }
}
