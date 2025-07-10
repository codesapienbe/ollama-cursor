# Ollama Cursor VS Code Extension

Alternative code assistance in case you reach API limits.

## Description

This extension integrates with a local Ollama server to provide AI-powered code assistance directly within VS Code. It features both a traditional command-based interface and a modern chat widget similar to GitHub Copilot or Cursor's built-in assistant.

## Features

- **Chat Widget**: Persistent chat interface in the sidebar with conversation history
- **Right Panel Chat**: Chat widget in the secondary sidebar (right panel) next to Cursor AI
- **Inline Completions**: Ghost-text completions while typing
- **Command-based Interaction**: Quick Q&A through the command palette
- **Context-aware**: Automatically includes current file and selection context
- **Streaming Responses**: Real-time response streaming for better user experience

## Usage Instructions

### Chat Widget (Left Sidebar)

**Method 1: Activity Bar (Easiest)**
1. Make sure you have the Ollama server running locally on `http://localhost:11434`.
2. Look for the **🤖 (robot) icon** in the Activity Bar on the left side of VS Code
3. Click on it to open the "Ollama Assistant" sidebar
4. The chat widget will appear in the sidebar

**Method 2: Keyboard Shortcut**
1. Press `Ctrl+Shift+O` (Windows/Linux) or `Cmd+Shift+O` (Mac)
2. The chat widget will open automatically

**Method 3: Command Palette**
1. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
2. Type "Ollama: Open Chat Widget"
3. Select the command and press Enter

### Right Panel Chat (Secondary Sidebar)

**Method 1: Secondary Sidebar**
1. Look for the **🤖 (robot) icon** in the secondary sidebar (right panel)
2. Click on it to open the Ollama Chat in the right panel
3. This appears next to the Cursor AI assistant

**Method 2: Keyboard Shortcut**
1. Press `Ctrl+Shift+Alt+O` (Windows/Linux) or `Cmd+Shift+Alt+O` (Mac)
2. The right panel chat will open automatically

**Method 3: Command Palette**
1. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
2. Type "Ollama: Open in Right Panel"
3. Select the command and press Enter

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
- `Ollama: Open Chat Widget`: Open the chat widget in the left sidebar
- `Ollama: Open in Right Panel`: Open the chat widget in the right panel
- `Ollama: Clear Chat`: Clear the chat conversation history

## Keyboard Shortcuts

- `Ctrl+Shift+O` (Windows/Linux) / `Cmd+Shift+O` (Mac): Open Ollama Chat Widget (Left Sidebar)
- `Ctrl+Shift+Alt+O` (Windows/Linux) / `Cmd+Shift+Alt+O` (Mac): Open Ollama Chat in Right Panel

## Troubleshooting

### Widget Not Opening?
1. **Check Activity Bar**: Look for the 🤖 icon in the left sidebar
2. **Check Secondary Sidebar**: Look for the 🤖 icon in the right panel
3. **Use Keyboard Shortcuts**: 
   - `Ctrl+Shift+O` for left sidebar
   - `Ctrl+Shift+Alt+O` for right panel
4. **Command Palette**: Try "Ollama: Open Chat Widget" or "Ollama: Open in Right Panel"
5. **Reload Extension**: Press `Ctrl+Shift+P` → "Developer: Reload Window"

### Connection Issues?
- Ensure Ollama is running on `localhost:11434`
- Check if the specified model is installed: `ollama list`
- Restart Ollama if needed: `ollama serve`

## Requirements

- Node.js
- Ollama server running locally

## License

MIT
