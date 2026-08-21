// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Completion sources for the composer: slash commands, their argument
 *  values, and `@path` file mentions. Claude-Code-style: a popup above the
 *  input, Tab accepts, arrows move.                                      */

export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

export interface CompletionResult {
  items: CompletionItem[];
  /** Index range in the raw input that the accepted value replaces. */
  replaceStart: number;
  replaceEnd: number;
  /** Appended after acceptance (a space for commands, nothing for dirs). */
  suffix: string;
}

export interface CompletionContext {
  listModels: () => Promise<string[]>;
  listPaths: (fragment: string) => Promise<string[]>;
  listSessions: () => Promise<string[]>;
  listConfigKeys: () => string[];
  listTokenKeys: () => Promise<string[]>;
}

export interface CommandSpec {
  name: string;
  args?: string;
  description: string;
}

export const COMMANDS: CommandSpec[] = [
  { name: 'help', description: 'Show every command and key binding' },
  { name: 'mode', args: '[plan|auto]', description: 'Plan-first gate or immediate execution' },
  { name: 'plan', args: '<goal>', description: 'Draft a reviewable plan without running anything' },
  { name: 'accept', description: 'Accept the pending plan and execute it' },
  { name: 'discard', description: 'Discard the pending plan' },
  { name: 'edit', args: '<instruction>', description: 'Propose file edits with a diff preview' },
  { name: 'approve', description: 'Write the pending edit to disk' },
  { name: 'reject', description: 'Throw away the pending edit' },
  { name: 'changes', description: 'List every file written this session' },
  { name: 'diff', args: '<file>', description: 'Reprint the diff of an applied change' },
  { name: 'attach', args: '<path>', description: 'Attach a file as context' },
  { name: 'detach', args: '<path|all>', description: 'Remove attached context files' },
  { name: 'context', description: 'Show what the next request will carry' },
  { name: 'index', args: '[status]', description: 'Build or inspect the local code index' },
  { name: 'path', args: '[dir|reset]', description: 'Scope relative paths for this session' },
  { name: 'agents', args: '<goal>', description: 'Fan out parallel sub-agents' },
  { name: 'activity', description: 'Show what happened on the last run' },
  { name: 'models', description: 'List local Ollama models' },
  { name: 'model', args: '[name]', description: 'Show or switch the default model' },
  { name: 'effort', args: '[minimal|low|medium|high|max]', description: 'Reasoning effort preset' },
  { name: 'config', args: '[key] [value]', description: 'Inspect or set configuration' },
  { name: 'doctor', description: 'Check Ollama connectivity and installation' },
  { name: 'privacy', description: 'Kill switch, allowed hosts, token storage' },
  { name: 'token', args: '<key> <value>', description: 'Store a secret and use ::KEY:: in prompts' },
  { name: 'graphify', args: '[import|status]', description: 'Import a Graphify knowledge graph' },
  { name: 'sessions', description: 'List conversation sessions' },
  { name: 'session', args: '[current|new|load <id>]', description: 'Inspect or switch session' },
  { name: 'note', args: '[text]', description: 'Save or list session notes' },
  { name: 'notes', description: 'Show all notes for this session' },
  { name: 'clear', description: 'Start a new session' },
  { name: 'exit', description: 'Leave the CLI' }
];

const STATIC_ARGUMENTS: Record<string, CompletionItem[]> = {
  mode: [
    { value: 'plan', label: 'plan', description: 'Draft a plan and wait for acceptance' },
    { value: 'auto', label: 'auto', description: 'Run requests immediately' }
  ],
  effort: ['minimal', 'low', 'medium', 'high', 'max'].map(value => ({ value, label: value })),
  index: [{ value: 'status', label: 'status', description: 'Show index freshness' }],
  graphify: [
    { value: 'import', label: 'import', description: 'Import graphify-out/*.json' },
    { value: 'status', label: 'status', description: 'Show imported graph stats' }
  ],
  session: [
    { value: 'current', label: 'current' },
    { value: 'new', label: 'new' },
    { value: 'load', label: 'load' }
  ],
  detach: [{ value: 'all', label: 'all', description: 'Drop every attachment' }],
  path: [{ value: 'reset', label: 'reset', description: 'Back to the workspace root' }],
  token: [
    { value: 'list', label: 'list', description: 'List stored keys' },
    { value: 'remove', label: 'remove', description: 'Delete a stored key' }
  ]
};

function filterItems(items: CompletionItem[], fragment: string): CompletionItem[] {
  const needle = fragment.toLowerCase();
  if (!needle) {
    return items;
  }
  const starts = items.filter(item => item.value.toLowerCase().startsWith(needle));
  if (starts.length) {
    return starts;
  }
  return items.filter(item => item.value.toLowerCase().includes(needle));
}

/** Word under the cursor, delimited by whitespace. */
function wordAt(text: string, cursor: number): { value: string; start: number; end: number } {
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1])) {
    start -= 1;
  }
  let end = cursor;
  while (end < text.length && !/\s/.test(text[end])) {
    end += 1;
  }
  return { value: text.slice(start, cursor), start, end };
}

export async function computeCompletions(
  input: string,
  cursor: number,
  context: CompletionContext
): Promise<CompletionResult | null> {
  const word = wordAt(input, cursor);

  /* `@path` mentions work anywhere in the line. */
  if (word.value.startsWith('@')) {
    const fragment = word.value.slice(1);
    const paths = await context.listPaths(fragment);
    if (!paths.length) {
      return null;
    }
    return {
      items: paths.slice(0, 40).map(value => ({ value: `@${value}`, label: value })),
      replaceStart: word.start,
      replaceEnd: word.end,
      suffix: ''
    };
  }

  const commandMatch = /^\s*\/(\S*)(\s?)([\s\S]*)$/.exec(input);
  if (!commandMatch) {
    return null;
  }

  const [, commandToken, separator, rest] = commandMatch;

  /* Still typing the command itself. */
  if (!separator) {
    const items = filterItems(
      COMMANDS.map(command => ({
        value: `/${command.name}`,
        label: `/${command.name}${command.args ? ` ${command.args}` : ''}`,
        description: command.description
      })),
      `/${commandToken}`
    );
    return items.length
      ? { items, replaceStart: input.indexOf(`/${commandToken}`), replaceEnd: input.length, suffix: ' ' }
      : null;
  }

  const command = commandToken.toLowerCase();
  const argumentFragment = word.value;
  const isSecondWord = rest.trim().split(/\s+/).filter(Boolean).length <= 1;

  const staticItems = STATIC_ARGUMENTS[command];
  if (staticItems && isSecondWord) {
    const items = filterItems(staticItems, argumentFragment);
    return items.length
      ? { items, replaceStart: word.start, replaceEnd: word.end, suffix: ' ' }
      : null;
  }

  if (command === 'model' && isSecondWord) {
    const models = await context.listModels();
    const items = filterItems(models.map(value => ({ value, label: value })), argumentFragment);
    return items.length ? { items, replaceStart: word.start, replaceEnd: word.end, suffix: ' ' } : null;
  }

  if (command === 'config' && isSecondWord) {
    const items = filterItems(
      context.listConfigKeys().map(value => ({ value, label: value })),
      argumentFragment
    );
    return items.length ? { items, replaceStart: word.start, replaceEnd: word.end, suffix: ' ' } : null;
  }

  if (['attach', 'detach', 'diff', 'path'].includes(command)) {
    const paths = await context.listPaths(argumentFragment);
    const items = paths.slice(0, 40).map(value => ({ value, label: value }));
    return items.length ? { items, replaceStart: word.start, replaceEnd: word.end, suffix: '' } : null;
  }

  if (command === 'session' && rest.trim().toLowerCase().startsWith('load')) {
    const sessions = await context.listSessions();
    const items = filterItems(sessions.map(value => ({ value, label: value })), argumentFragment);
    return items.length ? { items, replaceStart: word.start, replaceEnd: word.end, suffix: ' ' } : null;
  }

  if (command === 'token' && rest.trim().toLowerCase().startsWith('remove')) {
    const keys = await context.listTokenKeys();
    const items = filterItems(keys.map(value => ({ value, label: value })), argumentFragment);
    return items.length ? { items, replaceStart: word.start, replaceEnd: word.end, suffix: ' ' } : null;
  }

  return null;
}
