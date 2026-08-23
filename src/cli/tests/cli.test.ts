// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Unit tests for the parts of the CLI that are easy to get subtly wrong:
 *  key decoding, the line editor, display width/wrapping, glob pruning,
 *  configuration layering, and markdown/diff rendering.
 *  Run with `npm run test:cli`.                                          */

import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { computeFileDiff } from '../../main/diff';
import {
  DelegatedAgentProgress,
  MultiAgentService,
  formatAgentFooter,
  heuristicRoleIds,
  isTrivialPrompt
} from '../../main/multiAgentService';
import {
  EmptyAnswerError,
  OllamaClient,
  isEmptyAnswerError,
  promptCharBudget
} from '../../main/client';
import { FileSettings, listConfigKeys } from '../config';
import { compileGlob } from '../glob';
import { extractMentions } from '../app';
import { AgentRunView } from '../session';
import { setColorDepth, stringWidth, truncate, wrapLine } from '../tui/ansi';
import { computeCompletions } from '../tui/completion';
import { Composer } from '../tui/input';
import { KeyDecoder } from '../tui/keys';
import { renderMarkdown } from '../tui/markdown';
import {
  canSplitColumns,
  composeColumns,
  renderTaskPanel,
  taskPanelBodyWidth,
  taskPanelWidth
} from '../tui/taskpanel';

const ESC = String.fromCharCode(27);

setColorDepth('none');

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('stringWidth counts wide characters and ignores styling', () => {
  assert.strictEqual(stringWidth('abc'), 3);
  assert.strictEqual(stringWidth('中文'), 4);
  assert.strictEqual(stringWidth(`${ESC}[31mred${ESC}[0m`), 3);
  /* An emoji with a variation selector is still one glyph. */
  assert.strictEqual(stringWidth('🛠️'), 2);
});

test('truncate never exceeds the requested width', () => {
  const result = truncate('a'.repeat(40), 10);
  assert.ok(stringWidth(result) <= 10, `width was ${stringWidth(result)}`);
  assert.strictEqual(truncate('short', 10), 'short');
});

test('wrapLine keeps every produced line inside the width', () => {
  const text = 'the quick brown fox jumps over the lazy dog and keeps running';
  for (const line of wrapLine(text, 20)) {
    assert.ok(stringWidth(line) <= 20, `"${line}" is ${stringWidth(line)} wide`);
  }
});

test('wrapLine hard-breaks a word longer than the line', () => {
  const lines = wrapLine('x'.repeat(50), 10);
  assert.ok(lines.length >= 5);
  for (const line of lines) {
    assert.ok(stringWidth(line) <= 10);
  }
});

test('glob prunes excluded directories and matches their contents', () => {
  const matcher = compileGlob('**/{.git,node_modules,dist}/**');
  assert.ok(matcher.prunesDirectory('node_modules'));
  assert.ok(matcher.prunesDirectory('packages/app/node_modules'));
  assert.ok(matcher.matches('node_modules/lib/index.js'));
  assert.ok(!matcher.prunesDirectory('src'));
  assert.ok(!matcher.matches('src/index.ts'));
});

test('key decoder handles arrows, shift+tab, ctrl and alt combinations', () => {
  const decoder = new KeyDecoder();
  const keys = decoder.push(`${ESC}[A${ESC}[Z${ESC}[3~`);
  assert.deepStrictEqual(keys.map(key => key.name), ['up', 'tab', 'delete']);
  assert.strictEqual(keys[1].shift, true);

  const control = decoder.push(String.fromCharCode(3));
  assert.strictEqual(control[0].name, 'c');
  assert.strictEqual(control[0].ctrl, true);

  const alt = decoder.push(`${ESC}\r`);
  assert.strictEqual(alt[0].name, 'return');
  assert.strictEqual(alt[0].meta, true);
});

test('key decoder groups printable runs and waits for a lone escape', () => {
  const decoder = new KeyDecoder();
  const typed = decoder.push('hello');
  assert.strictEqual(typed.length, 1);
  assert.strictEqual(typed[0].text, 'hello');

  assert.deepStrictEqual(decoder.push(ESC), []);
  assert.ok(decoder.hasPending());
  assert.strictEqual(decoder.flushPendingEscape()[0].name, 'escape');
});

test('key decoder reassembles a bracketed paste split across chunks', () => {
  const decoder = new KeyDecoder();
  assert.deepStrictEqual(decoder.push(`${ESC}[200~line one`), []);
  const keys = decoder.push(`\nline two${ESC}[201~`);
  assert.strictEqual(keys.length, 1);
  assert.strictEqual(keys[0].paste, true);
  assert.strictEqual(keys[0].text, 'line one\nline two');
});

async function typeInto(composer: Composer, text: string): Promise<void> {
  for (const char of text) {
    await composer.handleKey({ name: char, ctrl: false, meta: false, shift: false, sequence: char, text: char });
  }
}

const enterKey = { name: 'return', ctrl: false, meta: false, shift: false, sequence: '\r' };

test('composer submits on enter and records history', async () => {
  const composer = new Composer([], async () => null);
  await typeInto(composer, 'hello world');
  const action = await composer.handleKey(enterKey);
  assert.deepStrictEqual(action, { type: 'submit', value: 'hello world' });
  assert.ok(composer.isEmpty());
  assert.deepStrictEqual(composer.historyEntries(), ['hello world']);
});

test('enter submits even while the completion popup is open', async () => {
  const composer = new Composer([], async () => ({
    items: [{ value: '/help', label: '/help' }],
    replaceStart: 0,
    replaceEnd: 5,
    suffix: ' '
  }));
  await typeInto(composer, '/help');
  assert.ok(composer.completionOpen());
  const action = await composer.handleKey(enterKey);
  assert.deepStrictEqual(action, { type: 'submit', value: '/help' });
});

test('tab accepts the selected completion', async () => {
  const composer = new Composer([], async () => ({
    items: [{ value: '/models', label: '/models' }],
    replaceStart: 0,
    replaceEnd: 4,
    suffix: ' '
  }));
  await typeInto(composer, '/mod');
  await composer.handleKey({ name: 'tab', ctrl: false, meta: false, shift: false, sequence: '\t' });
  assert.strictEqual(composer.value(), '/models ');
});

test('shift+tab asks for a mode toggle and escape asks for an interrupt', async () => {
  const composer = new Composer([], async () => null);
  const toggle = await composer.handleKey({ name: 'tab', ctrl: false, meta: false, shift: true, sequence: `${ESC}[Z` });
  assert.deepStrictEqual(toggle, { type: 'toggle-mode' });

  const interrupt = await composer.handleKey({ name: 'escape', ctrl: false, meta: false, shift: false, sequence: ESC });
  assert.deepStrictEqual(interrupt, { type: 'interrupt' });
});

test('ctrl+c clears the draft, then exits on a second press', async () => {
  const composer = new Composer([], async () => null);
  await typeInto(composer, 'draft');
  const ctrlC = { name: 'c', ctrl: true, meta: false, shift: false, sequence: String.fromCharCode(3) };
  assert.deepStrictEqual(await composer.handleKey(ctrlC), { type: 'none' });
  assert.ok(composer.isEmpty());
  assert.strictEqual((await composer.handleKey(ctrlC)).type, 'history-note');
  assert.deepStrictEqual(await composer.handleKey(ctrlC), { type: 'exit' });
});

test('alt+enter inserts a newline instead of submitting', async () => {
  const composer = new Composer([], async () => null);
  await typeInto(composer, 'first');
  await composer.handleKey({ name: 'return', ctrl: false, meta: true, shift: false, sequence: `${ESC}\r` });
  await typeInto(composer, 'second');
  assert.strictEqual(composer.value(), 'first\nsecond');
});

test('history recall walks back through previous entries', async () => {
  const composer = new Composer(['older', 'newer'], async () => null);
  const up = { name: 'up', ctrl: false, meta: false, shift: false, sequence: `${ESC}[A` };
  await composer.handleKey(up);
  assert.strictEqual(composer.value(), 'newer');
  await composer.handleKey(up);
  assert.strictEqual(composer.value(), 'older');
});

test('composer renders a box whose cursor lands after the prompt', () => {
  const composer = new Composer([], async () => null);
  const rendered = composer.render(60, { busy: false });
  assert.strictEqual(rendered.lines.length, 3);
  assert.strictEqual(rendered.cursorRow, 1);
  assert.strictEqual(rendered.cursorColumn, 4);
});

test('completions offer commands, argument values and @paths', async () => {
  const workspace = makeTempDir('olliberty-completion-');
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src', 'main.ts'), 'export const a = 1;\n');

  const context = {
    listModels: async () => ['qwen3.8:latest', 'gemma4:26b'],
    listPaths: async (fragment: string) => ['src/', 'src/main.ts'].filter(entry => entry.startsWith(fragment)),
    listSessions: async () => ['session-1'],
    listConfigKeys: () => ['model', 'codeIndex.maxFiles'],
    listTokenKeys: async () => ['GITHUB']
  };

  const commands = await computeCompletions('/mod', 4, context);
  assert.ok(commands);
  assert.ok(commands.items.some(item => item.value === '/model'));

  const models = await computeCompletions('/model qw', 9, context);
  assert.deepStrictEqual(models?.items.map(item => item.value), ['qwen3.8:latest']);

  const modes = await computeCompletions('/mode ', 6, context);
  assert.deepStrictEqual(modes?.items.map(item => item.value), ['plan', 'auto']);

  const mentions = await computeCompletions('explain @src/', 13, context);
  assert.deepStrictEqual(mentions?.items.map(item => item.value), ['@src/', '@src/main.ts']);

  assert.strictEqual(await computeCompletions('plain question', 5, context), null);
});

test('@mentions are extracted and stripped of trailing punctuation', () => {
  assert.deepStrictEqual(
    extractMentions('compare @src/a.ts and @src/b.ts, please'),
    ['src/a.ts', 'src/b.ts']
  );
  assert.deepStrictEqual(extractMentions('no mentions here'), []);
});

test('settings layer project over user config and flags over both', async () => {
  const home = makeTempDir('olliberty-home-');
  const workspace = makeTempDir('olliberty-workspace-');
  process.env.OLLIBERTY_HOME = home;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'user-model', temperature: 0.9 }));
  fs.mkdirSync(path.join(workspace, '.olliberty'));
  fs.writeFileSync(
    path.join(workspace, '.olliberty', 'config.json'),
    JSON.stringify({ model: 'project-model', codeIndex: { maxFiles: 120 } })
  );

  const layered = new FileSettings(workspace);
  assert.strictEqual(layered.model, 'project-model');
  assert.strictEqual(layered.temperature, 0.9);
  assert.strictEqual(layered.codeIndexMaxFiles, 120);
  assert.strictEqual(layered.describeSource('model'), 'project');
  assert.strictEqual(layered.describeSource('temperature'), 'user');
  assert.strictEqual(layered.describeSource('maxTokens'), 'default');

  const overridden = new FileSettings(workspace, { model: 'flag-model' });
  assert.strictEqual(overridden.model, 'flag-model');
  assert.strictEqual(overridden.describeSource('model'), 'flag');

  /* Plan mode must keep gating writes even when autoApplyEdits is set. */
  const planned = new FileSettings(workspace, { mode: 'plan', autoApplyEdits: true });
  assert.strictEqual(planned.autoApplyEdits, false);
  const auto = new FileSettings(workspace, { mode: 'auto', autoApplyEdits: true });
  assert.strictEqual(auto.autoApplyEdits, true);

  await auto.setModel('written-model');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).model, 'written-model');
  delete process.env.OLLIBERTY_HOME;
});

test('every configurable key reports an effective value', () => {
  /* A key in CONFIG_KEYS with no entry in snapshot() used to print
     `undefined` in /config rather than failing anywhere visible. */
  const settings = new FileSettings(makeTempDir('olliberty-snapshot-'));
  const snapshot = settings.snapshot();

  for (const key of listConfigKeys()) {
    assert.ok(key in snapshot, `${key} is missing from FileSettings.snapshot()`);
    assert.notStrictEqual(snapshot[key as keyof typeof snapshot], undefined, `${key} resolves to undefined`);
  }

  assert.strictEqual(snapshot['agents.delegation'], 'auto');
  assert.strictEqual(snapshot.queueTimeoutMs, 600_000);
});

test('the network kill switch blocks non-allowed hosts', () => {
  const workspace = makeTempDir('olliberty-kill-');
  const settings = new FileSettings(workspace);
  settings.assertUrlAllowed('http://localhost:11434/api/generate');
  assert.throws(() => settings.assertUrlAllowed('http://example.com/api'), /kill switch/i);
});

test('diff hunks carry real line numbers and a standard header', () => {
  const before = Array.from({ length: 12 }, (_value, index) => `line ${index + 1}`).join('\n');
  const after = before.replace('line 8', 'line eight');
  const diff = computeFileDiff('demo.ts', before, after);

  assert.strictEqual(diff.additions, 1);
  assert.strictEqual(diff.removals, 1);
  assert.ok(diff.unified.startsWith('@@ -'));
  const removed = diff.hunks[0].lines.find(line => line.type === 'remove');
  const added = diff.hunks[0].lines.find(line => line.type === 'add');
  assert.strictEqual(removed?.oldLine, 8);
  assert.strictEqual(added?.newLine, 8);
});

test('markdown renders headings, lists, code and diffs inside the width', () => {
  const markdown = [
    '## Plan',
    '- first item',
    '1. numbered item',
    '',
    '```diff',
    '@@ -1,2 +1,2 @@',
    '-old line',
    '+new line',
    '```',
    '',
    '```ts',
    'const value = 1;',
    '```'
  ].join('\n');

  const lines = renderMarkdown(markdown, { width: 60, indent: '  ' });
  for (const line of lines) {
    assert.ok(stringWidth(line) <= 62, `"${line}" is ${stringWidth(line)} wide`);
  }

  const text = lines.join('\n');
  assert.ok(text.includes('Plan'));
  assert.ok(text.includes('• first item'));
  assert.ok(text.includes('1. numbered item'));
  /* The diff fence must become numbered gutter rows, not a plain code box. */
  assert.ok(/1\s+- old line/.test(text), text);
  assert.ok(/1\s+\+ new line/.test(text), text);
  assert.ok(text.includes('const value = 1;'));
});

/* ── sub-task panel ─────────────────────────────────────────────────── */

function fakeTasks(): AgentRunView[] {
  const startedAt = Date.now() - 5_000;
  return [
    { id: 'a', name: 'Context Scout', goal: 'Map relevant files.', status: 'completed', detail: 'Found 12 files.', chars: 2400, startedAt, endedAt: startedAt + 3_000 },
    { id: 'b', name: 'Implementation Agent', goal: 'Design the change.', status: 'running', chars: 800, startedAt },
    { id: 'c', name: 'Quality Agent', goal: 'Find edge cases.', status: 'failed', detail: 'model not found', startedAt, endedAt: startedAt + 200 },
    { id: 'synthesis', name: 'Synthesis', goal: 'Merge results.', status: 'queued' }
  ];
}

test('task panel rows are exactly the panel width, with and without colour', () => {
  const width = taskPanelWidth(120);
  for (const depth of ['none', 'truecolor'] as const) {
    setColorDepth(depth);
    const rows = renderTaskPanel(fakeTasks(), { width, tick: 4, maxRows: 20 });
    assert.ok(rows.length > 1, 'panel should render a header and task rows');
    for (const row of rows) {
      assert.strictEqual(stringWidth(row), width, `${depth} row: ${JSON.stringify(row)}`);
    }
  }
  setColorDepth('none');
});

test('task panel shrinks the blocks instead of hiding running sub-tasks', () => {
  const tasks = fakeTasks();
  const width = taskPanelWidth(100);
  const tight = renderTaskPanel(tasks, { width, tick: 0, maxRows: 5 });

  assert.ok(tight.length <= 5, `panel used ${tight.length} rows`);
  /* One row per task plus the header: every task still has a line. */
  assert.strictEqual(tight.length, tasks.length + 1);
  for (const task of tasks) {
    assert.ok(tight.some(row => row.includes(task.name)), `${task.name} missing from panel`);
  }
});

test('task panel bar advances with the tick so progress reads as live', () => {
  const running: AgentRunView[] = [
    { id: 'b', name: 'Implementation Agent', goal: 'Design the change.', status: 'running', chars: 800, startedAt: Date.now() }
  ];
  const width = taskPanelWidth(120);
  const first = renderTaskPanel(running, { width, tick: 0, maxRows: 10 })[2];
  const later = renderTaskPanel(running, { width, tick: 5, maxRows: 10 })[2];
  assert.notStrictEqual(first, later);
  assert.strictEqual(stringWidth(first), stringWidth(later));
});

test('composeColumns pads the body column so the panel starts at a fixed column', () => {
  const body = ['left', 'a much longer left line'];
  const panel = ['P1', 'P2', 'P3'];
  const lines = composeColumns(body, panel, 30, 2);

  assert.strictEqual(lines.length, 3);
  for (const line of lines) {
    assert.strictEqual(line.indexOf('P'), 32);
  }
  /* Body lines wider than the column are never truncated away silently. */
  assert.ok(lines[1].startsWith('a much longer left line'));
});

test('the split layout only kicks in when both columns fit', () => {
  assert.ok(!canSplitColumns(60));
  assert.ok(canSplitColumns(120));
  assert.ok(taskPanelWidth(120) + taskPanelBodyWidth(120) < 120);
});

/* ─────────────────────── delegated sub-agent runs ────────────────────── */

interface FakeCall {
  prompt: string;
  think?: boolean;
  numPredict?: number;
}

/** A stand-in Ollama that streams a scripted reply per call. */
function makeFakeClient(
  reply: (call: FakeCall, index: number) => string | Promise<string>
): { client: ConstructorParameters<typeof MultiAgentService>[0]; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const client = {
    async generate(params: {
      prompt: string;
      think?: boolean;
      numPredict?: number;
      onToken?: (chunk: string, full: string) => void;
    }): Promise<string> {
      const index = calls.length;
      calls.push({ prompt: params.prompt, think: params.think, numPredict: params.numPredict });
      const text = await reply({ prompt: params.prompt, think: params.think, numPredict: params.numPredict }, index);
      let full = '';
      for (const chunk of text.match(/.{1,8}/gs) ?? []) {
        full += chunk;
        params.onToken?.(chunk, full);
      }
      return full;
    },
    getCurrentModel: () => 'fake-model'
  } as unknown as ConstructorParameters<typeof MultiAgentService>[0];
  return { client, calls };
}

const fakeCodeIndex = {
  async buildPromptContext(): Promise<string> { return 'context'; }
} as unknown as ConstructorParameters<typeof MultiAgentService>[1];

const fakeActivity = {
  begin: () => 'step',
  update: () => undefined,
  succeed: () => undefined,
  fail: () => undefined,
  cancel: () => undefined,
  cancelRunning: () => undefined,
  info: () => undefined,
  run: async <T>(_label: string, task: (step: { update: (detail: string) => void }) => Promise<T>) =>
    task({ update: () => undefined }),
  reset: () => undefined,
  snapshot: () => [],
  hasRunningSteps: () => false
} as unknown as ConstructorParameters<typeof MultiAgentService>[2];

function fakeSettings(overrides: Record<string, unknown> = {}): ConstructorParameters<typeof MultiAgentService>[3] {
  return {
    model: 'fake-model',
    maxTokens: 2048,
    contextLength: 8192,
    timeoutMs: 90_000,
    queueTimeoutMs: 600_000,
    delegationMode: 'auto',
    agentsMaxCount: 5,
    agentsMaxParallel: 2,
    agentMaxTokens: 900,
    ...overrides
  } as unknown as ConstructorParameters<typeof MultiAgentService>[3];
}

const ROUTE_JSON = '{"fanOut":true,"reason":"needs three lenses","agents":["research","implementation","quality"]}';

test('the router splits a request and reports every task, synthesis included', async () => {
  const { client, calls } = makeFakeClient((call, index) =>
    index === 0 ? ROUTE_JSON : `findings for call ${index}`
  );

  const snapshots: DelegatedAgentProgress[][] = [];
  const service = new MultiAgentService(client, fakeCodeIndex, fakeActivity, fakeSettings());
  const result = await service.runDelegatedTask('add a right-hand task panel to the terminal UI', agents =>
    snapshots.push(agents)
  );

  /* The first snapshot lands before any agent call, so the task list is
     visible while the shared context is still being built. */
  assert.ok(snapshots.length >= 2);
  assert.deepStrictEqual(snapshots[0].map(task => task.id), [
    'research',
    'implementation',
    'quality',
    'synthesis'
  ]);

  const final = snapshots[snapshots.length - 1];
  assert.ok(final.every(task => task.status === 'completed'), 'every task should finish');
  assert.ok(final.every(task => (task.chars ?? 0) > 0), 'every task should report streamed characters');
  assert.ok(final.every(task => task.startedAt && task.endedAt), 'every task should be timed');

  /* Synthesis is reported, never returned as an agent. */
  assert.strictEqual(result.agents.length, 3);
  assert.ok(!result.agents.some(agent => agent.id === 'synthesis'));
  assert.ok(result.synthesis.startsWith('findings for call'));
  assert.strictEqual(result.decision.source, 'planner');

  /* One router call, three agents, one synthesis. */
  assert.strictEqual(calls.length, 5);
});

test('sub-agents run with reasoning off and the synthesis keeps it on', async () => {
  const { client, calls } = makeFakeClient((call, index) => (index === 0 ? ROUTE_JSON : 'ok'));
  const service = new MultiAgentService(client, fakeCodeIndex, fakeActivity, fakeSettings());
  await service.runDelegatedTask('refactor the settings layering so hosts cannot drift', () => undefined);

  const [router, ...rest] = calls;
  const synthesis = rest[rest.length - 1];
  const agents = rest.slice(0, -1);

  assert.strictEqual(router.think, false, 'routing is a classification, not a chat turn');
  assert.ok(agents.length > 0);
  assert.ok(agents.every(call => call.think === false), 'a sub-agent must not spend its budget on reasoning');
  assert.ok(agents.every(call => call.numPredict === 900));
  assert.strictEqual(synthesis.think, undefined, 'the answer the user reads keeps the model default');
  assert.strictEqual(synthesis.numPredict, 2048);
});

test('a fan-out never exceeds maxParallel in-flight agents', async () => {
  let inFlight = 0;
  let peak = 0;
  const client = {
    async generate(params: { prompt: string; onToken?: (chunk: string, full: string) => void }): Promise<string> {
      if (params.prompt.includes('You route one request')) {
        return '{"fanOut":true,"reason":"wide","agents":["research","context-scout","implementation","quality","security"]}';
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      params.onToken?.('x', 'x');
      return 'x';
    },
    getCurrentModel: () => 'fake-model'
  } as unknown as ConstructorParameters<typeof MultiAgentService>[0];

  const service = new MultiAgentService(client, fakeCodeIndex, fakeActivity, fakeSettings({ agentsMaxParallel: 2 }));
  const result = await service.runDelegatedTask('audit the whole transport layer end to end', () => undefined);

  assert.strictEqual(result.agents.length, 5);
  /* Ollama generates for one request at a time; an unbounded fan-out only
     buries the later agents in its queue. */
  assert.ok(peak <= 2, `at most 2 agents in flight, saw ${peak}`);
});

test('agents that are queued behind the pool report waiting, not running', async () => {
  const { client } = makeFakeClient(async (call, index) => {
    if (index === 0) {
      return '{"fanOut":true,"reason":"wide","agents":["research","context-scout","implementation","quality"]}';
    }
    await new Promise(resolve => setTimeout(resolve, 5));
    return 'ok';
  });

  const snapshots: DelegatedAgentProgress[][] = [];
  const service = new MultiAgentService(client, fakeCodeIndex, fakeActivity, fakeSettings({ agentsMaxParallel: 2 }));
  await service.runDelegatedTask('rework the plan gate across both hosts', agents => snapshots.push(agents));

  const sawWaiting = snapshots.some(snapshot =>
    snapshot.some(task => task.id !== 'synthesis' && task.status === 'waiting')
  );
  assert.ok(sawWaiting, 'a queued agent must read as waiting rather than looking hung');
});

test('a failed agent is retried once with a larger answer budget', async () => {
  let researchAttempts = 0;
  const { client } = makeFakeClient(call => {
    if (call.prompt.includes('You route one request')) {
      return ROUTE_JSON;
    }
    if (call.prompt.includes('You are the Research Agent')) {
      researchAttempts += 1;
      if (researchAttempts === 1) {
        throw new Error('Ollama did not start responding within 600s');
      }
      return 'recovered findings';
    }
    return 'ok';
  });

  const service = new MultiAgentService(client, fakeCodeIndex, fakeActivity, fakeSettings());
  const result = await service.runDelegatedTask('add RAM and CPU limits to the CLI', () => undefined);

  assert.strictEqual(researchAttempts, 2, 'the first failure should be retried');
  const research = result.agents.find(agent => agent.id === 'research');
  assert.strictEqual(research?.status, 'completed');
  assert.strictEqual(research?.attempt, 2);
});

test('one dead agent still yields an answer, and the others are named as covered', async () => {
  const { client } = makeFakeClient(call => {
    if (call.prompt.includes('You route one request')) {
      return ROUTE_JSON;
    }
    if (call.prompt.includes('You are the Quality Agent')) {
      throw new Error('Ollama: HTTP 500 Internal Server Error');
    }
    return 'usable findings';
  });

  const service = new MultiAgentService(client, fakeCodeIndex, fakeActivity, fakeSettings());
  const result = await service.runDelegatedTask('wire the queue timeout through both hosts', () => undefined);

  assert.ok(result.synthesis.trim(), 'a partial fan-out must still produce an answer');
  assert.strictEqual(result.agents.filter(agent => agent.status === 'failed').length, 1);
  assert.strictEqual(result.agents.filter(agent => agent.status === 'completed').length, 2);
});

test('a fan-out where every agent dies throws instead of inventing an answer', async () => {
  const { client } = makeFakeClient(call => {
    if (call.prompt.includes('You route one request')) {
      return ROUTE_JSON;
    }
    throw new Error('Ollama: HTTP 500 Internal Server Error');
  });

  const service = new MultiAgentService(client, fakeCodeIndex, fakeActivity, fakeSettings());
  await assert.rejects(
    () => service.runDelegatedTask('anything at all that needs real work', () => undefined),
    /Every sub-agent failed/
  );
});

test('delegation off answers in one pass, and /agents still overrides it', async () => {
  const { client, calls } = makeFakeClient((call, index) => (index === 0 ? ROUTE_JSON : 'ok'));
  const service = new MultiAgentService(client, fakeCodeIndex, fakeActivity, fakeSettings({ delegationMode: 'off' }));

  const decision = await service.decide('rework the whole transport layer for streaming');
  assert.strictEqual(decision.fanOut, false);
  assert.strictEqual(calls.length, 0, 'a disabled router must not cost a model call');

  const forced = await service.runDelegatedTask('rework the whole transport layer', () => undefined, { force: true });
  assert.ok(forced.agents.length >= 2, '/agents overrides the setting');
  assert.strictEqual(forced.decision.source, 'forced');
});

test('an unparseable router answer still splits the request', async () => {
  const { client } = makeFakeClient((call, index) => (index === 0 ? 'I think we should probably...' : 'ok'));
  const service = new MultiAgentService(client, fakeCodeIndex, fakeActivity, fakeSettings());

  const decision = await service.decide('add a --cpu-limit flag to the CLI and wire it through');
  assert.strictEqual(decision.fanOut, true, 'the router is an optimisation, never a gate');
  assert.strictEqual(decision.source, 'heuristic');
  assert.ok(decision.blueprints.length >= 2);
});

test('maxCount caps the split however many roles the router asks for', async () => {
  const { client } = makeFakeClient((call, index) =>
    index === 0
      ? '{"fanOut":true,"reason":"wide","agents":["research","context-scout","implementation","quality","security"]}'
      : 'ok'
  );
  const service = new MultiAgentService(client, fakeCodeIndex, fakeActivity, fakeSettings({ agentsMaxCount: 3 }));
  const decision = await service.decide('audit every layer of this project at once');
  assert.strictEqual(decision.blueprints.length, 3);
});

test('invented role ids are dropped rather than trusted', async () => {
  const { client } = makeFakeClient((call, index) =>
    index === 0 ? '{"fanOut":true,"agents":["research","wizard-agent","quality"]}' : 'ok'
  );
  const service = new MultiAgentService(client, fakeCodeIndex, fakeActivity, fakeSettings());
  const decision = await service.decide('please review the settings layering in detail');
  assert.deepStrictEqual(decision.blueprints.map(role => role.id), ['research', 'quality']);
});

test('trivial prompts skip the fan-out without asking the model', async () => {
  const { client, calls } = makeFakeClient(() => ROUTE_JSON);
  const service = new MultiAgentService(client, fakeCodeIndex, fakeActivity, fakeSettings());

  const decision = await service.decide('hi');
  assert.strictEqual(decision.fanOut, false);
  assert.strictEqual(calls.length, 0, 'a greeting must not cost a router call');

  assert.ok(isTrivialPrompt('thanks!'));
  assert.ok(isTrivialPrompt('   '));
  assert.ok(!isTrivialPrompt('why does the delegated run time out after 45 seconds'));
});

test('the heuristic reads questions about existing behaviour without planning a change', () => {
  assert.deepStrictEqual(heuristicRoleIds('does the CLI already support a CPU limit?'), [
    'research',
    'context-scout'
  ]);
  assert.ok(heuristicRoleIds('add a CPU limit to the CLI').includes('implementation'));
});

test('the answer footer names the agents and marks the ones that produced nothing', () => {
  const agents = [
    { id: 'research', name: 'Research Agent', goal: '', status: 'completed' as const },
    { id: 'quality', name: 'Quality Agent', goal: '', status: 'failed' as const }
  ];

  const footer = formatAgentFooter(agents);
  assert.match(footer, /2 agents/);
  assert.match(footer, /Research Agent/);
  assert.match(footer, /~~Quality Agent~~/, 'a dead agent must not read as a covered angle');
  assert.match(footer, /1 of 2 produced nothing/);

  assert.strictEqual(formatAgentFooter([]), '', 'a single-pass answer carries no footer');
});

/* ──────────────────────── the real Ollama client ─────────────────────── */

interface StubRequest {
  body: Record<string, unknown>;
}

/**
 * A local stand-in for the Ollama HTTP API, so the client's request shape and
 * stream handling are exercised for real rather than through a fake.
 */
async function withStubOllama(
  respond: (body: Record<string, unknown>, res: http.ServerResponse) => void,
  run: (client: OllamaClient, seen: StubRequest[]) => Promise<void>
): Promise<void> {
  const seen: StubRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      seen.push({ body });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      respond(body, res);
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const settings = {
    url: `http://127.0.0.1:${port}`,
    model: 'stub',
    systemPrompt: '',
    temperature: 0.2,
    maxTokens: 2048,
    contextLength: 4096,
    effort: 'high',
    timeoutMs: 5_000,
    queueTimeoutMs: 10_000,
    assertUrlAllowed: () => undefined
  } as unknown as ConstructorParameters<typeof OllamaClient>[0];

  try {
    await run(new OllamaClient(settings), seen);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function streamLines(res: http.ServerResponse, lines: Array<Record<string, unknown>>): void {
  for (const line of lines) {
    res.write(`${JSON.stringify(line)}\n`);
  }
  res.end();
}

test('sampling options go where Ollama actually reads them', async () => {
  await withStubOllama(
    (_body, res) => streamLines(res, [{ response: 'hi' }, { done: true, done_reason: 'stop' }]),
    async (client, seen) => {
      await client.generate({ prompt: 'anything', stream: true });
      const options = seen[0].body.options as Record<string, unknown>;
      /* A top-level `temperature` is accepted and silently ignored by Ollama,
         so the configured value only takes effect inside `options`. */
      assert.strictEqual(seen[0].body.temperature, undefined);
      assert.strictEqual(options.temperature, 0.2);
      assert.strictEqual(options.num_predict, 2048);
      assert.strictEqual(options.num_ctx, 4096);
    }
  );
});

test('per-request budgets and the reasoning switch reach the request body', async () => {
  await withStubOllama(
    (_body, res) => streamLines(res, [{ response: 'hi' }, { done: true, done_reason: 'stop' }]),
    async (client, seen) => {
      await client.generate({ prompt: 'anything', stream: true, think: false, numPredict: 900, numCtx: 8192 });
      const options = seen[0].body.options as Record<string, unknown>;
      assert.strictEqual(seen[0].body.think, false);
      assert.strictEqual(options.num_predict, 900);
      assert.strictEqual(options.num_ctx, 8192);

      /* `think` is omitted rather than sent as undefined when unset, so a
         model without the capability keeps its own default. */
      await client.generate({ prompt: 'anything', stream: true });
      assert.ok(!('think' in seen[1].body));
    }
  );
});

test('a reasoning-off call is not also told to reason', async () => {
  await withStubOllama(
    (_body, res) => streamLines(res, [{ response: 'hi' }, { done: true, done_reason: 'stop' }]),
    async (client, seen) => {
      await client.generate({ prompt: 'ROLE BRIEF', stream: true, think: false });
      await client.generate({ prompt: 'ORDINARY TURN', stream: true });

      assert.ok(
        !String(seen[0].body.prompt).includes('Reasoning effort:'),
        'think:false and "use deeper reasoning" are contradictory instructions'
      );
      assert.ok(String(seen[1].body.prompt).includes('Reasoning effort: high'));
    }
  );
});

test('reasoning tokens are reported separately and never join the answer', async () => {
  await withStubOllama(
    (_body, res) =>
      streamLines(res, [
        { thinking: 'let me think ' },
        { thinking: 'about it' },
        { response: 'the answer' },
        { done: true, done_reason: 'stop' }
      ]),
    async client => {
      let thinking = '';
      const answer = await client.generate({
        prompt: 'anything',
        stream: true,
        onThinking: (_chunk, full) => { thinking = full; }
      });
      assert.strictEqual(answer, 'the answer');
      assert.strictEqual(thinking, 'let me think about it');
    }
  );
});

test('a budget spent entirely on reasoning is an error, not a blank answer', async () => {
  await withStubOllama(
    (_body, res) =>
      streamLines(res, [{ thinking: 'thought and thought' }, { done: true, done_reason: 'length' }]),
    async client => {
      await assert.rejects(
        () => client.generate({ prompt: 'anything', stream: true }),
        (error: unknown) => {
          assert.ok(isEmptyAnswerError(error), 'callers must be able to retry this specifically');
          assert.strictEqual((error as EmptyAnswerError).doneReason, 'length');
          assert.ok((error as EmptyAnswerError).thinkingChars > 0);
          return true;
        }
      );
    }
  );
});

test('the prompt budget is sized from the real window, not a fixed constant', () => {
  /* Overflowing the window makes Ollama drop the front of the prompt — which
     is where the instructions are — so the budget must shrink with it. */
  assert.ok(promptCharBudget(4096, 2048) < promptCharBudget(8192, 2048));
  assert.ok(promptCharBudget(4096, 900) > promptCharBudget(4096, 2048));
  assert.ok(promptCharBudget(512, 2048) >= 1_000, 'a tiny window still leaves a usable floor');
});
