// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  The CLI turn engine.
 *  This is the terminal counterpart of the plugin's SharedChatViewProvider:
 *  the same plan gate, the same slash commands, the same scrubbing, the same
 *  approval-before-write rule. It owns no rendering — it emits events that
 *  the TUI (or one-shot mode) paints.                                      */

import * as fs from 'fs';
import * as path from 'path';
import { OllamaClient, isAbortedError } from '../main/client';
import { ActivityStep } from '../main/core/activityContract';
import { AppliedChange, EditProposal } from '../main/core/editProposal';
import { detectOS, getInstallationInfo } from '../main/core/ollamaInstall';
import { AgentMode, isAgentMode } from '../main/core/settingsContract';
import { ConversationStore } from '../main/conversationStore';
import { FileDiff } from '../main/diff';
import {
  DelegatedAgentProgress,
  DelegationDecision,
  MultiAgentService,
  formatAgentFooter
} from '../main/multiAgentService';
import { Plan, PlanService } from '../main/planService';
import { scrubSensitiveContent } from '../main/security/secretScrubber';
import { TokenStore } from '../main/tokenStore';
import { runChatSlashCommand } from '../main/ui/chatCommands';
import { CliActivityReporter } from './activity';
import { FileCodeIndexStore } from './codeIndex';
import { ConfigKey, FileSettings, isConfigKey, listConfigKeys } from './config';
import { AttachedFile, CliEditService, formatAttachments } from './editService';
import { FileSecretVault } from './secretVault';
import { findGraphifyJsonFiles, readAttachment } from './workspaceFiles';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
}

export type AgentRunView = Pick<
  DelegatedAgentProgress,
  'id' | 'name' | 'goal' | 'status' | 'detail' | 'chars' | 'startedAt' | 'endedAt' | 'attempt'
>;

export interface SessionState {
  generating: boolean;
  streaming: boolean;
  mode: AgentMode;
  model: string;
  effort: string;
  hasPendingPlan: boolean;
  hasPendingEdit: boolean;
  pendingEditFiles: string[];
  attachments: string[];
  sessionId: string;
  connected: boolean;
  scopePath: string;
}

export type SessionEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'stream-start' }
  | { type: 'stream'; full: string }
  | { type: 'stream-end' }
  | { type: 'activity'; steps: ActivityStep[] }
  | { type: 'agents'; agents: AgentRunView[] }
  | { type: 'pending-diffs'; title: string; diffs: FileDiff[] }
  | { type: 'state'; state: SessionState }
  | { type: 'exit' };

type SessionListener = (event: SessionEvent) => void;

type LocalSlashResult =
  | { handled: false }
  | { handled: true; response: string };

export interface AgentSessionDeps {
  client: OllamaClient;
  settings: FileSettings;
  codeIndex: FileCodeIndexStore;
  editService: CliEditService;
  multiAgentService: MultiAgentService;
  planService: PlanService;
  conversationStore: ConversationStore;
  tokenStore: TokenStore;
  secretVault: FileSecretVault;
  activity: CliActivityReporter;
  workspaceRoot: string;
}

export class AgentSession {
  private readonly listeners = new Set<SessionListener>();
  private messages: ChatMessage[] = [];
  private sessionId = '';
  private isConnected = false;
  private isGenerating = false;
  private isStreaming = false;
  private streamingContent = '';
  private pendingEdit: EditProposal | null = null;
  private pendingPlan: Plan | null = null;
  private agentRuns: AgentRunView[] = [];
  private pathOverride: string | null = null;
  private attachments: AttachedFile[] = [];
  private activeRun: AbortController | null = null;

  constructor(private readonly deps: AgentSessionDeps) {
    this.deps.activity.onDidChange(steps => this.emit({ type: 'activity', steps }));
  }

  on(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Load the active conversation and probe Ollama. Safe to call once. */
  async initialize(): Promise<void> {
    await this.loadActiveConversation();
    await this.checkConnection();
    if (this.deps.settings.autoIndexWorkspace) {
      void this.deps.codeIndex.ensureIndexed();
    }
    this.publishState();
  }

  history(): ChatMessage[] {
    return this.messages.map(message => ({ ...message }));
  }

  state(): SessionState {
    return {
      generating: this.isGenerating,
      streaming: this.isStreaming,
      mode: this.deps.settings.mode,
      model: this.deps.settings.model,
      effort: this.deps.settings.effort,
      hasPendingPlan: this.pendingPlan !== null,
      hasPendingEdit: this.pendingEdit !== null,
      pendingEditFiles: this.pendingEdit?.edits.map(edit => edit.filePath) ?? [],
      attachments: this.attachments.map(attachment => attachment.relativePath),
      sessionId: this.sessionId,
      connected: this.isConnected,
      scopePath: this.effectiveScopePath()
    };
  }

  /** User interruption. Returns false when nothing was interruptible. */
  stop(): boolean {
    if (!this.activeRun || this.activeRun.signal.aborted) {
      return false;
    }

    this.activeRun.abort();
    this.deps.activity.cancelRunning();
    this.deps.activity.info('Stopped by user');
    this.publishState();
    return true;
  }

  busy(): boolean {
    return this.isGenerating;
  }

  /* ─────────────────────────── turn entry point ─────────────────────── */

  async submit(input: string): Promise<void> {
    const trimmedMessage = input.trim();
    if (!trimmedMessage) {
      return;
    }

    const knownTokenValues = await this.deps.tokenStore.listTokenValues();
    const scrubbedInput = scrubSensitiveContent(trimmedMessage, knownTokenValues);

    const localSlashResult = await this.runLocalSlashCommand(trimmedMessage);
    if (localSlashResult.handled) {
      /* Commands that already wrote their own transcript entries return ''. */
      if (localSlashResult.response) {
        await this.addSystemMessage(localSlashResult.response);
      }
      this.publishState();
      return;
    }

    try {
      const commandResponse = await runChatSlashCommand(trimmedMessage, this.deps.client);
      if (commandResponse !== null) {
        await this.addSystemMessage(commandResponse);
        this.publishState();
        return;
      }
    } catch (error) {
      await this.addSystemMessage(this.formatErrorMessage(error));
      return;
    }

    if (!this.isConnected) {
      await this.checkConnection();
      if (!this.isConnected) {
        await this.addSystemMessage(
          `❌ **Cannot send message: Ollama is not connected**\n\nPlease install or start Ollama for ${detectOS()} first — run \`/doctor\` for instructions.`
        );
        return;
      }
    }

    const tokenResolution = await this.deps.tokenStore.resolvePlaceholders(scrubbedInput.text);
    if (tokenResolution.missingKeys.length) {
      await this.addSystemMessage(
        `⚠️ Missing token value for ${tokenResolution.missingKeys.map(key => `\`::${key}::\``).join(', ')}. Set them with \`/token <key> <value>\`.`
      );
    }

    await this.addMessage('user', scrubbedInput.text);
    this.deps.activity.reset();

    if (this.deps.settings.planFirst) {
      await this.runPlanningTurn(tokenResolution.text);
      return;
    }

    await this.runExecutionTurn(tokenResolution.text, knownTokenValues, null);
  }

  /** Plan mode: draft a plan and stop. Nothing runs until it is accepted. */
  private async runPlanningTurn(goal: string): Promise<void> {
    const signal = this.beginRun();
    this.setGenerating(true);
    try {
      const plan = await this.deps.planService.createPlan(goal, this.buildScopeContext(), signal);
      this.pendingPlan = plan;
      await this.addSystemMessage(this.deps.planService.formatPlanForChat(plan));
    } catch (error) {
      this.pendingPlan = null;
      await this.addSystemMessage(
        this.wasStopped(error, signal)
          ? '⏹ **Stopped by you.** No plan was created — send a new request to try again.'
          : `❌ **Planning failed**: ${this.formatErrorMessage(error)}`
      );
    } finally {
      this.endRun();
      this.setGenerating(false);
    }
  }

  async acceptPlan(): Promise<void> {
    if (this.isGenerating) {
      await this.addSystemMessage('⏳ Olliberty is still working. Wait for the current run to finish.');
      return;
    }

    const plan = this.pendingPlan;
    if (!plan) {
      await this.addSystemMessage('⚠️ No pending plan to accept. Send a request first.');
      return;
    }

    this.pendingPlan = null;
    this.deps.activity.info('Plan accepted', `${plan.steps.length} step(s)`);
    await this.addSystemMessage(`▶️ **Plan accepted** — executing ${plan.steps.length || 1} step(s).`);

    const knownTokenValues = await this.deps.tokenStore.listTokenValues();

    if (plan.touchesFiles) {
      await this.executePlanAsEdits(plan);
      return;
    }

    await this.runExecutionTurn(plan.goal, knownTokenValues, plan);
  }

  /** A plan that touches files runs through the diff/approve surface. */
  private async executePlanAsEdits(plan: Plan): Promise<void> {
    const signal = this.beginRun();
    this.setGenerating(true);
    try {
      const instruction = [
        this.deps.planService.toExecutionBrief(plan),
        '',
        `Original request: ${plan.goal}`
      ].join('\n');

      const proposal = await this.deps.editService.createProposal(instruction, this.attachments, signal);
      this.pendingEdit = proposal;
      await this.announceProposal(proposal, 'Nothing has been written yet. Approve with `/approve` to write these changes, or `/reject` to discard.');
    } catch (error) {
      await this.addSystemMessage(
        this.wasStopped(error, signal)
          ? '⏹ **Stopped by you.** No files were written.'
          : `❌ **Failed to execute plan**: ${this.formatErrorMessage(error)}`
      );
    } finally {
      this.endRun();
      this.setGenerating(false);
    }
  }

  /**
   * The answer turn. Every request is routed first: anything with real work in
   * it is split across sub-agents and their results merged, and only short or
   * self-contained requests take the single-pass path. `/agents` is the same
   * machinery with the router skipped, not a separate mode.
   */
  private async runExecutionTurn(request: string, knownTokenValues: string[], plan: Plan | null): Promise<void> {
    const signal = this.beginRun();
    this.setGenerating(true);

    try {
      const decision = await this.routeRequest(request, signal);
      if (decision?.fanOut) {
        const answered = await this.runFannedOutTurn(request, plan, knownTokenValues, decision, signal);
        if (answered || this.wasStopped(null, signal)) {
          return;
        }
        /* The split failed outright. The user asked a question and is owed an
           answer, so drop to one pass rather than reporting the machinery. */
        this.deps.activity.info('Answering in a single pass', 'the delegated run produced nothing');
      }

      await this.streamSingleAnswer(request, plan, knownTokenValues, signal);
    } finally {
      this.endRun();
      this.setGenerating(false);
      this.agentRuns = [];
      this.emit({ type: 'agents', agents: [] });
    }
  }

  /** Routing must never cost the user their turn; a failure means one pass. */
  private async routeRequest(request: string, signal: AbortSignal): Promise<DelegationDecision | null> {
    try {
      return await this.deps.multiAgentService.decide(request, signal);
    } catch (error) {
      if (this.wasStopped(error, signal)) {
        return null;
      }
      this.deps.activity.info('Agent routing unavailable', this.rawErrorMessage(error));
      return null;
    }
  }

  /**
   * Runs the split and streams the merged answer into the transcript as an
   * ordinary assistant message — the sub-agents show up in the task panel, not
   * in the answer. Returns false when nothing usable came back, so the caller
   * can still answer directly.
   */
  private async runFannedOutTurn(
    request: string,
    plan: Plan | null,
    knownTokenValues: string[],
    decision: DelegationDecision,
    signal: AbortSignal
  ): Promise<boolean> {
    this.streamingContent = '';

    try {
      const result = await this.deps.multiAgentService.runDelegatedTask(
        request,
        agents => this.publishAgentRuns(agents),
        {
          signal,
          decision,
          extraContext: this.buildDelegationContext(plan),
          /* The fan-out itself takes tens of seconds with nothing to show, so
             the transcript only enters streaming state once the merged answer
             starts arriving. */
          onSynthesisToken: (_chunk, full) => {
            if (!this.isStreaming) {
              this.isStreaming = true;
              this.emit({ type: 'stream-start' });
            }
            this.streamingContent = full;
            this.emit({ type: 'stream', full });
          }
        }
      );

      if (this.wasStopped(null, signal)) {
        const partial = this.streamingContent;
        this.endStream();
        await this.addMessage(
          'assistant',
          partial
            ? `${scrubSensitiveContent(partial, knownTokenValues).text}\n\n⏹ _Stopped by you — partial answer above._`
            : '⏹ **Stopped by you.** Nothing was generated.'
        );
        return true;
      }

      if (!result.synthesis.trim()) {
        this.endStream();
        return false;
      }

      const scrubbed = scrubSensitiveContent(result.synthesis, knownTokenValues);
      this.endStream();
      await this.addMessage('assistant', [scrubbed.text, formatAgentFooter(result.agents)].join('\n'));
      return true;
    } catch (error) {
      const partial = this.streamingContent;
      this.endStream();

      if (this.wasStopped(error, signal)) {
        const scrubbedPartial = partial ? scrubSensitiveContent(partial, knownTokenValues).text : '';
        await this.addMessage(
          'assistant',
          scrubbedPartial
            ? `${scrubbedPartial}\n\n⏹ _Stopped by you — partial answer above._`
            : '⏹ **Stopped by you.** Nothing was generated.'
        );
        return true;
      }

      /* Not fatal: the single-pass fallback still owes the user an answer. */
      this.deps.activity.info('Delegated run failed', this.rawErrorMessage(error));
      return false;
    }
  }

  /** Single-pass answer: tokens land in the transcript as they arrive. */
  private async streamSingleAnswer(
    request: string,
    plan: Plan | null,
    knownTokenValues: string[],
    signal: AbortSignal
  ): Promise<void> {
    this.streamingContent = '';
    this.isStreaming = true;
    this.emit({ type: 'stream-start' });

    try {
      const fullPrompt = await this.deps.activity.run(
        'Building prompt context',
        async step => {
          const prompt = await this.buildPrompt(request, plan);
          step.update(`${prompt.length} chars sent to the model`);
          return prompt;
        }
      );

      const response = await this.deps.activity.run(
        'Generating response',
        async step =>
          this.deps.client.generate({
            prompt: fullPrompt,
            stream: this.deps.settings.streamResponses,
            signal,
            onToken: (_chunk, full) => {
              this.streamingContent = full;
              step.update(`${full.length} chars streamed`);
              this.emit({ type: 'stream', full });
            },
            onThinking: (_chunk, full) => step.update(`reasoning · ${full.length} chars`)
          }),
        `model: ${this.deps.client.getCurrentModel()}`
      );

      const scrubbedResponse = scrubSensitiveContent(response, knownTokenValues);
      this.endStream();
      await this.addMessage('assistant', scrubbedResponse.text);
    } catch (error) {
      /* Keep whatever was streamed before the stop — it is often the
         useful part, and discarding it would hide real work. */
      const partial = this.streamingContent;
      this.endStream();

      if (this.wasStopped(error, signal)) {
        const scrubbedPartial = partial ? scrubSensitiveContent(partial, knownTokenValues).text : '';
        await this.addMessage(
          'assistant',
          scrubbedPartial
            ? `${scrubbedPartial}\n\n⏹ _Stopped by you — partial response above._`
            : '⏹ **Stopped by you.** Nothing was generated.'
        );
      } else {
        await this.addMessage('assistant', this.formatErrorMessage(error));
      }
    }
  }

  private publishAgentRuns(agents: DelegatedAgentProgress[]): void {
    this.agentRuns = agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      goal: agent.goal,
      status: agent.status,
      detail: agent.detail,
      chars: agent.chars,
      startedAt: agent.startedAt,
      endedAt: agent.endedAt,
      attempt: agent.attempt
    }));
    this.emit({ type: 'agents', agents: this.agentRuns });
  }

  /* Sub-agents get the scope header, the attachments and the approved plan —
     the same framing the single-pass prompt carries. The indexed snippets are
     left to the service, which sizes them to the agents' context window. */
  private buildDelegationContext(plan: Plan | null): string {
    const parts = [
      this.buildScopePromptHeader(this.deps.workspaceRoot, this.effectiveScopePath()),
      plan ? this.deps.planService.toExecutionBrief(plan) : '',
      this.attachments.length ? formatAttachments(this.attachments) : ''
    ];
    return parts.filter(Boolean).join('\n\n');
  }

  /* ───────────────────────────── slash commands ─────────────────────── */

  private async runLocalSlashCommand(input: string): Promise<LocalSlashResult> {
    if (!input.startsWith('/')) {
      return { handled: false };
    }

    const [commandToken, ...args] = input.slice(1).split(/\s+/);
    const command = commandToken.toLowerCase();
    const argument = args.join(' ').trim();

    switch (command) {
      case 'help':
        return { handled: true, response: this.helpMessage() };

      case 'exit':
      case 'quit':
        this.emit({ type: 'exit' });
        return { handled: true, response: '' };

      case 'privacy':
        return {
          handled: true,
          response: [
            this.deps.settings.privacySummary(),
            `🔐 **Token storage:** ${this.deps.secretVault.describeStorage()}`
          ].join('\n')
        };

      case 'mode': {
        if (!argument) {
          return { handled: true, response: this.modeSummary() };
        }
        const normalizedMode = argument.toLowerCase();
        if (!isAgentMode(normalizedMode)) {
          return {
            handled: true,
            response: '⚠️ Usage: `/mode plan` (plan first, then accept) or `/mode auto` (run immediately).'
          };
        }
        await this.deps.settings.setMode(normalizedMode);
        return { handled: true, response: this.modeSummary() };
      }

      case 'plan': {
        if (!argument) {
          return {
            handled: true,
            response: this.pendingPlan
              ? this.deps.planService.formatPlanForChat(this.pendingPlan)
              : '⚠️ Usage: `/plan <goal>` to draft a plan for review.'
          };
        }
        this.deps.activity.reset();
        await this.runPlanningTurn(argument);
        return { handled: true, response: '' };
      }

      case 'accept':
        await this.acceptPlan();
        return { handled: true, response: '' };

      case 'discard':
        this.pendingPlan = null;
        return { handled: true, response: '🗑️ Plan discarded. Nothing was executed.' };

      case 'changes':
        return { handled: true, response: this.changesMessage() };

      case 'diff':
        return { handled: true, response: this.diffMessage(argument) };

      case 'activity':
        return { handled: true, response: this.activityMessage() };

      case 'token':
        return this.handleTokenCommand(argument);

      case 'path':
        return this.handlePathCommand(argument);

      case 'attach':
        return this.handleAttachCommand(argument);

      case 'detach':
        return this.handleDetachCommand(argument);

      case 'context':
        return { handled: true, response: await this.contextMessage() };

      case 'config':
        return this.handleConfigCommand(argument);

      case 'doctor':
        return { handled: true, response: await this.doctorMessage() };

      case 'index':
        if (argument.toLowerCase() === 'status') {
          return { handled: true, response: await this.indexStatusMessage() };
        }
        this.setGenerating(true);
        try {
          const result = await this.deps.activity.run(
            'Rebuilding workspace index',
            async step => {
              const built = await this.deps.codeIndex.rebuild();
              step.update(`${built.indexedFiles} files indexed`);
              return built;
            }
          );
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
          this.setGenerating(false);
        }

      case 'edit': {
        if (!argument) {
          return { handled: true, response: '⚠️ Usage: `/edit <instruction>`' };
        }
        this.setGenerating(true);
        const editSignal = this.beginRun();
        try {
          this.deps.activity.reset();
          const proposal = await this.deps.editService.createProposal(argument, this.attachments, editSignal);
          this.pendingEdit = proposal;

          if (this.deps.settings.autoApplyEdits) {
            const appliedChanges = await this.deps.editService.applyProposal(proposal);
            this.pendingEdit = null;
            return { handled: true, response: this.deps.editService.formatAppliedChangesForChat(appliedChanges) };
          }

          await this.announceProposal(proposal, 'Use `/approve` to write these changes, or `/reject` to discard.');
          return { handled: true, response: '' };
        } catch (error) {
          return {
            handled: true,
            response: isAbortedError(error)
              ? '⏹ **Stopped by you.** No edit was prepared and no files were written.'
              : `❌ **Failed to prepare edit**: ${this.rawErrorMessage(error)}`
          };
        } finally {
          this.endRun();
          this.setGenerating(false);
        }
      }

      case 'approve':
        return { handled: true, response: await this.approvePendingEdit() };

      case 'reject':
        this.pendingEdit = null;
        return { handled: true, response: '🗑️ Pending edit rejected.' };

      case 'agents':
      case 'delegate':
        if (!argument) {
          return { handled: true, response: '⚠️ Usage: `/agents <goal>`' };
        }
        this.deps.activity.reset();
        this.setGenerating(true);
        try {
          return { handled: true, response: await this.runDelegatedAgents(argument) };
        } finally {
          this.endRun();
          this.setGenerating(false);
          this.agentRuns = [];
          this.emit({ type: 'agents', agents: [] });
          this.publishState();
        }

      case 'sessions':
        return { handled: true, response: await this.sessionOverviewMessage() };

      case 'session':
        return this.handleSessionCommand(argument);

      case 'clear':
      case 'new':
        await this.clearChat();
        return { handled: true, response: `🆕 **Started new chat session**: \`${this.sessionId}\`` };

      case 'note':
        return this.handleNoteCommand(argument);

      case 'notes':
        return { handled: true, response: await this.sessionNotesMessage() };

      case 'graphify':
        return this.handleGraphifyCommand(argument);

      default:
        return { handled: false };
    }
  }

  /* ─────────────────────────── prompt building ──────────────────────── */

  private async buildPrompt(trimmedMessage: string, plan: Plan | null = null): Promise<string> {
    const workspaceRootPath = this.deps.workspaceRoot;
    const activeScopePath = this.effectiveScopePath();
    const scopePrefix = this.toRelativeScopePrefix(workspaceRootPath, activeScopePath);
    let contextPrompt = trimmedMessage;

    /* The CLI's stand-in for "the active editor" is whatever the user
       attached with `@path` or `/attach`. */
    if (this.attachments.length) {
      contextPrompt = [formatAttachments(this.attachments), '', trimmedMessage].join('\n');
    }

    await this.deps.codeIndex.ensureIndexed();

    const indexedQuery = scopePrefix ? `${trimmedMessage}\n${scopePrefix}` : trimmedMessage;
    const indexedContext = await this.deps.codeIndex.buildPromptContext(indexedQuery, 4, scopePrefix);
    if (indexedContext) {
      contextPrompt = `${contextPrompt}\n\nRelevant indexed workspace snippets:\n${indexedContext}`;
    } else {
      const fallbackContext = await this.deps.codeIndex.buildFallbackContext(4, scopePrefix);
      if (fallbackContext) {
        contextPrompt = `${contextPrompt}\n\nRecent files from the active workspace scope:\n${fallbackContext}`;
      }
    }

    const graphifyContext = await this.deps.conversationStore.buildGraphifyPromptContext(trimmedMessage, 6);
    if (graphifyContext) {
      contextPrompt = `${contextPrompt}\n\n${graphifyContext}`;
    }

    const scopePrompt = this.buildScopePromptHeader(workspaceRootPath, activeScopePath);
    if (scopePrompt) {
      contextPrompt = `${scopePrompt}\n\n${contextPrompt}`;
    }

    if (plan) {
      contextPrompt = `${this.deps.planService.toExecutionBrief(plan)}\n\n${contextPrompt}`;
    }

    const conversationHistory = this.messages
      .slice(-8)
      .filter(message => message.role !== 'system')
      .map(message => `${message.role}: ${message.content}`)
      .join('\n\n');

    return conversationHistory
      ? `Previous conversation:\n${conversationHistory}\n\nCurrent request: ${contextPrompt}`
      : contextPrompt;
  }

  private buildScopeContext(): string {
    return this.buildScopePromptHeader(this.deps.workspaceRoot, this.effectiveScopePath());
  }

  private buildScopePromptHeader(workspaceRootPath: string, activeScopePath: string): string {
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

  private effectiveScopePath(): string {
    const normalizedRoot = path.resolve(this.deps.workspaceRoot);
    if (!this.pathOverride) {
      return normalizedRoot;
    }

    const normalizedOverride = path.resolve(this.pathOverride);
    if (!isSameOrChildPath(normalizedRoot, normalizedOverride)) {
      this.pathOverride = null;
      return normalizedRoot;
    }

    return normalizedOverride;
  }

  private toRelativeScopePrefix(workspaceRootPath: string, activeScopePath: string): string {
    if (!workspaceRootPath || !activeScopePath) {
      return '';
    }

    const relative = path.relative(workspaceRootPath, activeScopePath).replace(/\\/g, '/');
    if (!relative || relative === '.') {
      return '';
    }

    return relative.startsWith('../') ? '' : relative;
  }

  /* ──────────────────────────── edits & agents ──────────────────────── */

  private async announceProposal(proposal: EditProposal, footer: string): Promise<void> {
    const diffs = await this.deps.editService.buildProposalDiffs(proposal);
    this.emit({ type: 'pending-diffs', title: proposal.summary, diffs });
    await this.addSystemMessage(
      [await this.deps.editService.formatProposalForChat(proposal), '', footer].join('\n')
    );
  }

  private async approvePendingEdit(): Promise<string> {
    const proposal = this.pendingEdit;
    if (!proposal) {
      return '⚠️ No pending edit found. Run `/edit <instruction>` first.';
    }

    if (this.isGenerating) {
      return '⏳ Olliberty is still working. Wait for the current run to finish.';
    }

    this.setGenerating(true);
    try {
      const appliedChanges = await this.deps.editService.applyProposal(proposal);
      this.pendingEdit = null;
      return this.deps.editService.formatAppliedChangesForChat(appliedChanges);
    } catch (error) {
      return `❌ **Failed to apply edit**: ${this.formatErrorMessage(error)}`;
    } finally {
      this.setGenerating(false);
      this.publishState();
    }
  }

  /**
   * `/agents <goal>`: the same machinery as an ordinary turn with the router
   * skipped, so a request the router would have answered in one pass gets
   * split anyway.
   */
  private async runDelegatedAgents(goal: string): Promise<string> {
    const signal = this.beginRun();
    this.streamingContent = '';

    try {
      const result = await this.deps.multiAgentService.runDelegatedTask(
        goal,
        agents => this.publishAgentRuns(agents),
        {
          signal,
          force: true,
          extraContext: this.buildDelegationContext(null),
          onSynthesisToken: (_chunk, full) => {
            if (!this.isStreaming) {
              this.isStreaming = true;
              this.emit({ type: 'stream-start' });
            }
            this.streamingContent = full;
            this.emit({ type: 'stream', full });
          }
        }
      );

      if (signal.aborted) {
        this.endStream();
        return '⏹ **Stopped by you.** The delegated agent run was interrupted.';
      }

      this.endStream();

      if (!result.synthesis.trim()) {
        return '⚠️ The agents ran but produced no answer. Try `/effort low`, a smaller request, or raise `/config agents.maxTokens`.';
      }

      const knownTokenValues = await this.deps.tokenStore.listTokenValues();
      const scrubbed = scrubSensitiveContent(result.synthesis, knownTokenValues);
      await this.addMessage('assistant', [scrubbed.text, formatAgentFooter(result.agents)].join('\n'));
      /* The answer is already in the transcript; no second copy. */
      return '';
    } catch (error) {
      this.endStream();
      return this.wasStopped(error, signal)
        ? '⏹ **Stopped by you.** The delegated agent run was interrupted.'
        : `❌ **Delegated multi-agent run failed**: ${this.rawErrorMessage(error)}`;
    }
  }

  /* ──────────────────────────── command bodies ─────────────────────── */

  private async handleTokenCommand(argument: string): Promise<LocalSlashResult> {
    try {
      const normalizedArgument = argument.trim();

      if (!normalizedArgument || normalizedArgument.toLowerCase() === 'list') {
        const keys = await this.deps.tokenStore.listTokenKeys();
        const listedKeys = keys.length ? keys.map(key => `- \`${key}\``).join('\n') : '- No tokens stored yet.';
        return {
          handled: true,
          response: [
            '🔐 **Stored token keys**',
            '',
            listedKeys,
            '',
            `Stored in ${this.deps.secretVault.describeStorage()}.`,
            'Use `/token <key> <value>` to save a token, `/token remove <key>` to delete one, and `::KEY::` placeholders in prompts.'
          ].join('\n')
        };
      }

      const deleteMatch = normalizedArgument.match(/^(?:remove|delete|unset)\s+([A-Za-z][A-Za-z0-9_]*)$/i);
      if (deleteMatch) {
        const removed = await this.deps.tokenStore.deleteToken(deleteMatch[1]);
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
      const normalizedKey = await this.deps.tokenStore.setToken(key, rawValue);

      return {
        handled: true,
        response: `✅ Stored token \`${normalizedKey}\` in ${this.deps.secretVault.describeStorage()}. Reference it in prompts with \`::${normalizedKey}::\`.`
      };
    } catch (error) {
      return { handled: true, response: `❌ ${this.rawErrorMessage(error)}` };
    }
  }

  private async handlePathCommand(argument: string): Promise<LocalSlashResult> {
    const workspaceRootPath = this.deps.workspaceRoot;
    const normalizedWorkspaceRoot = path.resolve(workspaceRootPath);
    const normalizedArgument = argument.trim();

    if (!normalizedArgument) {
      const activeScopePath = this.effectiveScopePath();
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

    if (['reset', 'clear', 'default'].includes(normalizedArgument.toLowerCase())) {
      this.pathOverride = null;
      return { handled: true, response: `✅ Path scope reset to workspace root: \`${workspaceRootPath}\`.` };
    }

    const requestedPath = path.isAbsolute(normalizedArgument)
      ? path.resolve(normalizedArgument)
      : path.resolve(workspaceRootPath, normalizedArgument);

    if (!isSameOrChildPath(normalizedWorkspaceRoot, requestedPath)) {
      return {
        handled: true,
        response: `⚠️ Path must stay inside the current workspace root: \`${workspaceRootPath}\`.`
      };
    }

    try {
      const stats = await fs.promises.stat(requestedPath);
      const scopedPath = stats.isDirectory() ? requestedPath : path.dirname(requestedPath);
      this.pathOverride = scopedPath;
      return {
        handled: true,
        response: [
          `✅ Active path scope set to \`${scopedPath}\`.`,
          'All relative paths now resolve from this directory until `/path reset`.'
        ].join('\n')
      };
    } catch {
      return { handled: true, response: `⚠️ Path not found: \`${requestedPath}\`.` };
    }
  }

  /** `@path` mentions and `/attach` share this code path. */
  async attachFiles(requestedPaths: string[]): Promise<{ attached: string[]; failed: Array<{ path: string; reason: string }> }> {
    const attached: string[] = [];
    const failed: Array<{ path: string; reason: string }> = [];

    for (const requestedPath of requestedPaths) {
      try {
        const attachment = await readAttachment(this.deps.workspaceRoot, requestedPath);
        const existingIndex = this.attachments.findIndex(item => item.relativePath === attachment.relativePath);
        if (existingIndex === -1) {
          this.attachments.push(attachment);
        } else {
          this.attachments[existingIndex] = attachment;
        }
        attached.push(attachment.relativePath);
      } catch (error) {
        failed.push({ path: requestedPath, reason: this.rawErrorMessage(error) });
      }
    }

    this.publishState();
    return { attached, failed };
  }

  private async handleAttachCommand(argument: string): Promise<LocalSlashResult> {
    const requestedPaths = argument.split(/\s+/).filter(Boolean);
    if (!requestedPaths.length) {
      return {
        handled: true,
        response: this.attachments.length
          ? ['📎 **Attached files**', '', ...this.attachments.map(item => `- \`${item.relativePath}\`${item.truncated ? ' (truncated)' : ''}`), '', 'Usage: `/attach <path>` to add, `/detach <path|all>` to remove.'].join('\n')
          : '📎 No files attached. Usage: `/attach <path>`, or mention files inline with `@path`.'
      };
    }

    const result = await this.attachFiles(requestedPaths);
    const lines: string[] = [];
    if (result.attached.length) {
      lines.push(`📎 **Attached ${result.attached.length} file(s)**`, '', ...result.attached.map(item => `- \`${item}\``));
    }
    if (result.failed.length) {
      lines.push('', ...result.failed.map(item => `⚠️ \`${item.path}\`: ${item.reason}`));
    }
    return { handled: true, response: lines.join('\n') };
  }

  private handleDetachCommand(argument: string): LocalSlashResult {
    const normalized = argument.trim();
    if (!normalized || normalized.toLowerCase() === 'all') {
      const count = this.attachments.length;
      this.attachments = [];
      this.publishState();
      return { handled: true, response: count ? `📎 Detached all ${count} file(s).` : '📎 Nothing was attached.' };
    }

    const before = this.attachments.length;
    this.attachments = this.attachments.filter(item => item.relativePath !== normalized.replace(/\\/g, '/'));
    this.publishState();
    return {
      handled: true,
      response: this.attachments.length === before
        ? `⚠️ \`${normalized}\` was not attached.`
        : `📎 Detached \`${normalized}\`.`
    };
  }

  private async handleConfigCommand(argument: string): Promise<LocalSlashResult> {
    const parts = argument.trim().split(/\s+/).filter(Boolean);

    if (!parts.length) {
      const rows = listConfigKeys().map(key => {
        const value = this.readableConfigValue(key as ConfigKey);
        return `- \`${key}\` = ${value} _(${this.deps.settings.describeSource(key as ConfigKey)})_`;
      });
      return {
        handled: true,
        response: [
          '⚙️ **Effective configuration**',
          '',
          ...rows,
          '',
          'Set a value with `/config <key> <value>` (written to your user config file).'
        ].join('\n')
      };
    }

    const [key, ...valueParts] = parts;
    if (!isConfigKey(key)) {
      return { handled: true, response: `⚠️ Unknown config key \`${key}\`. Run \`/config\` to list keys.` };
    }
    if (!valueParts.length) {
      return {
        handled: true,
        response: `⚙️ \`${key}\` = ${this.readableConfigValue(key)} _(${this.deps.settings.describeSource(key)})_`
      };
    }

    const parsedValue = parseConfigValue(valueParts.join(' '));
    try {
      await this.deps.settings.writeUserValue(key, parsedValue);
      return {
        handled: true,
        response: `✅ Set \`${key}\` to \`${JSON.stringify(parsedValue)}\` in your user config.`
      };
    } catch (error) {
      return { handled: true, response: `❌ Could not write config: ${this.rawErrorMessage(error)}` };
    }
  }

  private readableConfigValue(key: ConfigKey): string {
    const value = this.deps.settings.snapshot()[key];
    return typeof value === 'string' && !value ? '_(empty)_' : `\`${JSON.stringify(value)}\``;
  }

  private async doctorMessage(): Promise<string> {
    const healthy = await this.deps.client.isHealthy();
    this.isConnected = healthy;
    this.publishState();

    const lines = [
      '🩺 **Olliberty doctor**',
      '',
      `Platform: **${detectOS()}**`,
      `Ollama URL: \`${this.deps.settings.url}\``,
      `Ollama reachable: ${healthy ? '**yes**' : '**no**'}`,
      `Model: \`${this.deps.settings.model}\``,
      `Workspace: \`${this.deps.workspaceRoot}\``
    ];

    if (healthy) {
      try {
        const models = await this.deps.client.listModels();
        lines.push(`Local models: **${models.length}**`);
        if (!models.includes(this.deps.settings.model)) {
          lines.push('', `⚠️ Configured model \`${this.deps.settings.model}\` is not installed. Pull it with \`ollama pull ${this.deps.settings.model}\` or pick another with \`/model <name>\`.`);
        }
      } catch (error) {
        lines.push(`⚠️ Could not list models: ${this.rawErrorMessage(error)}`);
      }
      return lines.join('\n');
    }

    const info = getInstallationInfo();
    return [
      ...lines,
      '',
      `**${info.title}**`,
      info.description,
      '',
      '```bash',
      ...info.commands,
      '```',
      '',
      `Download: ${info.downloadUrl}`,
      ...(info.additionalNotes ? ['', info.additionalNotes] : [])
    ].join('\n');
  }

  private async contextMessage(): Promise<string> {
    const status = await this.deps.codeIndex.getStatus();
    const scope = this.effectiveScopePath();
    const attachmentChars = this.attachments.reduce((sum, item) => sum + item.content.length, 0);

    return [
      '🧭 **Context for the next request**',
      '',
      `Workspace root: \`${this.deps.workspaceRoot}\``,
      `Active scope: \`${scope}\``,
      `Code index: ${status.exists ? `**${status.fileCount}** files, built ${new Date(status.generatedAt).toLocaleTimeString()}` : '**not built** — run `/index`'}`,
      `Attached files: **${this.attachments.length}**${this.attachments.length ? ` (${attachmentChars} chars)` : ''}`,
      ...this.attachments.map(item => `- \`${item.relativePath}\`${item.truncated ? ' (truncated)' : ''}`),
      `Transcript messages: **${this.messages.length}** (last 8 non-system entries are sent as history)`,
      `Model: \`${this.deps.settings.model}\` · context window: **${this.deps.settings.contextLength}** · max tokens: **${this.deps.settings.maxTokens}**`
    ].join('\n');
  }

  private async indexStatusMessage(): Promise<string> {
    const status = await this.deps.codeIndex.getStatus();
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

  private changesMessage(): string {
    const changes = this.deps.editService.listAppliedChanges();
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
      'Run `/diff <file>` to reopen any of these diffs.'
    ].join('\n');
  }

  private diffMessage(argument: string): string {
    const target = argument.trim();
    if (!target) {
      if (!this.pendingEdit) {
        return '⚠️ Usage: `/diff <file>` — or run `/edit <instruction>` to create a pending change first.';
      }
      return 'ℹ️ A pending edit is waiting. Its diffs are shown above; `/approve` writes them, `/reject` discards them.';
    }

    const change = this.deps.editService.findAppliedChange(target.replace(/\\/g, '/'));
    if (!change) {
      return `⚠️ No recorded change for \`${target}\`. Run \`/changes\` to list edited files.`;
    }

    return this.deps.editService.formatAppliedChangesForChat([change]);
  }

  private activityMessage(): string {
    const steps = this.deps.activity.snapshot();
    if (!steps.length) {
      return `🔎 **No activity recorded yet.** Send a request and the steps appear here and in \`${this.deps.activity.logPath()}\`.`;
    }

    const lines = steps.map(step => {
      const icon = step.status === 'done' ? '✔' : step.status === 'failed' ? '✖' : step.status === 'running' ? '▶' : '•';
      const detail = step.detail ? ` — ${step.detail}` : '';
      return `- ${icon} ${step.label}${detail}`;
    });

    return [
      '🔎 **Activity for the last run**',
      '',
      ...lines,
      '',
      `Full log: \`${this.deps.activity.logPath()}\``
    ].join('\n');
  }

  private async handleSessionCommand(argument: string): Promise<LocalSlashResult> {
    const normalized = argument.trim().toLowerCase();
    if (!normalized || normalized === 'current') {
      return { handled: true, response: await this.currentSessionMessage() };
    }

    if (normalized === 'new') {
      await this.clearChat();
      return { handled: true, response: `🆕 **Started new chat session**: \`${this.sessionId}\`` };
    }

    if (normalized.startsWith('load ')) {
      const sessionId = argument.slice(5).trim();
      if (!sessionId) {
        return { handled: true, response: '⚠️ Usage: `/session load <session-id>`' };
      }

      const activated = await this.deps.conversationStore.activateSession(sessionId);
      if (!activated) {
        return {
          handled: true,
          response: `⚠️ Session \`${sessionId}\` was not found. Run \`/sessions\` to list available sessions.`
        };
      }

      this.sessionId = activated.sessionId;
      this.messages = activated.messages.map(message => ({
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp
      }));
      this.pendingEdit = null;
      this.publishState();

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

  private async handleNoteCommand(argument: string): Promise<LocalSlashResult> {
    const trimmed = argument.trim();
    if (!trimmed || trimmed.toLowerCase() === 'list') {
      return { handled: true, response: await this.sessionNotesMessage() };
    }

    if (!this.sessionId) {
      return { handled: true, response: '⚠️ No active session available for storing a note.' };
    }

    const note = await this.deps.conversationStore.addNote(this.sessionId, trimmed);
    return { handled: true, response: `📝 Saved note \`${note.id}\` for session \`${note.sessionId}\`.` };
  }

  private async handleGraphifyCommand(argument: string): Promise<LocalSlashResult> {
    const normalized = argument.trim().toLowerCase();

    if (!normalized || normalized === 'import') {
      const graphifyFiles = await findGraphifyJsonFiles(this.deps.workspaceRoot);
      if (!graphifyFiles.length) {
        return {
          handled: true,
          response: `⚠️ No Graphify JSON files found under \`${this.deps.workspaceRoot}\`. Expected files under \`<project>/graphify-out/*.json\`.`
        };
      }

      this.setGenerating(true);
      try {
        const summary = await this.deps.activity.run(
          'Importing Graphify context',
          async step => {
            step.update(`${graphifyFiles.length} file(s)`);
            return this.deps.conversationStore.importGraphifyFiles(graphifyFiles);
          }
        );
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
        this.setGenerating(false);
      }
    }

    if (normalized === 'status') {
      const status = await this.deps.conversationStore.getGraphifyStatus();
      const lastImported = status.lastImportedAt > 0 ? new Date(status.lastImportedAt).toLocaleString() : 'never';
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

    return { handled: true, response: '⚠️ Usage: `/graphify import` or `/graphify status`.' };
  }

  private async sessionOverviewMessage(): Promise<string> {
    const overview = await this.deps.conversationStore.getOverview();
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

  private async currentSessionMessage(): Promise<string> {
    const overview = await this.deps.conversationStore.getOverview(1);
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

  private async sessionNotesMessage(): Promise<string> {
    if (!this.sessionId) {
      return '⚠️ No active session available for notes.';
    }

    const notes = await this.deps.conversationStore.listNotes(this.sessionId, 50);
    if (!notes.length) {
      return [
        `📝 **Session notes** for \`${this.sessionId}\``,
        '',
        'No notes yet. Use `/note <text>` to store one.'
      ].join('\n');
    }

    const lines = notes.map((note, index) => [
      `#### ${index + 1}. ${new Date(note.createdAt).toLocaleString()}`,
      note.content.trim()
    ].join('\n'));

    return [`📝 **Session notes** for \`${this.sessionId}\` (${notes.length})`, '', ...lines].join('\n');
  }

  async clearChat(): Promise<void> {
    const nextSession = await this.deps.conversationStore.startNewSession();
    this.sessionId = nextSession.sessionId;
    this.messages = nextSession.messages.map(message => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp
    }));
    this.pendingEdit = null;
    this.pendingPlan = null;
    this.agentRuns = [];
    this.attachments = [];
    this.streamingContent = '';
    this.isStreaming = false;
    this.deps.editService.clearAppliedChanges();
    this.deps.activity.reset();
    this.publishState();
  }

  private modeSummary(): string {
    return this.deps.settings.planFirst
      ? '📋 **Mode: plan** — every request produces a plan you accept before anything runs, and file writes still need a separate diff approval.'
      : '⚡ **Mode: auto** — requests run immediately without a plan gate.';
  }

  private helpMessage(): string {
    return [
      '🛠️ **Olliberty CLI**',
      '',
      '**Keys**',
      '- `Enter` send · `Alt+Enter` (or `\\` + Enter) newline · `Esc` interrupt the current run',
      '- `Shift+Tab` toggle plan/auto · `Tab` accept completion · `↑`/`↓` history',
      '- `Ctrl+L` redraw · `Ctrl+C` clear input (twice to exit) · `Ctrl+D` exit',
      '- Mention files inline with `@path`; they are sent as context',
      '',
      '**Plan & execution**',
      '- `/mode` — show the current execution mode',
      '- `/mode plan|auto` — plan first and wait for acceptance, or run immediately',
      '- `/plan <goal>` — draft a plan for review without running anything',
      '- `/accept` — accept the pending plan and execute it',
      '- `/discard` — discard the pending plan',
      '',
      '**Files**',
      '- `/edit <instruction>` — generate file edits with a terminal diff preview',
      '- `/approve` — apply pending `/edit` changes',
      '- `/reject` — discard pending `/edit` changes',
      '- `/changes` — list every file written in this session',
      '- `/diff <file>` — reprint the diff of an applied change',
      '- `/attach <path>` / `/detach <path|all>` — manage attached context files',
      '',
      '**Context & index**',
      '- `/context` — show exactly what the next request will carry',
      '- `/index` — build or refresh the local workspace code index',
      '- `/index status` — show code index status',
      '- `/path` / `/path <dir-or-file>` / `/path reset` — scope relative paths',
      '- `/graphify import` — import Graphify JSON from the opened project',
      '- `/graphify status` — show imported Graphify context stats',
      '',
      '**Agents**',
      '- Requests are split across sub-agents automatically — no command needed',
      '- `/agents <goal>` — split a request even when the router would answer in one pass',
      '- `/config agents.delegation auto|always|off` — change when splitting happens',
      '- `/config agents.maxCount 1-5` · `/config agents.maxParallel 1-5`',
      '- `/activity` — show what Olliberty did on the last run',
      '',
      '**Model & config**',
      '- `/models` — list available local Ollama models',
      '- `/model` / `/model <name>` — show or switch the default model',
      '- `/effort` / `/effort minimal|low|medium|high|max` — reasoning effort',
      '- `/config` / `/config <key> <value>` — inspect or set configuration',
      '- `/doctor` — check Ollama connectivity and installation',
      '- `/privacy` — show local privacy, kill switch, and token storage',
      '- `/token <key> <value>` · `/token list` · `/token remove <key>`',
      '',
      '**Sessions**',
      '- `/sessions` — show conversation session overview',
      '- `/session current|new|load <id>` — inspect or switch sessions',
      '- `/note <text>` / `/notes` — session notes',
      '- `/clear` — start a new session · `/exit` — leave the CLI'
    ].join('\n');
  }

  /* ────────────────────────────── plumbing ─────────────────────────── */

  private async checkConnection(): Promise<void> {
    try {
      this.isConnected = await this.deps.client.isHealthy();
    } catch {
      this.isConnected = false;
    }

    if (!this.isConnected) {
      await this.addSystemMessage(
        [
          `⚠️ **Ollama is not reachable at \`${this.deps.settings.url}\`** (${detectOS()})`,
          '',
          'Start it with `ollama serve`, or run `/doctor` for installation instructions.'
        ].join('\n')
      );
    }
  }

  private async loadActiveConversation(): Promise<void> {
    const activeConversation = await this.deps.conversationStore.getActiveConversation();
    this.sessionId = activeConversation.sessionId;
    this.messages = activeConversation.messages.map(message => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp
    }));
  }

  private async addSystemMessage(content: string): Promise<void> {
    await this.addMessage('system', content);
  }

  private async addMessage(role: ChatRole, content: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error('No active chat session is available.');
    }

    const stored = await this.deps.conversationStore.appendMessage(this.sessionId, role, content);
    const message: ChatMessage = {
      id: stored.id,
      role: stored.role,
      content: stored.content,
      timestamp: stored.timestamp
    };
    this.messages.push(message);
    this.emit({ type: 'message', message });
  }

  private beginRun(): AbortSignal {
    this.activeRun?.abort();
    this.activeRun = new AbortController();
    return this.activeRun.signal;
  }

  private endRun(): void {
    this.activeRun = null;
  }

  private endStream(): void {
    this.isStreaming = false;
    this.streamingContent = '';
    this.emit({ type: 'stream-end' });
  }

  private wasStopped(error: unknown, signal: AbortSignal): boolean {
    return isAbortedError(error) || signal.aborted;
  }

  private setGenerating(value: boolean): void {
    this.isGenerating = value;
    this.publishState();
  }

  private publishState(): void {
    this.emit({ type: 'state', state: this.state() });
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private rawErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private formatErrorMessage(error: unknown): string {
    const errorMessage = this.rawErrorMessage(error);
    const osInfo = detectOS();

    if (errorMessage.includes('Network kill switch blocked host')) {
      return `🛡️ ${errorMessage} Update allowed hosts with \`/config privacy.allowedHosts '["localhost","my-host"]'\`.`;
    }

    if (errorMessage.includes('Failed to connect') || errorMessage.includes('ECONNREFUSED')) {
      return `❌ **Connection Failed on ${osInfo}**: Ollama server is not running. Start it with \`ollama serve\`.`;
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
}

function isSameOrChildPath(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseConfigValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === 'true';
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed.replace(/^['"]|['"]$/g, '');
}
