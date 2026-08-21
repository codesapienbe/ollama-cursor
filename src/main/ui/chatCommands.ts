// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
import { OllamaClient } from '../client';
import { DEFAULT_MODEL, isReasoningEffort } from '../core/settingsContract';

function usageText(): string {
  return [
    '🛠️ **Available slash commands**',
    '',
    '- `/mode` — show the current execution mode',
    '- `/mode plan|auto` — plan first and wait for acceptance, or run immediately',
    '- `/plan <goal>` — draft a plan for review without running anything',
    '- `/accept` — accept the pending plan and execute it',
    '- `/discard` — discard the pending plan',
    '- `/activity` — show what Olliberty did on the last run and open the log',
    '- `/changes` — list every file written in this session',
    '- `/models` — list available local Ollama models',
    '- `/model` — show the current default model',
    '- `/model <name>` — switch the default model',
    '- `/effort` — show current reasoning effort',
    '- `/effort minimal|low|medium|high|max` — set reasoning effort',
    '- `/privacy` — show local privacy and network kill switch status',
    '- `/token <key> <value>` — store a secret token securely and reference it as `::KEY::`',
    '- `/token list` — list stored token keys (values are never shown)',
    '- `/token remove <key>` — delete a stored token',
    '- `/index` — build or refresh local workspace code index',
    '- `/index status` — show code index status',
    '- `/edit <instruction>` — generate file edits locally with in-editor diff preview',
    '- `/approve` — apply pending `/edit` changes',
    '- `/reject` — discard pending `/edit` changes',
    '- `/agents <goal>` — run delegated parallel sub-agents on the same model',
    '- `/path` — show current prompt file-scope root (defaults to active workspace root)',
    '- `/path <dir-or-file>` — scope chat context to a workspace-relative path',
    '- `/path reset` — clear scope override and go back to workspace root',
    '- `/note <text>` — save a note in the active session',
    '- `/note` — list notes for the active session',
    '- `/notes` — show all notes for the active session in markdown',
    '- `/graphify import` — import Graphify JSON from the opened project into local context DB',
    '- `/graphify status` — show imported Graphify context stats',
    '- `/sessions` — show conversation session overview',
    '- `/session current` — show active session details',
    '- `/session new` — start a new chat session',
    '- `/session load <session-id>` — switch to an existing session',
  ].join('\n');
}

export async function runChatSlashCommand(input: string, client: OllamaClient): Promise<string | null> {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const [commandToken, ...args] = trimmed.slice(1).split(/\s+/);
  const command = commandToken.toLowerCase();
  const argument = args.join(' ').trim();

  switch (command) {
    case 'models': {
      const models = await client.listModels();
      if (!models.length) {
        return `📦 No models found in Ollama. Pull one first, for example: \`ollama pull ${DEFAULT_MODEL}\`.`;
      }

      const current = client.getCurrentModel();
      const lines = models.map(model => `- \`${model}\`${model === current ? ' **(current)**' : ''}`);
      return [`📦 **Available models (${models.length})**`, '', ...lines].join('\n');
    }

    case 'model': {
      if (!argument) {
        return `🤖 **Current model:** \`${client.getCurrentModel()}\`\n\nUse \`/model <name>\` to switch, or \`/models\` to list all available models.`;
      }

      const availableModels = await client.listModels().catch((): string[] => []);
      if (availableModels.length > 0 && !availableModels.includes(argument)) {
        const suggestions = availableModels
          .filter(model => model.toLowerCase().includes(argument.toLowerCase()))
          .slice(0, 5);
        const suggestionText = suggestions.length ? `\n\nClosest matches:\n${suggestions.map(item => `- \`${item}\``).join('\n')}` : '';
        return `⚠️ Model \`${argument}\` is not in your local Ollama models. Run \`/models\` to see available models.${suggestionText}`;
      }

      await client.setModel(argument);
      return `✅ Default model switched to \`${argument}\`.`;
    }

    case 'effort': {
      if (!argument) {
        return `🧠 **Current effort:** \`${client.getEffort()}\`\n\nUse \`/effort minimal|low|medium|high|max\` to change it.`;
      }

      const normalized = argument.toLowerCase();
      if (!isReasoningEffort(normalized)) {
        return '⚠️ Unknown effort value. Use one of: `minimal`, `low`, `medium`, `high`, `max`.';
      }

      await client.setEffort(normalized);
      return `✅ Reasoning effort set to \`${normalized}\`.`;
    }

    case 'help':
      return usageText();

    default:
      return `⚠️ Unknown command: \`/${command}\`\n\n${usageText()}`;
  }
}
