/*  Unit tests for the parts of the CLI that are easy to get subtly wrong:
 *  key decoding, the line editor, display width/wrapping, glob pruning,
 *  configuration layering, and markdown/diff rendering.
 *  Run with `npm run test:cli`.                                          */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { computeFileDiff } from '../../main/diff';
import { FileSettings } from '../config';
import { compileGlob } from '../glob';
import { extractMentions } from '../app';
import { setColorDepth, stringWidth, truncate, wrapLine } from '../tui/ansi';
import { computeCompletions } from '../tui/completion';
import { Composer } from '../tui/input';
import { KeyDecoder } from '../tui/keys';
import { renderMarkdown } from '../tui/markdown';

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
