# Ollama Cursor VS Code Extension

Alternative code assistance in case you reach API limits.

## Description

This extension integrates with a local Ollama server to provide AI-powered code assistance directly within VS Code. It features both a traditional command-based interface and a modern chat widget similar to GitHub Copilot or Cursor's built-in assistant.

## Features

- **Chat Widget**: Persistent chat interface in the sidebar with conversation history
- **Inline Completions**: Ghost-text completions while typing
- **Command-based Interaction**: Quick Q&A through the command palette
- **Context-aware**: Automatically includes current file and selection context
- **Streaming Responses**: Real-time response streaming for better user experience

## Usage Instructions

### Chat Widget (Recommended)

1. Make sure you have the Ollama server running locally on `http://localhost:11434`.
2. Click the Ollama Assistant icon in the Activity Bar (left sidebar).
3. Use the chat interface to ask questions about your code.
4. The assistant will automatically include context from your current file and selection.

### Command Palette

1. Make sure you have the Ollama server running locally on `http://localhost:11434`.
2. Open a file in VS Code.
3. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac) to open the Command Palette.
4. Type `Ollama: Ask AI` and select the command.
5. Enter your question in the input box and press Enter.
6. The response from the Ollama model will be shown as a notification.

## Configuration

You can configure the following settings in your VS Code `settings.json`:

- `ollama.model`: The model name passed to the local Ollama daemon (default: `codellama`).
- `ollama.temperature`: The temperature value for the model (default: `0.2`, range: `0` to `1`).
- `ollama.maxTokens`: Maximum number of tokens to generate (default: `2048`, range: `1` to `8192`).
- `ollama.contextLength`: Maximum context length for conversations (default: `4096`, range: `512` to `8192`).

Example:

```json
{
  "ollama.model": "codellama",
  "ollama.temperature": 0.2,
  "ollama.maxTokens": 2048,
  "ollama.contextLength": 4096
}
```

## Commands

- `Ollama: Ask AI`: Open input box for quick questions
- `Ollama: Open Chat Widget`: Open the chat widget in the sidebar
- `Ollama: Clear Chat`: Clear the chat conversation history

## Requirements

- Node.js
- Ollama server running locally

## License

MIT
