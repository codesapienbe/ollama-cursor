/*  Interactive TUI.
 *  Wires the shared turn engine (AgentSession) to the terminal: permanent
 *  transcript above, a live frame below (activity feed, sub-agent tree,
 *  streaming tail, composer, status bar).                                */

import * as fs from 'fs';
import { ActivityStep } from '../main/core/activityContract';
import { isAgentMode } from '../main/core/settingsContract';
import { OllamaClient } from '../main/client';
import { ConversationStore } from '../main/conversationStore';
import { TokenStore } from '../main/tokenStore';
import { CliActivityReporter } from './activity';
import { FileCodeIndexStore } from './codeIndex';
import { FileSettings, listConfigKeys } from './config';
import { CliEditService } from './editService';
import { compactPath, historyPath } from './paths';
import { AgentRunView, AgentSession, ChatMessage, SessionEvent, SessionState } from './session';
import { CSI, cursor, paint, wrapText } from './tui/ansi';
import { renderBanner } from './tui/banner';
import { CompletionContext, computeCompletions } from './tui/completion';
import { renderDiffSummaryLine } from './tui/diffview';
import { renderFooter, renderShortcutHint } from './tui/footer';
import { Composer } from './tui/input';
import { KeyDecoder } from './tui/keys';
import { renderMarkdown } from './tui/markdown';
import { Screen } from './tui/screen';
import { renderActivity, renderAgents, renderStreamTail, renderWorkingLine } from './tui/statusview';
import { palette } from './tui/theme';
import { gitBranch, listPathCompletions } from './workspaceFiles';

const PASTE_ON = `${CSI}?2004h`;
const PASTE_OFF = `${CSI}?2004l`;
const ESCAPE_FLUSH_MS = 30;
const TICK_MS = 90;
const REPAINT_INTERVAL_MS = 60;
const MAX_HISTORY_ENTRIES = 500;
const MAX_STREAM_TAIL_ROWS = 8;

export interface TuiAppDeps {
  session: AgentSession;
  settings: FileSettings;
  client: OllamaClient;
  activity: CliActivityReporter;
  codeIndex: FileCodeIndexStore;
  conversationStore: ConversationStore;
  tokenStore: TokenStore;
  editService: CliEditService;
  workspaceRoot: string;
  version: string;
}

export class TuiApp {
  private readonly screen = new Screen();
  private readonly decoder = new KeyDecoder();
  private readonly composer: Composer;
  private state: SessionState;
  private activitySteps: ActivityStep[] = [];
  private agents: AgentRunView[] = [];
  private streamText = '';
  private streaming = false;
  private runStartedAt = 0;
  private tick = 0;
  private tickTimer?: NodeJS.Timeout;
  private escapeTimer?: NodeJS.Timeout;
  private repaintTimer?: NodeJS.Timeout;
  private cachedModels: string[] | null = null;
  private indexedPaths: string[] | null = null;
  private shouldExit = false;
  private resolveExit?: () => void;
  private ready: Promise<void> = Promise.resolve();
  private isReady = false;
  private activeTurn: Promise<void> = Promise.resolve();
  private pendingDiffBanner: string[] = [];

  constructor(private readonly deps: TuiAppDeps) {
    this.state = deps.session.state();
    this.composer = new Composer(
      this.loadHistory(),
      (text, position) => computeCompletions(text, position, this.completionContext())
    );
  }

  async run(initialPrompt?: string): Promise<number> {
    this.deps.session.on(event => this.onSessionEvent(event));

    /* Raw mode and the input handler come first: probing Ollama and opening
       the session store take time, and keystrokes typed during start-up must
       land in the composer rather than echo into the frame. */
    this.enterRawMode();
    this.printBanner();
    this.attachInput();
    this.screen.onResize(() => this.renderFrame());
    this.renderFrame();

    this.ready = this.deps.session
      .initialize()
      .then(() => {
        this.isReady = true;
        this.state = this.deps.session.state();
        this.renderFrame();
      })
      .catch(error => {
        this.printLines([
          paint(`  ✖ Start-up failed: ${error instanceof Error ? error.message : String(error)}`, { fg: palette.red })
        ]);
      });

    if (initialPrompt?.trim()) {
      await this.submit(initialPrompt);
    }

    await new Promise<void>(resolve => {
      this.resolveExit = resolve;
      if (this.shouldExit) {
        resolve();
      }
    });

    /* Let a turn that is still unwinding finish writing its transcript. */
    this.deps.session.stop();
    await this.activeTurn.catch(() => undefined);
    this.teardown();
    return 0;
  }

  /* ───────────────────────────── input plumbing ─────────────────────── */

  private enterRawMode(): void {
    const stdin = process.stdin;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.setEncoding('utf8');
    process.stdout.write(PASTE_ON);
  }

  private attachInput(): void {
    const stdin = process.stdin;
    stdin.resume();

    stdin.on('data', chunk => {
      void this.onInput(String(chunk));
    });

    /* Piped input ends; nothing more can arrive, so leave cleanly. */
    stdin.on('end', () => this.requestExit());

    /* Ctrl+C arrives as a key in raw mode; this covers signals from elsewhere. */
    process.on('SIGINT', () => {
      if (this.deps.session.busy()) {
        this.interrupt();
        return;
      }
      this.requestExit();
    });
  }

  private async onInput(chunk: string): Promise<void> {
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = undefined;
    }

    for (const key of this.decoder.push(chunk)) {
      await this.handleKey(key);
      if (this.shouldExit) {
        return;
      }
    }

    if (this.decoder.hasPending()) {
      /* A lone ESC only becomes "escape" once we know no sequence follows. */
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = undefined;
        void (async () => {
          for (const key of this.decoder.flushPendingEscape()) {
            await this.handleKey(key);
          }
        })();
      }, ESCAPE_FLUSH_MS);
    }

    this.renderFrame();
  }

  private async handleKey(key: Parameters<Composer['handleKey']>[0]): Promise<void> {
    const action = await this.composer.handleKey(key);

    switch (action.type) {
      case 'submit':
        /* Deliberately not awaited: the input loop must stay responsive so
           Esc and Ctrl+C can interrupt the turn we just started. */
        this.activeTurn = this.submit(action.value);
        break;
      case 'interrupt':
        this.interrupt();
        break;
      case 'exit':
        this.requestExit();
        break;
      case 'toggle-mode':
        await this.toggleMode();
        break;
      case 'redraw':
        this.screen.clear();
        break;
      case 'history-note':
        this.composer.setHint(action.message);
        break;
      default:
        break;
    }

    this.renderFrame();
  }

  private async submit(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    if (this.deps.session.busy()) {
      this.printLines([paint('  ⏳ Still working on the previous request — press Esc to interrupt it first.', { fg: palette.amber })]);
      return;
    }

    /* Repaint first so the composer and any open popup are cleared before
       the user line becomes permanent output. */
    this.renderFrame();
    this.printMessageBlock('user', trimmed);
    this.saveHistory();

    /* Start-up (session store, Ollama probe) may still be in flight; say so
       rather than swallowing the request silently. */
    if (!this.isReady) {
      this.printLines([paint('  … starting up — this request runs as soon as the session is open', { fg: palette.faint })]);
      await this.ready;
    }
    this.runStartedAt = Date.now();
    this.startTicker();
    this.pendingDiffBanner = [];

    const mentioned = extractMentions(trimmed);
    if (mentioned.length) {
      const result = await this.deps.session.attachFiles(mentioned);
      if (result.failed.length) {
        this.printLines(
          result.failed.map(item => paint(`  ⚠ @${item.path}: ${item.reason}`, { fg: palette.amber }))
        );
      }
    }

    try {
      await this.deps.session.submit(trimmed);
    } catch (error) {
      this.printLines(
        wrapText(
          paint(`  ✖ ${error instanceof Error ? error.message : String(error)}`, { fg: palette.red }),
          this.screen.columns
        )
      );
    } finally {
      this.stopTicker();
      this.indexedPaths = null;
      this.renderFrame();
    }
  }

  private interrupt(): void {
    if (this.deps.session.stop()) {
      return;
    }
    if (this.deps.session.busy()) {
      this.printLines([
        paint('  ⚠ This step cannot be interrupted (local file work). It will finish shortly.', { fg: palette.amber })
      ]);
      return;
    }
    this.composer.setHint('Nothing is running.');
  }

  private async toggleMode(): Promise<void> {
    const next = this.deps.settings.planFirst ? 'auto' : 'plan';
    if (!isAgentMode(next)) {
      return;
    }
    await this.deps.settings.setMode(next);
    this.state = this.deps.session.state();
    this.printLines([
      next === 'plan'
        ? paint('  📋 plan mode — requests produce a plan you accept before anything runs', { fg: palette.violet })
        : paint('  ⚡ auto mode — requests run immediately', { fg: palette.amber })
    ]);
  }

  private requestExit(): void {
    this.shouldExit = true;
    this.resolveExit?.();
  }

  private teardown(): void {
    this.stopTicker();
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer);
    }
    if (this.repaintTimer) {
      clearTimeout(this.repaintTimer);
    }
    this.saveHistory();
    process.stdout.write(PASTE_OFF);
    this.screen.setFrame([]);
    this.screen.dispose();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    this.deps.activity.dispose();
    process.stdout.write(`${cursor.show}\n`);
  }

  /* ──────────────────────────── session events ─────────────────────── */

  private onSessionEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'message':
        this.streamText = '';
        this.streaming = false;
        this.printMessageBlock(event.message.role, event.message.content, event.message);
        break;
      case 'stream-start':
        this.streaming = true;
        this.streamText = '';
        break;
      case 'stream':
        this.streamText = event.full;
        this.scheduleRepaint();
        break;
      case 'stream-end':
        this.streaming = false;
        break;
      case 'activity':
        this.activitySteps = event.steps;
        this.scheduleRepaint();
        break;
      case 'agents':
        this.agents = event.agents;
        this.scheduleRepaint();
        break;
      case 'pending-diffs':
        this.pendingDiffBanner = event.diffs.map(diff => renderDiffSummaryLine(diff, this.screen.columns));
        break;
      case 'state':
        this.state = event.state;
        this.scheduleRepaint();
        break;
      case 'exit':
        this.requestExit();
        break;
      default:
        break;
    }
  }

  /* ───────────────────────────────── output ────────────────────────── */

  private printBanner(): void {
    const width = this.screen.columns;
    this.screen.printBlock([
      '',
      ...renderBanner({
        width,
        model: this.deps.settings.model,
        workspace: compactPath(this.deps.workspaceRoot, 60),
        mode: this.deps.settings.mode,
        version: this.deps.version
      }),
      '',
      renderShortcutHint(width),
      ''
    ]);
  }

  private printMessageBlock(role: ChatMessage['role'], content: string, message?: ChatMessage): void {
    const width = this.screen.columns;
    const lines: string[] = [''];

    if (role === 'user') {
      const marker = paint('›', { fg: palette.teal, bold: true });
      lines.push(
        ...wrapText(content, width - 4, '  ').map((line, index) =>
          index === 0 ? `${marker} ${paint(line, { fg: palette.text })}` : `  ${paint(line, { fg: palette.text })}`
        )
      );
    } else if (role === 'assistant') {
      const rendered = renderMarkdown(content, { width: width - 2, indent: '  ' });
      const star = paint('✦', { fg: palette.violet });
      lines.push(...rendered.map((line, index) => (index === 0 ? `${star} ${line.slice(2)}` : line)));
    } else {
      lines.push(...renderMarkdown(content, { width: width - 2, indent: '  ' }));
    }

    if (message && role !== 'user') {
      const stamp = new Date(message.timestamp).toLocaleTimeString();
      lines.push(paint(`  ${stamp}`, { fg: palette.border }));
    }

    this.printLines(lines);
  }

  private printLines(lines: string[]): void {
    this.screen.printBlock(lines);
  }

  private scheduleRepaint(): void {
    if (this.repaintTimer) {
      return;
    }
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = undefined;
      this.renderFrame();
    }, REPAINT_INTERVAL_MS);
  }

  private renderFrame(): void {
    const width = this.screen.columns;
    const busy = this.state.generating;
    const frame: string[] = [];

    if (busy && this.deps.settings.showActivityFeed) {
      frame.push(...renderActivity(this.activitySteps, { width, tick: this.tick, maxRows: 5 }));
    }

    if (this.agents.length) {
      frame.push(...renderAgents(this.agents, { width, tick: this.tick }));
    }

    if (this.streaming && this.streamText) {
      frame.push(...renderStreamTail(this.streamText, { width, tick: this.tick, maxRows: MAX_STREAM_TAIL_ROWS }));
    }

    if (busy) {
      frame.push(renderWorkingLine(this.busyLabel(), Date.now() - this.runStartedAt, { width, tick: this.tick }));
    }

    if (this.pendingDiffBanner.length && !busy && this.state.hasPendingEdit) {
      frame.push(...this.pendingDiffBanner);
    }

    if (frame.length) {
      frame.push('');
    }

    const composer = this.composer.render(width, { busy });
    const composerOffset = frame.length;
    frame.push(...composer.lines);

    const hint = this.composer.hintLine();
    if (hint) {
      frame.push(hint);
    }

    frame.push(
      ...renderFooter({
        width,
        workspace: compactPath(this.deps.workspaceRoot),
        branch: gitBranch(this.deps.workspaceRoot),
        scope: this.scopeLabel(),
        mode: this.state.mode,
        model: this.state.model,
        effort: this.state.effort,
        attachments: this.state.attachments.length,
        changes: this.deps.editService.listAppliedChanges().length,
        connected: this.state.connected,
        busy,
        pendingPlan: this.state.hasPendingPlan,
        pendingEditFiles: this.state.pendingEditFiles
      })
    );

    this.screen.setFrame(frame, {
      row: composerOffset + composer.cursorRow,
      column: composer.cursorColumn
    });
  }

  private busyLabel(): string {
    if (this.agents.some(agent => agent.status === 'running')) {
      return 'Running delegated agents';
    }
    if (this.streaming) {
      return 'Generating';
    }
    const running = this.activitySteps.filter(step => step.status === 'running');
    return running.length ? running[running.length - 1].label : 'Working';
  }

  private scopeLabel(): string {
    if (!this.state.scopePath || this.state.scopePath === this.deps.workspaceRoot) {
      return '';
    }
    return compactPath(this.state.scopePath, 24);
  }

  private startTicker(): void {
    if (this.tickTimer) {
      return;
    }
    this.tickTimer = setInterval(() => {
      this.tick += 1;
      this.renderFrame();
    }, TICK_MS);
  }

  private stopTicker(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  /* ────────────────────────────── completion ───────────────────────── */

  private completionContext(): CompletionContext {
    return {
      listModels: async () => {
        if (this.cachedModels) {
          return this.cachedModels;
        }
        try {
          this.cachedModels = await this.deps.client.listModels();
        } catch {
          this.cachedModels = [];
        }
        return this.cachedModels;
      },
      listPaths: async fragment => {
        const direct = await listPathCompletions(this.deps.workspaceRoot, fragment);
        if (direct.length) {
          return direct;
        }
        if (!this.indexedPaths) {
          this.indexedPaths = await this.deps.codeIndex.listIndexedPaths();
        }
        const needle = fragment.toLowerCase();
        return this.indexedPaths.filter(entry => entry.toLowerCase().includes(needle)).slice(0, 40);
      },
      listSessions: async () => {
        try {
          const overview = await this.deps.conversationStore.getOverview(20);
          return overview.sessions.map(session => session.id);
        } catch {
          return [];
        }
      },
      listConfigKeys: () => [...listConfigKeys()],
      listTokenKeys: async () => {
        try {
          return await this.deps.tokenStore.listTokenKeys();
        } catch {
          return [];
        }
      }
    };
  }

  /* ─────────────────────────────── history ────────────────────────── */

  private loadHistory(): string[] {
    try {
      return fs
        .readFileSync(historyPath(), 'utf8')
        .split('\n')
        .map(entry => entry.trim())
        .filter(Boolean)
        .slice(-MAX_HISTORY_ENTRIES);
    } catch {
      return [];
    }
  }

  private saveHistory(): void {
    try {
      const entries = this.composer.historyEntries().slice(-MAX_HISTORY_ENTRIES);
      fs.mkdirSync(require('path').dirname(historyPath()), { recursive: true });
      fs.writeFileSync(historyPath(), `${entries.join('\n')}\n`, 'utf8');
    } catch {
      /* History is a convenience; a read-only home directory must not break
         the session. */
    }
  }
}

/** `@path` mentions in a prompt become attachments for that turn. */
export function extractMentions(input: string): string[] {
  const matches = input.match(/(?:^|\s)@([^\s]+)/g) ?? [];
  return Array.from(
    new Set(
      matches
        .map(match => match.trim().slice(1))
        .map(value => value.replace(/[.,;:)]+$/, ''))
        .filter(Boolean)
    )
  );
}
