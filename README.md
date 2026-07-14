# Ollama Cursor Extension

Transform your editor into an AI-powered coding assistant with local Ollama integration! This project provides a modern chat interface similar to GitHub Copilot, complete with context-aware responses and inline code completion.

## Supported IDEs

| IDE | What you install | Where |
|---|---|---|
| VS Code | The extension at the repository root, packaged as a `.vsix` | [Installation & Setup](#installation--setup) below |
| Cursor | The **same** `.vsix` — Cursor is a VS Code fork and uses the same extension format | [Installation & Setup](#installation--setup) below |
| IntelliJ IDEA | A separate JetBrains Platform plugin in [`intellij-plugin/`](intellij-plugin/) | [`intellij-plugin/README.md`](intellij-plugin/README.md) |

IntelliJ IDEA cannot run VS Code extensions, so it's a distinct Kotlin/Gradle
codebase that mirrors the same features (chat widget, Ask AI, OS-aware
installer, configurable model/temperature/tokens) against the same local
Ollama daemon.

## Features

- **🤖 Modern Chat Interface**: Beautiful webview-based chat widget similar to GitHub Copilot
- **📱 Multiple Access Points**: Available in both left sidebar and right panel (secondary sidebar)
- **🔄 Context-Aware Responses**: Automatically includes current file and selection context
- **⚡ Inline Code Completion**: Real-time code suggestions as you type
- **🎯 Smart Error Handling**: Comprehensive error handling with user-friendly messages
- **💻 OS-Specific Installation**: Automatic detection and installation guidance for Windows, macOS, and Linux
- **🔧 Highly Configurable**: Customizable model, temperature, and token settings

## Installation & Setup

### Prerequisites
This extension requires **Ollama** to be installed on your system. If Ollama is not installed, the extension will automatically detect your operating system and provide installation instructions.

### Extension Installation (VS Code and Cursor)

Until this is published to the VS Code Marketplace, install it from a locally built `.vsix`:

```bash
npm install
npx @vscode/vsce package    # produces ollama-cursor-<version>.vsix
```

Then, in **VS Code**:
```bash
code --install-extension ollama-cursor-<version>.vsix
```

Or in **Cursor** (same extension format, since Cursor is a VS Code fork):
```bash
cursor --install-extension ollama-cursor-<version>.vsix
```

Without CLI access, use the Extensions view's `...` menu → **Install from VSIX...**
in either editor. `setup.sh` automates the `code --install-extension` step for VS Code.

If Ollama is not installed, the extension will automatically detect your operating system and show installation prompts.

For **IntelliJ IDEA**, see [`intellij-plugin/README.md`](intellij-plugin/README.md) instead — it's a separate plugin build.

### Ollama Installation

The extension automatically detects when Ollama is not available and provides tailored installation instructions:

#### Windows
- **Automatic Detection**: Extension detects Windows and provides winget installation command
- **Installation Options**: 
  - Windows Package Manager: `winget install Ollama.Ollama`
  - Direct download from official website
- **Service Management**: Guidance on starting Ollama as a Windows service

#### macOS
- **Homebrew Installation**: `brew install ollama` (recommended)
- **Direct Download**: .dmg installer from official website
- **Terminal Integration**: Easy startup with `ollama serve`

#### Linux
- **One-line Installation**: `curl -fsSL https://ollama.com/install.sh | sh`
- **Manual Installation**: Binary download and setup instructions
- **Systemd Integration**: Service setup for automatic startup

### Model Setup
After installing Ollama, pull your desired model:
```bash
ollama pull codellama
# or
ollama pull llama2
ollama pull deepseek-coder
```

## Usage

### Chat Interface

#### Left Sidebar (Activity Bar)
- **Click** the 🤖 icon in the Activity Bar
- **Keyboard Shortcut**: `Ctrl+Shift+O` (Windows/Linux) or `Cmd+Shift+O` (macOS)
- **Command Palette**: "Ollama: Open Chat Widget"

#### Right Panel (Secondary Sidebar)
- **Click** the 🤖 icon in the secondary sidebar (next to Extensions, Commit Graph, etc.)
- **Keyboard Shortcut**: `Ctrl+Shift+Alt+O` (Windows/Linux) or `Cmd+Shift+Alt+O` (macOS)
- **Command Palette**: "Ollama: Open in Right Panel"

### Features

#### Context-Aware Responses
The extension automatically includes context from your current work:
- **Selected Code**: When you have text selected, it's included in your query
- **Current File**: For smaller files, the entire content is included for context
- **File Information**: File name and language are always included

#### Inline Code Completion
- **Automatic Suggestions**: Get code completions as you type
- **Context-Aware**: Suggestions based on your current code context
- **VS Code Integration**: Works seamlessly with VS Code's IntelliSense

#### Connection Status
- **Status Bar**: Shows Ollama connection status in the status bar
- **Visual Indicators**: Clear indication when Ollama is connected or disconnected
- **Installation Prompts**: Automatic installation guidance when Ollama is not available

### Commands

| Command | Description | Keyboard Shortcut |
|---------|-------------|-------------------|
| `Ollama: Ask AI` | Quick question in input box | - |
| `Ollama: Open Chat Widget` | Open chat in left sidebar | `Ctrl+Shift+O` |
| `Ollama: Open in Right Panel` | Open chat in right panel | `Ctrl+Shift+Alt+O` |
| `Ollama: Show Installation Instructions` | Show OS-specific installation guide | - |
| `Ollama: Clear Chat` | Clear chat history | - |

## Configuration

Configure the extension through VS Code settings:

```json
{
  "ollama.model": "codellama",
  "ollama.temperature": 0.2,
  "ollama.maxTokens": 2048,
  "ollama.contextLength": 4096
}
```

### Settings

- **`ollama.model`**: Model name (default: "codellama")
- **`ollama.temperature`**: Sampling temperature 0.0-1.0 (default: 0.2)
- **`ollama.maxTokens`**: Maximum tokens to generate (default: 2048)
- **`ollama.contextLength`**: Maximum context length (default: 4096)

## Troubleshooting

### Ollama Not Found
If you see "Ollama not found" messages:
1. **Automatic Installation**: The extension will show installation instructions for your OS
2. **Manual Installation**: Visit [ollama.com](https://ollama.com) for your platform
3. **Verify Installation**: Run `ollama --version` in your terminal

### Connection Issues
- **Service Not Running**: Start Ollama with `ollama serve`
- **Port Conflicts**: Check if port 11434 is available
- **Firewall**: Ensure your firewall allows localhost connections

### Status Bar Indicators
- **✅ Ollama Connected**: Everything is working
- **⚠️ Ollama Not Found**: Installation required
- **❌ Ollama Error**: Connection or service issues

### Common Solutions

#### Windows
- **Service Issues**: Check Windows Services for Ollama
- **Path Problems**: Ensure Ollama is in your PATH
- **Permissions**: Run as administrator if needed

#### macOS
- **Homebrew Issues**: Update Homebrew and try again
- **Permission Denied**: Check file permissions
- **Terminal Access**: Ensure terminal has necessary permissions

#### Linux
- **Systemd Service**: Enable and start Ollama service
- **Dependencies**: Install required dependencies (CUDA drivers for GPU)
- **User Permissions**: Ensure user has access to required resources

## Development

This repository contains two independent codebases:

- **Repository root** — the VS Code/Cursor extension (TypeScript, npm).
- **`intellij-plugin/`** — the IntelliJ IDEA plugin (Kotlin, Gradle). See [`intellij-plugin/README.md`](intellij-plugin/README.md).

### Building the VS Code/Cursor extension from Source
```bash
npm install
npm run compile
```

### Testing
```bash
npm test
```

### Building the IntelliJ plugin from Source
```bash
cd intellij-plugin
./gradlew buildPlugin
```

## Requirements

- **VS Code**: Version 1.85.0 or higher, **or Cursor** (any recent version — same extension format)
- **IntelliJ IDEA**: Version 2023.3 or higher (Community or Ultimate), via the separate plugin in `intellij-plugin/`
- **Ollama**: Latest version recommended
- **Node.js**: For building the VS Code/Cursor extension from source
- **JDK 17+**: For building the IntelliJ plugin from source

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Support

- **Issues**: Report bugs and request features on GitHub
- **Documentation**: Check the README and inline documentation
- **Community**: Join discussions in the repository

---

**Note**: This extension works entirely with your local Ollama installation. No data is sent to external servers, ensuring your code remains private and secure.
