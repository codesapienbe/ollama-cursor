#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  CLI entry point.
 *  Builds the same service graph the extension builds in its Container, then
 *  either starts the interactive TUI or runs a single request and exits.  */

import { OllamaClient } from '../main/client';
import { ConversationStore } from '../main/conversationStore';
import {
  AgentMode,
  DelegationMode,
  ReasoningEffort,
  isAgentMode,
  isDelegationMode,
  isReasoningEffort
} from '../main/core/settingsContract';
import { MultiAgentService } from '../main/multiAgentService';
import { PlanService } from '../main/planService';
import { TokenStore } from '../main/tokenStore';
import { CliActivityReporter } from './activity';
import { TuiApp } from './app';
import { FileCodeIndexStore } from './codeIndex';
import { FileSettings, SettingsOverrides } from './config';
import { CliEditService } from './editService';
import { activityLogPath, findWorkspaceRoot, resolveSqlJsWasmDir, shortenPath, userDataDir } from './paths';
import { FileSecretVault } from './secretVault';
import { AgentSession, SessionEvent } from './session';
import { setColorDepth } from './tui/ansi';
import { gradient, paint } from './tui/ansi';
import { renderMarkdown } from './tui/markdown';
import { wordmarkGradient } from './tui/theme';
import { secretsPath } from './paths';

interface ParsedArgs {
  command: 'chat' | 'run' | 'help' | 'version';
  prompt: string;
  overrides: SettingsOverrides;
  cwd: string;
  json: boolean;
  plain: boolean;
  errors: string[];
}

const SUBCOMMAND_TO_SLASH: Record<string, string> = {
  index: '/index',
  models: '/models',
  doctor: '/doctor',
  sessions: '/sessions',
  changes: '/changes',
  context: '/context',
  privacy: '/privacy',
  config: '/config'
};

function packageVersion(): string {
  try {
    return String(require('../../package.json').version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: 'chat',
    prompt: '',
    overrides: {},
    cwd: process.cwd(),
    json: false,
    plain: false,
    errors: []
  };

  const promptParts: string[] = [];
  let index = 0;
  let sawSubcommand = false;

  const next = (flag: string): string | undefined => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) {
      parsed.errors.push(`${flag} needs a value`);
      return undefined;
    }
    index += 1;
    return value;
  };

  while (index < argv.length) {
    const argument = argv[index];

    switch (argument) {
      case '-h':
      case '--help':
        parsed.command = 'help';
        break;
      case '-v':
      case '--version':
        parsed.command = 'version';
        break;
      case '-p':
      case '--prompt': {
        const value = next(argument);
        if (value) {
          promptParts.push(value);
          parsed.command = 'run';
        }
        break;
      }
      case '-m':
      case '--model': {
        const value = next(argument);
        if (value) {
          parsed.overrides.model = value;
        }
        break;
      }
      case '--url': {
        const value = next(argument);
        if (value) {
          parsed.overrides.url = value;
        }
        break;
      }
      case '--mode': {
        const value = next(argument);
        if (value) {
          if (isAgentMode(value)) {
            parsed.overrides.mode = value as AgentMode;
          } else {
            parsed.errors.push(`--mode must be plan or auto (got '${value}')`);
          }
        }
        break;
      }
      case '--effort': {
        const value = next(argument);
        if (value) {
          if (isReasoningEffort(value)) {
            parsed.overrides.effort = value as ReasoningEffort;
          } else {
            parsed.errors.push(`--effort must be minimal|low|medium|high|max (got '${value}')`);
          }
        }
        break;
      }
      case '-C':
      case '--cwd': {
        const value = next(argument);
        if (value) {
          parsed.cwd = value;
        }
        break;
      }
      case '-y':
      case '--yes':
        /* Scripted use: run immediately and write approved edits. */
        parsed.overrides.mode = 'auto';
        parsed.overrides.autoApplyEdits = true;
        break;
      case '--agents': {
        const value = next(argument);
        if (value) {
          if (isDelegationMode(value)) {
            parsed.overrides.delegation = value as DelegationMode;
          } else {
            parsed.errors.push(`--agents must be auto, always or off (got '${value}')`);
          }
        }
        break;
      }
      case '--no-agents':
        parsed.overrides.delegation = 'off';
        break;
      case '--no-color':
        setColorDepth('none');
        break;
      case '--no-stream':
        parsed.overrides.streamResponses = false;
        break;
      case '--no-index':
        parsed.overrides.autoIndexWorkspace = false;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--plain':
        parsed.plain = true;
        break;
      default:
        if (argument.startsWith('-')) {
          parsed.errors.push(`unknown option '${argument}'`);
          break;
        }
        if (!sawSubcommand && !promptParts.length) {
          sawSubcommand = true;
          if (argument === 'chat') {
            parsed.command = 'chat';
            break;
          }
          if (argument === 'help') {
            parsed.command = 'help';
            break;
          }
          if (argument === 'version') {
            parsed.command = 'version';
            break;
          }
          const slash = SUBCOMMAND_TO_SLASH[argument];
          if (slash) {
            parsed.command = 'run';
            promptParts.push(slash);
            break;
          }
        }
        promptParts.push(argument);
        parsed.command = 'run';
        break;
    }

    index += 1;
  }

  parsed.prompt = promptParts.join(' ').trim();
  if (parsed.command === 'run' && !parsed.prompt) {
    parsed.command = 'chat';
  }
  return parsed;
}

function helpText(version: string): string {
  const title = gradient('olliberty', wordmarkGradient);
  return [
    `${title} ${paint(`v${version}`, {})} — local, private AI coding agent on your Ollama LLM server`,
    '',
    'USAGE',
    '  olliberty                        start the interactive TUI',
    '  olliberty "<prompt>"             run one request and exit',
    '  olliberty -p "<prompt>"          same, explicit flag',
    '  olliberty <subcommand>           index | models | doctor | sessions | changes | context | privacy | config',
    '',
    'OPTIONS',
    '  -m, --model <name>     model to use for this run',
    '      --url <url>        Ollama LLM server URL (default http://localhost:11434)',
    '      --mode plan|auto   plan-first gate, or run immediately',
    '      --effort <level>   minimal | low | medium | high | max',
    '      --agents <mode>    auto | always | off — when a request is split across sub-agents',
    '      --no-agents        answer in one pass (same as --agents off)',
    '  -C, --cwd <dir>        treat this directory as the workspace',
    '  -y, --yes              auto mode and write approved edits without prompting',
    '      --no-stream        wait for the full response instead of streaming',
    '      --no-index         skip automatic workspace indexing',
    '      --no-color         disable colour output',
    '      --plain            print raw markdown instead of rendered output',
    '      --json             print one JSON object per transcript entry',
    '  -h, --help             show this help',
    '  -v, --version          show the version',
    '',
    'IN THE TUI',
    '  enter send · alt+enter newline · esc interrupt · shift+tab plan/auto',
    '  tab accept completion · @path attach a file · /help for every command',
    '',
    'CONFIG',
    `  user     ${shortenPath(`${userDataDir()}/config.json`)}`,
    '  project  <workspace>/.olliberty/config.json',
    '  env      OLLIBERTY_URL or OLLAMA_HOST, OLLIBERTY_MODEL, OLLIBERTY_MODE, OLLIBERTY_EFFORT,',
    '           OLLIBERTY_DELEGATION',
    '',
    'Free software under GPL-3.0-or-later, with no warranty. Source and licence:',
    '  https://github.com/codesapienbe/olliberty'
  ].join('\n');
}

interface Container {
  session: AgentSession;
  settings: FileSettings;
  client: OllamaClient;
  activity: CliActivityReporter;
  codeIndex: FileCodeIndexStore;
  conversationStore: ConversationStore;
  tokenStore: TokenStore;
  editService: CliEditService;
  workspaceRoot: string;
}

/** Mirrors the extension's Container, with file-backed hosts. */
function buildContainer(cwd: string, overrides: SettingsOverrides): Container {
  const workspaceRoot = findWorkspaceRoot(cwd);
  const settings = new FileSettings(workspaceRoot, overrides);
  const client = new OllamaClient(settings);
  const activity = new CliActivityReporter(activityLogPath(workspaceRoot));
  const codeIndex = new FileCodeIndexStore(settings, workspaceRoot);
  const editService = new CliEditService(client, codeIndex, activity, workspaceRoot);
  const multiAgentService = new MultiAgentService(client, codeIndex, activity, settings);
  const planService = new PlanService(client, codeIndex, activity);
  const conversationStore = new ConversationStore(userDataDir(), resolveSqlJsWasmDir());
  const secretVault = new FileSecretVault(secretsPath());
  const tokenStore = new TokenStore(secretVault);

  const session = new AgentSession({
    client,
    settings,
    codeIndex,
    editService,
    multiAgentService,
    planService,
    conversationStore,
    tokenStore,
    secretVault,
    activity,
    workspaceRoot
  });

  return {
    session,
    settings,
    client,
    activity,
    codeIndex,
    conversationStore,
    tokenStore,
    editService,
    workspaceRoot
  };
}

/** One-shot mode: print every transcript entry as it lands, then exit. */
async function runOnce(container: Container, prompt: string, options: { json: boolean; plain: boolean }): Promise<number> {
  const width = Math.max(40, Math.min(process.stdout.columns ?? 100, 120));
  const rendered = !options.plain && !options.json && Boolean(process.stdout.isTTY);
  let failed = false;

  const unsubscribe = container.session.on((event: SessionEvent) => {
    if (event.type !== 'message') {
      return;
    }

    const { role, content, timestamp } = event.message;
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ role, content, timestamp })}\n`);
      return;
    }
    if (role === 'user') {
      return;
    }
    if (rendered) {
      process.stdout.write(`${renderMarkdown(content, { width }).join('\n')}\n\n`);
      return;
    }
    process.stdout.write(`${content}\n\n`);
  });

  await container.session.initialize();
  if (!container.session.state().connected) {
    failed = true;
  }

  await container.session.submit(prompt);
  unsubscribe();
  container.activity.dispose();

  return failed ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const version = packageVersion();
  const args = parseArgs(argv);

  if (args.errors.length) {
    process.stderr.write(`${args.errors.map(error => `olliberty: ${error}`).join('\n')}\n\n`);
    process.stderr.write(`${helpText(version)}\n`);
    return 2;
  }

  if (args.command === 'help') {
    process.stdout.write(`${helpText(version)}\n`);
    return 0;
  }

  if (args.command === 'version') {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  const container = buildContainer(args.cwd, args.overrides);

  if (args.command === 'run') {
    return runOnce(container, args.prompt, { json: args.json, plain: args.plain });
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'olliberty: interactive mode needs a TTY. Pass a prompt instead, for example:\n  olliberty "explain src/main/client.ts"\n'
    );
    return 2;
  }

  const app = new TuiApp({
    session: container.session,
    settings: container.settings,
    client: container.client,
    activity: container.activity,
    codeIndex: container.codeIndex,
    conversationStore: container.conversationStore,
    tokenStore: container.tokenStore,
    editService: container.editService,
    workspaceRoot: container.workspaceRoot,
    version
  });

  return app.run();
}

if (require.main === module || process.env.OLLIBERTY_FORCE_MAIN === '1') {
  main(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      process.stderr.write(`olliberty: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
