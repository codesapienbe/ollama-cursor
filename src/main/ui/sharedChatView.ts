// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from 'path';
import * as vscode from 'vscode';
import { ActivityReporter, ActivityStep } from '../activity';
import { AgentEditService, AppliedChange, EditProposal } from '../agentEditService';
import { OllamaClient, isAbortedError } from '../client';
import { CodeIndexStore } from '../codeIndex';
import { ConversationStore } from '../conversationStore';
import { DelegatedAgentProgress, MultiAgentService } from '../multiAgentService';
import { Plan, PlanService } from '../planService';
import { AgentMode, Settings, isAgentMode } from '../settings';
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

/* Streaming fires per token; repainting the whole view that often is wasteful.
   Coalescing on a trailing timer keeps the final state authoritative. */
const WEBVIEW_UPDATE_INTERVAL_MS = 60;

export class SharedChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _messages: ChatMessage[] = [];
  private _disposables: vscode.Disposable[] = [];
  private _isConnected = false;
  private _installationShown = false;
  private _isGenerating = false;
  private _pendingEdit: EditProposal | null = null;
  private _pendingPlan: Plan | null = null;
  private _activeAgentRuns: AgentRunView[] = [];
  private _activitySteps: ActivityStep[] = [];
  private _streamingContent = '';
  private _isStreaming = false;
  private _pathOverride: string | null = null;
  private _sessionId = '';
  private _lastWebviewPost = 0;
  private _webviewTimer: ReturnType<typeof setTimeout> | undefined;
  private _activeRun: AbortController | null = null;
  private readonly _conversationReady: Promise<void>;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _client: OllamaClient,
    private readonly _settings: Settings,
    private readonly _codeIndex: CodeIndexStore,
    private readonly _editService: AgentEditService,
    private readonly _multiAgentService: MultiAgentService,
    private readonly _conversationStore: ConversationStore,
    private readonly _tokenStore: TokenStore,
    private readonly _activity: ActivityReporter,
    private readonly _planService: PlanService
  ) {
    this._disposables.push(
      this._activity.onDidChange(steps => {
        this._activitySteps = steps;
        this._updateWebview();
      })
    );
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
      async (data: { type?: string; message?: string; filePath?: string; mode?: string }) => {
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
          case 'approvePlan':
            await this._approvePendingPlan();
            break;
          case 'rejectPlan':
            this._pendingPlan = null;
            this._updateWebview();
            await this._addSystemMessage('🗑️ Plan discarded. Nothing was executed.');
            break;
          case 'openChangeDiff':
            if (typeof data.filePath === 'string') {
              await this._openAppliedChangeDiff(data.filePath);
            }
            break;
          case 'showActivityLog':
            this._activity.showOutput();
            break;
          case 'stopGeneration':
            if (!(await this.stopGeneration()) && this._isGenerating) {
              /* Filesystem work (indexing, Graphify import) has no
                 interruption point — say so instead of ignoring the click. */
              await this._addSystemMessage(
                '⚠️ This step cannot be interrupted (local file work). It will finish shortly.'
              );
            }
            break;
          case 'setMode':
            if (typeof data.mode === 'string' && isAgentMode(data.mode)) {
              await this._settings.setMode(data.mode);
              this._updateWebview();
              await this._addSystemMessage(this._modeSummary());
            }
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

  /** User interruption. Safe to call when nothing is running. */
  public async stopGeneration(): Promise<boolean> {
    if (!this._activeRun || this._activeRun.signal.aborted) {
      return false;
    }

    this._activeRun.abort();
    this._activity.cancelRunning();
    this._activity.info('Stopped by user');
    this._updateWebview();
    return true;
  }

  /** Begins a cancellable unit of work and returns its signal. */
  private _beginRun(): AbortSignal {
    this._activeRun?.abort();
    this._activeRun = new AbortController();
    return this._activeRun.signal;
  }

  private _endRun(): void {
    this._activeRun = null;
  }

  private _wasStopped(error: unknown, signal: AbortSignal): boolean {
    return isAbortedError(error) || signal.aborted;
  }

  public async reloadActiveSession(): Promise<void> {
    await this._conversationReady;
    await this._loadActiveConversation();
    this._updateWebview();
  }

  public dispose(): void {
    if (this._webviewTimer) {
      clearTimeout(this._webviewTimer);
      this._webviewTimer = undefined;
    }
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
      /* Commands that already wrote their own transcript entries return ''. */
      if (localSlashResult.response) {
        await this._addSystemMessage(localSlashResult.response);
      }
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
    this._activity.reset();

    if (this._settings.planFirst) {
      await this._runPlanningTurn(tokenResolution.text);
      return;
    }

    await this._runExecutionTurn(tokenResolution.text, knownTokenValues, null);
  }

  /** Plan mode: draft a plan and stop. Nothing runs until it is accepted. */
  private async _runPlanningTurn(goal: string): Promise<void> {
    const signal = this._beginRun();
    this._setGenerating(true);
    try {
      const plan = await this._planService.createPlan(goal, this._buildScopeContext(), signal);
      this._pendingPlan = plan;
      this._updateWebview();
      await this._addSystemMessage(this._planService.formatPlanForChat(plan));
    } catch (error) {
      this._pendingPlan = null;
      await this._addSystemMessage(
        this._wasStopped(error, signal)
          ? '⏹ **Stopped by you.** No plan was created — send a new request to try again.'
          : `❌ **Planning failed**: ${this._formatErrorMessage(error)}`
      );
    } finally {
      this._endRun();
      this._setGenerating(false);
    }
  }

  private async _approvePendingPlan(): Promise<void> {
    if (this._isGenerating) {
      await this._addSystemMessage('⏳ Olliberty is still working. Wait for the current run to finish.');
      return;
    }

    const plan = this._pendingPlan;
    if (!plan) {
      await this._addSystemMessage('⚠️ No pending plan to accept. Send a request first.');
      return;
    }

    this._pendingPlan = null;
    this._updateWebview();
    this._activity.info('Plan accepted', `${plan.steps.length} step(s)`);
    await this._addSystemMessage(`▶️ **Plan accepted** — executing ${plan.steps.length || 1} step(s).`);

    const knownTokenValues = await this._tokenStore.listTokenValues();

    if (plan.touchesFiles) {
      await this._executePlanAsEdits(plan);
      return;
    }

    await this._runExecutionTurn(plan.goal, knownTokenValues, plan);
  }

  /** A plan that touches files runs through the diff/approve surface. */
  private async _executePlanAsEdits(plan: Plan): Promise<void> {
    const signal = this._beginRun();
    this._setGenerating(true);
    try {
      const instruction = [this._planService.toExecutionBrief(plan), '', `Original request: ${plan.goal}`].join('\n');
      const proposal = await this._editService.createProposal(
        instruction,
        vscode.window.activeTextEditor,
        signal
      );
      this._pendingEdit = proposal;
      this._updateWebview();

      const proposalMessage = await this._editService.formatProposalForChat(proposal);
      const diffPreviewMessage = await this._openProposalDiffs(proposal);

      await this._addSystemMessage(
        [
          proposalMessage,
          '',
          diffPreviewMessage,
          '',
          'Nothing has been written yet. Use **Apply pending edit** (or `/approve`) to write these changes, or `/reject` to discard.'
        ].join('\n')
      );
    } catch (error) {
      await this._addSystemMessage(
        this._wasStopped(error, signal)
          ? '⏹ **Stopped by you.** No files were written.'
          : `❌ **Failed to execute plan**: ${this._formatErrorMessage(error)}`
      );
    } finally {
      this._endRun();
      this._setGenerating(false);
      this._updateWebview();
    }
  }

  /** Streamed answer turn: tokens land in the transcript as they arrive. */
  private async _runExecutionTurn(
    request: string,
    knownTokenValues: string[],
    plan: Plan | null
  ): Promise<void> {
    const signal = this._beginRun();
    this._setGenerating(true);
    this._streamingContent = '';
    this._isStreaming = true;

    try {
      const fullPrompt = await this._activity.run(
        'Building prompt context',
        async step => {
          const prompt = await this._buildPrompt(request, plan);
          step.update(`${prompt.length} chars sent to the model`);
          return prompt;
        }
      );

      const response = await this._activity.run(
        'Generating response',
        async step =>
          this._client.generate({
            prompt: fullPrompt,
            stream: this._settings.streamResponses,
            signal,
            onToken: (_chunk, full) => {
              this._streamingContent = full;
              step.update(`${full.length} chars streamed`);
              this._updateWebview();
            }
          }),
        `model: ${this._client.getCurrentModel()}`
      );

      const scrubbedResponse = scrubSensitiveContent(response, knownTokenValues);
      this._isStreaming = false;
      this._streamingContent = '';
      await this._addMessage('assistant', scrubbedResponse.text);
    } catch (error) {
      /* Keep whatever was streamed before the stop — it is often the
         useful part, and discarding it would hide real work. */
      const partial = this._streamingContent;
      this._isStreaming = false;
      this._streamingContent = '';

      if (this._wasStopped(error, signal)) {
        const scrubbedPartial = partial
          ? scrubSensitiveContent(partial, knownTokenValues).text
          : '';
        await this._addMessage(
          'assistant',
          scrubbedPartial
            ? `${scrubbedPartial}\n\n⏹ _Stopped by you — partial response above._`
            : '⏹ **Stopped by you.** Nothing was generated.'
        );
      } else {
        await this._addMessage('assistant', this._formatErrorMessage(error));
      }
    } finally {
      this._endRun();
      this._setGenerating(false);
    }
  }

  private async _openAppliedChangeDiff(filePath: string): Promise<void> {
    try {
      await this._editService.showAppliedChangeDiff(filePath);
    } catch (error) {
      await this._addSystemMessage(`⚠️ Could not open diff for \`${filePath}\`: ${this._rawErrorMessage(error)}`);
    }
  }

  private _modeSummary(): string {
    return this._settings.planFirst
      ? '📋 **Mode: plan** — every request produces a plan you accept before anything runs, and file writes still need a separate diff approval.'
      : '⚡ **Mode: auto** — requests run immediately without a plan gate.';
  }

  private _buildScopeContext(): string {
    const workspaceFolder = this._getCurrentWorkspaceFolder();
    if (!workspaceFolder) {
      return '';
    }
    const activeScopePath = this._getEffectiveScopePath(workspaceFolder.uri.fsPath);
    return this._buildScopePromptHeader(workspaceFolder.uri.fsPath, activeScopePath);
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

  private async _buildPrompt(trimmedMessage: string, plan: Plan | null = null): Promise<string> {
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

    if (plan) {
      contextPrompt = `${this._planService.toExecutionBrief(plan)}\n\n${contextPrompt}`;
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
      case 'mode': {
        if (!argument) {
          return { handled: true, response: this._modeSummary() };
        }
        const normalizedMode = argument.toLowerCase() as AgentMode;
        if (!isAgentMode(normalizedMode)) {
          return {
            handled: true,
            response: '⚠️ Usage: `/mode plan` (plan first, then accept) or `/mode auto` (run immediately).'
          };
        }
        await this._settings.setMode(normalizedMode);
        this._updateWebview();
        return { handled: true, response: this._modeSummary() };
      }
      case 'plan': {
        if (!argument) {
          return {
            handled: true,
            response: this._pendingPlan
              ? this._planService.formatPlanForChat(this._pendingPlan)
              : '⚠️ Usage: `/plan <goal>` to draft a plan for review.'
          };
        }
        this._activity.reset();
        await this._runPlanningTurn(argument);
        return { handled: true, response: '' };
      }
      case 'accept':
        await this._approvePendingPlan();
        return { handled: true, response: '' };
      case 'discard':
        this._pendingPlan = null;
        this._updateWebview();
        return { handled: true, response: '🗑️ Plan discarded. Nothing was executed.' };
      case 'changes':
        return { handled: true, response: this._changesMessage() };
      case 'activity':
        this._activity.showOutput();
        return { handled: true, response: this._activityMessage() };
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
          this._activity.reset();
          const editSignal = this._beginRun();
          const proposal = await this._editService.createProposal(
            argument,
            vscode.window.activeTextEditor,
            editSignal
          );
          this._pendingEdit = proposal;
          if (this._settings.autoApplyEdits) {
            const appliedChanges = await this._editService.applyProposal(proposal);
            this._pendingEdit = null;
            return {
              handled: true,
              response: await this._formatAppliedEditMessage(appliedChanges)
            };
          }

          const proposalMessage = await this._editService.formatProposalForChat(proposal);
          const diffPreviewMessage = await this._openProposalDiffs(proposal);
          this._updateWebview();
          return {
            handled: true,
            response: [
              proposalMessage,
              '',
              diffPreviewMessage,
              '',
              'Use **Apply pending edit** (or `/approve`) to write changes, or `/reject` to discard.'
            ].join('\n')
          };
        } catch (error) {
          return {
            handled: true,
            response: isAbortedError(error)
              ? '⏹ **Stopped by you.** No edit was prepared and no files were written.'
              : `❌ **Failed to prepare edit**: ${this._rawErrorMessage(error)}`
          };
        } finally {
          this._endRun();
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
        this._activity.reset();
        this._setGenerating(true);
        try {
          return {
            handled: true,
            response: await this._runDelegatedAgents(argument)
          };
        } finally {
          this._endRun();
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

    if (this._isGenerating) {
      return '⏳ Olliberty is still working. Wait for the current run to finish.';
    }

    this._setGenerating(true);
    try {
      const appliedChanges = await this._editService.applyProposal(proposal);
      this._pendingEdit = null;
      return await this._formatAppliedEditMessage(appliedChanges);
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

  private async _formatAppliedEditMessage(changes: AppliedChange[]): Promise<string> {
    const lines = [this._editService.formatAppliedChangesForChat(changes)];

    try {
      await this._editService.revealAppliedFiles(changes.map(change => change.filePath));
      lines.push('', 'Opened each edited file in the IDE editor.');
    } catch (error) {
      lines.push('', `⚠️ Applied edits, but could not open files in the editor: ${this._rawErrorMessage(error)}`);
    }

    return lines.join('\n');
  }

  private _changesMessage(): string {
    const changes = this._editService.listAppliedChanges();
    if (!changes.length) {
      return '📄 **No file changes applied yet in this session.**';
    }

    const totalAdditions = changes.reduce((sum, change) => sum + change.additions, 0);
    const totalRemovals = changes.reduce((sum, change) => sum + change.removals, 0);
    const lines = changes.map(change =>
      `- \`${change.filePath}\` · +${change.additions} −${change.removals}`
        + `${change.isNewFile ? ' (new file)' : ''} · ${new Date(change.appliedAt).toLocaleTimeString()}`
    );

    return [
      `📄 **Applied changes this session (${changes.length})** · +${totalAdditions} −${totalRemovals}`,
      '',
      ...lines,
      '',
      'Click any file in the **Changes** panel to reopen its diff.'
    ].join('\n');
  }

  private _activityMessage(): string {
    if (!this._activitySteps.length) {
      return '🔎 **No activity recorded yet.** Send a request and the steps will appear here and in the Olliberty output channel.';
    }

    const lines = this._activitySteps.map(step => {
      const icon = step.status === 'done' ? '✔' : step.status === 'failed' ? '✖' : step.status === 'running' ? '▶' : '•';
      const detail = step.detail ? ` — ${step.detail}` : '';
      return `- ${icon} ${step.label}${detail}`;
    });

    return ['🔎 **Activity for the last run**', '', ...lines].join('\n');
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
    const signal = this._beginRun();
    try {
      const result = await this._multiAgentService.runDelegatedTask(
        goal,
        agents => {
          this._activeAgentRuns = agents.map(agent => ({
            id: agent.id,
            name: agent.name,
            status: agent.status,
            detail: agent.detail
          }));
          this._updateWebview();
        },
        signal
      );

      if (signal.aborted) {
        return '⏹ **Stopped by you.** The delegated agent run was interrupted.';
      }

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
      return this._wasStopped(error, signal)
        ? '⏹ **Stopped by you.** The delegated agent run was interrupted.'
        : `❌ **Delegated multi-agent run failed**: ${this._rawErrorMessage(error)}`;
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
    this._pendingPlan = null;
    this._activeAgentRuns = [];
    this._streamingContent = '';
    this._isStreaming = false;
    this._editService.clearAppliedChanges();
    this._activity.reset();
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

    const elapsed = Date.now() - this._lastWebviewPost;
    if (elapsed >= WEBVIEW_UPDATE_INTERVAL_MS) {
      this._postWebviewState();
      return;
    }

    if (this._webviewTimer) {
      return;
    }

    this._webviewTimer = setTimeout(() => {
      this._webviewTimer = undefined;
      this._postWebviewState();
    }, WEBVIEW_UPDATE_INTERVAL_MS - elapsed);
  }

  private _postWebviewState(): void {
    if (!this._view) {
      return;
    }

    this._lastWebviewPost = Date.now();
    this._view.webview.postMessage({
      type: 'updateMessages',
      messages: this._messages,
      isConnected: this._isConnected,
      isGenerating: this._isGenerating,
      agentRuns: this._activeAgentRuns,
      mode: this._settings.mode,
      model: this._client.getCurrentModel(),
      showActivity: this._settings.showActivityFeed,
      activity: this._activitySteps.map(step => ({
        id: step.id,
        label: step.label,
        detail: step.detail,
        status: step.status,
        elapsedMs: (step.endedAt ?? Date.now()) - step.startedAt
      })),
      streaming: this._isStreaming ? this._streamingContent : '',
      changes: this._editService.listAppliedChanges().map(change => ({
        filePath: change.filePath,
        additions: change.additions,
        removals: change.removals,
        isNewFile: change.isNewFile,
        appliedAt: change.appliedAt
      })),
      pendingPlan: this._pendingPlan
        ? {
            goal: this._pendingPlan.goal,
            summary: this._pendingPlan.summary,
            stepCount: this._pendingPlan.steps.length,
            files: this._pendingPlan.files
          }
        : null,
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
        <div id="status-bar">
            <div id="connection-status"></div>
            <div id="status-meta">
                <span id="model-badge" title="Active Ollama model"></span>
                <button id="mode-toggle" class="chip" title="Toggle plan-first mode"></button>
                <button id="activity-log-button" class="chip" title="Open the Olliberty output channel">Log</button>
            </div>
        </div>
        <div id="activity-container" style="display: none;">
            <div class="section-title">
                <span>Working</span>
                <span id="activity-summary"></span>
            </div>
            <div id="activity-list"></div>
        </div>
        <div id="agent-runs-container" style="display: none;">
            <div id="agent-runs-title">🤝 Agents running</div>
            <div id="agent-runs-list"></div>
        </div>
        <div id="changes-container" style="display: none;">
            <div class="section-title">
                <span>Changes</span>
                <span id="changes-summary"></span>
            </div>
            <div id="changes-list"></div>
        </div>
        <div id="messages-container"></div>
        <div id="input-container">
            <div id="context-info"></div>
            <div id="install-button-container" style="display: none;">
                <button id="install-button" class="install-btn">📥 Install Ollama</button>
            </div>
            <div id="pending-plan-container" style="display: none;">
                <div id="pending-plan-summary"></div>
                <div class="pending-edit-actions">
                    <button id="approve-plan-button" class="pending-edit-btn approve">✅ Accept plan</button>
                    <button id="reject-plan-button" class="pending-edit-btn reject">✖ Discard</button>
                </div>
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
            <div id="stop-hint" style="display: none;">Press <kbd>Esc</kbd> to stop</div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let messages = [];
        let isConnected = false;
        let isGenerating = false;
        let pendingEdit = null;
        let pendingPlan = null;
        let agentRuns = [];
        let activity = [];
        let changes = [];
        let streaming = '';
        let mode = 'plan';
        /* Snapshots of the last-rendered state for each panel. updateMessages fires on every
         * activity tick during generation (as often as every WEBVIEW_UPDATE_INTERVAL_MS), but
         * most ticks don't change most panels — rebuilding innerHTML unconditionally on every
         * tick is what causes the visible flashing/flicker while Olliberty is working. Skipping
         * a render when its slice of state is byte-identical to last time removes that churn. */
        let lastRenderedMessagesJson = null;
        let lastRenderedStreaming = null;
        let lastActivityJson = null;
        let lastChangesJson = null;
        let lastAgentRunsJson = null;
        let model = '';
        let showActivity = true;

        const messagesContainer = document.getElementById('messages-container');
        const messageInput = document.getElementById('message-input');
        const sendButton = document.getElementById('send-button');
        const contextInfo = document.getElementById('context-info');
        const connectionStatus = document.getElementById('connection-status');
        const modelBadge = document.getElementById('model-badge');
        const modeToggle = document.getElementById('mode-toggle');
        const activityLogButton = document.getElementById('activity-log-button');
        const activityContainer = document.getElementById('activity-container');
        const activityList = document.getElementById('activity-list');
        const activitySummary = document.getElementById('activity-summary');
        const changesContainer = document.getElementById('changes-container');
        const changesList = document.getElementById('changes-list');
        const changesSummary = document.getElementById('changes-summary');
        const agentRunsContainer = document.getElementById('agent-runs-container');
        const agentRunsList = document.getElementById('agent-runs-list');
        const installButtonContainer = document.getElementById('install-button-container');
        const installButton = document.getElementById('install-button');
        const pendingPlanContainer = document.getElementById('pending-plan-container');
        const pendingPlanSummary = document.getElementById('pending-plan-summary');
        const approvePlanButton = document.getElementById('approve-plan-button');
        const rejectPlanButton = document.getElementById('reject-plan-button');
        const stopHint = document.getElementById('stop-hint');
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

        function formatElapsed(ms) {
            if (!ms || ms < 0) { return '0ms'; }
            return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
        }

        function statusIconFor(status) {
            if (status === 'done') { return '✔'; }
            if (status === 'failed') { return '✖'; }
            if (status === 'cancelled') { return '⏹'; }
            if (status === 'running') { return '●'; }
            return '·';
        }

        /* Renders a fenced diff the way a terminal review does:
           additions green, removals red, hunk separators dimmed. */
        function renderDiffBlock(body) {
            const lines = body.split('\\n').map(line => {
                let cls = 'diff-context';
                if (line.startsWith('+')) { cls = 'diff-add'; }
                else if (line.startsWith('-')) { cls = 'diff-remove'; }
                else if (line.startsWith('@@')) { cls = 'diff-hunk'; }
                return '<span class="diff-line ' + cls + '">' + escapeHtml(line) + '</span>';
            });
            return '<pre class="diff-block">' + lines.join('') + '</pre>';
        }

        function renderInline(text) {
            return escapeHtml(text)
                .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
                .replace(/\`([^\`]+)\`/g, '<code>$1</code>');
        }

        /* Prose outside code fences: tool-style lines get their own look.
           Blank lines hugging a code fence would otherwise double up. */
        function renderProse(text) {
            const lines = text.split('\\n');
            while (lines.length && lines[0].trim() === '') { lines.shift(); }
            while (lines.length && lines[lines.length - 1].trim() === '') { lines.pop(); }

            return lines.map(line => {
                if (line.startsWith('● ')) {
                    return '<div class="tool-line"><span class="tool-bullet">●</span> '
                        + renderInline(line.slice(2)) + '</div>';
                }
                if (line.trim().startsWith('⎿ ')) {
                    return '<div class="tool-detail">⎿ ' + renderInline(line.trim().slice(2)) + '</div>';
                }
                return '<div class="prose-line">' + renderInline(line) + '</div>';
            }).join('');
        }

        function renderContent(text) {
            const parts = String(text).split(/\`\`\`/);
            let html = '';

            parts.forEach((part, index) => {
                if (index % 2 === 0) {
                    html += renderProse(part);
                    return;
                }

                const newlineIndex = part.indexOf('\\n');
                const language = (newlineIndex === -1 ? part : part.slice(0, newlineIndex)).trim();
                const body = newlineIndex === -1 ? '' : part.slice(newlineIndex + 1).replace(/\\n$/, '');

                if (language.toLowerCase() === 'diff') {
                    html += renderDiffBlock(body);
                } else {
                    html += '<pre><code>' + escapeHtml(body) + '</code></pre>';
                }
            });

            return html;
        }

        function updateConnectionStatus() {
            if (!isConnected) {
                connectionStatus.innerHTML = '<div class="connection-error">⚠️ Ollama not connected</div>';
                installButtonContainer.style.display = 'block';
            } else if (isGenerating) {
                const running = activity.filter(step => step.status === 'running');
                const label = running.length ? running[running.length - 1].label : 'Working';
                connectionStatus.innerHTML = '<div class="connection-success">⏳ ' + escapeHtml(label) + '…</div>';
                installButtonContainer.style.display = 'none';
            } else {
                connectionStatus.innerHTML = '<div class="connection-success">✅ Ollama connected</div>';
                installButtonContainer.style.display = 'none';
            }
        }

        /* While generating, the send button becomes the stop control so
           interrupting is always one click away. */
        function updateComposerState() {
            messageInput.disabled = !isConnected;
            approvePlanButton.disabled = !isConnected || isGenerating;
            rejectPlanButton.disabled = isGenerating;
            approveEditButton.disabled = !isConnected || isGenerating;
            previewEditButton.disabled = isGenerating;
            rejectEditButton.disabled = isGenerating;

            sendButton.disabled = !isConnected;
            sendButton.textContent = isGenerating ? '■' : '↑';
            sendButton.className = isGenerating ? 'stopping' : '';
            sendButton.title = isGenerating ? 'Stop (Esc)' : 'Send';
            sendButton.setAttribute('aria-label', isGenerating ? 'Stop' : 'Send');
            stopHint.style.display = isGenerating ? 'block' : 'none';

            messageInput.placeholder = !isConnected
                ? 'Install Ollama to continue...'
                : isGenerating
                    ? 'Working… press Esc to stop, or type your next message'
                    : 'Ask Ollama...';
        }

        function updateHeaderState() {
            modelBadge.textContent = model ? '🤖 ' + model : '';
            modeToggle.textContent = mode === 'plan' ? '📋 Plan first' : '⚡ Auto';
            modeToggle.className = 'chip ' + (mode === 'plan' ? 'chip-active' : '');
        }

        function renderActivity() {
            const snapshotJson = JSON.stringify({ showActivity, activity });
            if (snapshotJson === lastActivityJson) {
                return;
            }
            lastActivityJson = snapshotJson;

            if (!showActivity || !Array.isArray(activity) || activity.length === 0) {
                activityContainer.style.display = 'none';
                activityList.innerHTML = '';
                activitySummary.textContent = '';
                return;
            }

            activityContainer.style.display = 'block';
            const running = activity.filter(step => step.status === 'running').length;
            const failed = activity.filter(step => step.status === 'failed').length;
            activitySummary.textContent = running
                ? running + ' running'
                : failed
                    ? failed + ' failed'
                    : activity.length + ' steps';

            activityList.innerHTML = activity.map(step => {
                const detail = step.detail
                    ? '<div class="activity-detail">⎿ ' + escapeHtml(step.detail) + '</div>'
                    : '';
                const elapsed = step.status === 'running'
                    ? ''
                    : '<span class="activity-elapsed">' + formatElapsed(step.elapsedMs) + '</span>';
                return [
                    '<div class="activity-item activity-' + step.status + '">',
                    '<div class="activity-head">',
                    '<span class="activity-icon">' + statusIconFor(step.status) + '</span>',
                    '<span class="activity-label">' + escapeHtml(step.label) + '</span>',
                    elapsed,
                    '</div>',
                    detail,
                    '</div>'
                ].join('');
            }).join('');
        }

        function renderChanges() {
            const snapshotJson = JSON.stringify(changes);
            if (snapshotJson === lastChangesJson) {
                return;
            }
            lastChangesJson = snapshotJson;

            if (!Array.isArray(changes) || changes.length === 0) {
                changesContainer.style.display = 'none';
                changesList.innerHTML = '';
                changesSummary.textContent = '';
                return;
            }

            changesContainer.style.display = 'block';
            const additions = changes.reduce((sum, change) => sum + change.additions, 0);
            const removals = changes.reduce((sum, change) => sum + change.removals, 0);
            changesSummary.textContent = changes.length + ' files · +' + additions + ' −' + removals;

            changesList.innerHTML = changes.map(change => [
                '<button class="change-item" data-file="' + escapeHtml(change.filePath) + '" title="Open diff">',
                '<span class="change-path">' + escapeHtml(change.filePath) + '</span>',
                '<span class="change-stats">',
                '<span class="diff-add-count">+' + change.additions + '</span> ',
                '<span class="diff-remove-count">−' + change.removals + '</span>',
                change.isNewFile ? ' <span class="change-new">new</span>' : '',
                '</span>',
                '</button>'
            ].join('')).join('');

            Array.prototype.forEach.call(changesList.querySelectorAll('.change-item'), button => {
                button.addEventListener('click', () => {
                    vscode.postMessage({ type: 'openChangeDiff', filePath: button.getAttribute('data-file') });
                });
            });
        }

        function updatePendingPlanState() {
            if (!pendingPlan) {
                pendingPlanContainer.style.display = 'none';
                pendingPlanSummary.textContent = '';
                return;
            }

            pendingPlanContainer.style.display = 'block';
            const files = Array.isArray(pendingPlan.files) ? pendingPlan.files : [];
            const fileLabel = files.length ? files.length + ' file(s)' : 'no file changes';
            pendingPlanSummary.textContent =
                '📋 Plan ready · ' + pendingPlan.stepCount + ' step(s) · ' + fileLabel;
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
            const snapshotJson = JSON.stringify(agentRuns);
            if (snapshotJson === lastAgentRunsJson) {
                return;
            }
            lastAgentRunsJson = snapshotJson;

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

        function appendMessageElement(role, content, timestamp, isPartial) {
            const messageElement = document.createElement('div');
            messageElement.className = 'message ' + role + (isPartial ? ' streaming' : '');

            const avatarIcon = role === 'assistant' ? '🤖' : role === 'user' ? '🧑' : 'ℹ️';
            const header = document.createElement('div');
            header.className = 'message-header';
            header.innerHTML = [
                '<span class="avatar">' + avatarIcon + '</span>',
                '<span class="role">' + role + '</span>',
                '<span class="timestamp">' + new Date(timestamp).toLocaleTimeString() + '</span>',
                isPartial ? '<span class="streaming-badge">streaming…</span>' : ''
            ].join('');

            const body = document.createElement('div');
            body.className = 'message-content';
            body.innerHTML = renderContent(content) + (isPartial ? '<span class="cursor">▋</span>' : '');

            messageElement.appendChild(header);
            messageElement.appendChild(body);
            messagesContainer.appendChild(messageElement);
        }

        function renderMessages() {
            const messagesJson = JSON.stringify(messages);
            const settledUnchanged = messagesJson === lastRenderedMessagesJson;
            const streamingUnchanged = streaming === lastRenderedStreaming;

            if (settledUnchanged && streamingUnchanged) {
                /* Nothing this panel cares about changed — most updateMessages ticks during a
                 * run are activity/agent-run progress, not new chat content. */
                return;
            }

            if (settledUnchanged && streaming && lastRenderedStreaming !== null) {
                /* Only the in-progress streaming text advanced. Patch the trailing bubble in
                 * place instead of tearing down and rebuilding the whole history — that full
                 * rebuild on every token is what caused the visible flicker/scroll-jump. */
                const last = messagesContainer.lastElementChild;
                const body = last && last.classList.contains('streaming')
                    ? last.querySelector('.message-content')
                    : null;
                if (body) {
                    body.innerHTML = renderContent(streaming) + '<span class="cursor">▋</span>';
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                    lastRenderedStreaming = streaming;
                    return;
                }
            }

            lastRenderedMessagesJson = messagesJson;
            lastRenderedStreaming = streaming;

            messagesContainer.innerHTML = '';

            if (messages.length === 0 && !streaming) {
                const emptyState = document.createElement('div');
                emptyState.className = 'empty-state';
                emptyState.innerHTML = \`
                    <div class="empty-state-icon">🤖</div>
                    <div class="empty-state-title">Olliberty</div>
                    <div class="empty-state-description">
                        Ask me anything about your code.<br>
                        Plan mode drafts a plan you accept before anything runs.<br>
                        /edit for local diffs, /agents for parallel analysis, /changes for what was written.
                    </div>
                \`;
                messagesContainer.appendChild(emptyState);
                return;
            }

            messages.forEach(message => {
                appendMessageElement(message.role, message.content, message.timestamp, false);
            });

            if (streaming) {
                appendMessageElement('assistant', streaming, Date.now(), true);
            }

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

        function stopGeneration() {
            if (!isGenerating) {
                return;
            }
            vscode.postMessage({ type: 'stopGeneration' });
        }

        sendButton.addEventListener('click', () => {
            if (isGenerating) {
                stopGeneration();
            } else {
                sendMessage();
            }
        });

        /* Esc interrupts from anywhere in the panel, matching the CLI. */
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && isGenerating) {
                event.preventDefault();
                stopGeneration();
            }
        });

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

        approvePlanButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'approvePlan' });
        });

        rejectPlanButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'rejectPlan' });
        });

        activityLogButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'showActivityLog' });
        });

        modeToggle.addEventListener('click', () => {
            vscode.postMessage({ type: 'setMode', mode: mode === 'plan' ? 'auto' : 'plan' });
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
                    activity = Array.isArray(message.activity) ? message.activity : [];
                    changes = Array.isArray(message.changes) ? message.changes : [];
                    streaming = typeof message.streaming === 'string' ? message.streaming : '';
                    mode = message.mode || 'plan';
                    model = message.model || '';
                    showActivity = message.showActivity !== false;
                    pendingEdit = message.pendingEdit ?? null;
                    pendingPlan = message.pendingPlan ?? null;
                    renderMessages();
                    renderActivity();
                    renderChanges();
                    renderAgentRuns();
                    updateHeaderState();
                    updateConnectionStatus();
                    updateComposerState();
                    updatePendingPlanState();
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
