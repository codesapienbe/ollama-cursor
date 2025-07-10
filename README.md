# Ollama Cursor VS Code Extension

Alternative code assistance in case you reach API limits.

## Description

This extension integrates with a local Ollama server to provide AI-powered code assistance directly within VS Code. It allows you to ask questions about your code and receive responses from a locally running Ollama model.

## Usage Instructions

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

Example:

```json
{
  "ollama.model": "codellama",
  "ollama.temperature": 0.2
}
```

## Requirements

- Node.js
- Ollama server running locally

## License

MIT
