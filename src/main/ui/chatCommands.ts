import { OllamaClient } from '../client';
import { isReasoningEffort } from '../settings';

function usageText(): string {
  return [
    '🛠️ **Available slash commands**',
    '',
    '- `/models` — list available local Ollama models',
    '- `/model` — show the current default model',
    '- `/model <name>` — switch the default model',
    '- `/effort` — show current reasoning effort',
    '- `/effort minimal|low|medium|high|max` — set reasoning effort',
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
        return '📦 No models found in Ollama. Pull one first, for example: `ollama pull gemma4:12b-it-qat`.';
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
