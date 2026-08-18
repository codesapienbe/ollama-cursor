# Olliberty

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
- **📋 Plan-First by Default**: Every request is turned into a reviewable plan; nothing runs and no file is written until you accept it
- **⏹ Interruptible**: Stop any run mid-flight with `Esc` or the stop button — partial output is kept, and the socket to Ollama is closed so generation actually stops
- **🔎 Live Activity Feed**: A running list of every step — indexing, context retrieval, model calls, file writes — with durations, mirrored to the **Olliberty** output channel
- **⌨️ Streaming Output**: Model output appears token-by-token in the chat instead of after a silent wait
- **📄 Visible Changes**: Every proposed and applied edit is shown as an inline coloured diff plus a per-session **Changes** panel you can click to reopen any diff
- **🔄 Context-Aware Responses**: Automatically includes current file and selection context
- **📚 Local Code Index**: Maintains a local workspace index (`.olliberty/code-index.json`) for faster code-aware context
- **🗂️ Session-based Chat History**: Stores full chat conversations and per-session notes in a local SQLite database with active-session and historical overviews
- **🕸️ Graphify Context Import**: Ingests Graphify graph JSON from the opened project and uses structural graph context during chat prompts
- **⚡ Inline Code Completion**: Real-time code suggestions as you type
- **🛠️ Approval-First File Editing**: Use `/edit` to generate local file changes with in-IDE diff previews, then explicitly approve or reject
- **🤝 Delegated Parallel Agents**: Use `/agents <goal>` to split analysis into parallel sub-agents on the same local model and synthesize one final answer
- **🛡️ Network Kill Switch**: Restrict outbound plugin requests to an allowed host list for strict local privacy
- **🔐 Secret Scrubbing + Token Vault**: Sensitive values in chat are auto-redacted to `******`; store tokens via `/token` and reference them as placeholders
- **🎯 Smart Error Handling**: Comprehensive error handling with user-friendly messages
- **💻 OS-Specific Installation**: Automatic detection and installation guidance for Windows, macOS, and Linux
- **🔧 Highly Configurable**: Customizable model, temperature, and token settings

## Installation & Setup

### Prerequisites
Olliberty requires **Ollama** to be installed on your system. If Ollama is not installed, it will automatically detect your operating system and provide installation instructions.

### Extension Installation (VS Code and Cursor)

Until this is published to the VS Code Marketplace, install it from a locally built `.vsix`:

```bash
npm install
npx @vscode/vsce package    # produces olliberty-<version>.vsix
```

Then, in **VS Code**:
```bash
code --install-extension olliberty-<version>.vsix
```

Or in **Cursor** (same extension format, since Cursor is a VS Code fork):
```bash
cursor --install-extension olliberty-<version>.vsix
```

Without CLI access, use the Extensions view's `...` menu → **Install from VSIX...**
in either editor. `setup.sh` automates the `code --install-extension` step for VS Code.

If Ollama is not installed, Olliberty will automatically detect your operating system and show installation prompts.

For **IntelliJ IDEA**, see [`intellij-plugin/README.md`](intellij-plugin/README.md) instead — it's a separate plugin build.

### Ollama Installation

Olliberty automatically detects when Ollama is not available and provides tailored installation instructions:

#### Windows
- **Automatic Detection**: Detects Windows and provides winget installation command
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
ollama pull qwen3.8:latest
# or
ollama pull llama2
ollama pull deepseek-coder
```

## Usage

### Chat Interface

#### Left Sidebar (Activity Bar)
- **Click** the 🤖 icon in the Activity Bar
- **Keyboard Shortcut**: `Ctrl+Shift+O` (Windows/Linux) or `Cmd+Shift+O` (macOS)
- **Command Palette**: "Olliberty: Open Chat Widget"

#### Right Panel (Secondary Sidebar)
- **Click** the 🤖 icon in the secondary sidebar (next to Extensions, Commit Graph, etc.)
- **Keyboard Shortcut**: `Ctrl+Shift+Alt+O` (Windows/Linux) or `Cmd+Shift+Alt+O` (macOS)
- **Command Palette**: "Olliberty: Open in Right Panel"

### Features

#### Context-Aware Responses
Olliberty automatically includes context from your current work:
- **Selected Code**: When you have text selected, it's included in your query
- **Current File**: For smaller files, the entire content is included for context
- **File Information**: File name and language are always included
- **Workspace Scope by Default**: Relative paths are interpreted from the active workspace root unless you override with `/path`

#### Inline Code Completion
- **Automatic Suggestions**: Get code completions as you type
- **Context-Aware**: Suggestions based on your current code context
- **VS Code Integration**: Works seamlessly with VS Code's IntelliSense

#### Connection Status
- **Status Bar**: Shows Ollama connection status in the status bar
- **Visual Indicators**: Clear indication when Ollama is connected or disconnected
- **Installation Prompts**: Automatic installation guidance when Ollama is not available

#### Plan-First Mode (default)

Olliberty ships in `plan` mode. A normal chat request is answered in two phases:

1. **Plan** — Olliberty drafts a numbered plan: what it will do, which files it expects to touch, and the risks. Nothing has run at this point.
2. **Accept** — press **✅ Accept plan** (or send `/accept`) and it executes. Discard it with **✖ Discard** (or `/discard`).

If the accepted plan touches files, execution produces an edit proposal with inline diffs and in-IDE diff previews — those still need a *separate* **Apply pending edit** approval before anything is written. `olliberty.autoApplyEdits` is deliberately ignored while in plan mode.

Switch to immediate execution with the **⚡ Auto** chip in the chat header, `/mode auto`, or the *Olliberty: Toggle Plan-First Mode* command.

#### Seeing What Olliberty Is Doing

While a request runs, the **Working** panel above the transcript lists each step live:

```
● Building plan context        120ms
  ⎿ 8,412 chars of indexed context
● Drafting plan                 4.2s
  ⎿ 1,180 chars drafted
● Writing src/main/client.ts     18ms
  ⎿ +12 -3
```

Running steps pulse, finished steps show their duration, failed steps turn red with the error. The header shows the active model and mode. The same feed is written to the **Olliberty** output channel — open it with the **Log** chip, `/activity`, or *Olliberty: Show Activity Log* — so you have a durable record after the panel clears.

#### Stopping a Run

While anything is running, the send button turns into a red **■** stop control and the composer shows *Press `Esc` to stop*. Either one interrupts immediately:

- The HTTP socket to Ollama is destroyed, so the model actually stops generating rather than continuing in the background.
- **Partial output is kept.** Whatever streamed before you stopped stays in the transcript, marked *Stopped by you — partial response above*.
- Interrupted steps show as `⏹` in the activity feed instead of silently vanishing.
- Nothing is written to disk by a stopped run. Stopping during planning leaves no plan; stopping during edit generation leaves no proposal.

You can also stop from the view title bar or via *Olliberty: Stop* in the Command Palette. Note that local filesystem work (`/index`, `/graphify import`) has no interruption point — Olliberty tells you so rather than ignoring the click.

#### Seeing the Changes

- Proposed edits are printed in the transcript as coloured diffs with per-file `+`/`−` counts, alongside the in-IDE diff previews.
- Applied edits are printed the same way, so the transcript records exactly what was written.
- The **Changes** panel lists every file written in the session; click any entry to reopen its before/after diff. `/changes` prints the same list.

### Commands

| Command | Description | Keyboard Shortcut |
|---------|-------------|-------------------|
| `Olliberty: Ask AI` | Quick question in input box | - |
| `Olliberty: Open Chat Widget` | Open chat in left sidebar | `Ctrl+Shift+O` |
| `Olliberty: Open in Right Panel` | Open chat in right panel | `Ctrl+Shift+Alt+O` |
| `Olliberty: Show Installation Instructions` | Show OS-specific installation guide | - |
| `Olliberty: Stop` | Interrupt the current run | `Esc` (inside the chat panel) |
| `Olliberty: Show Activity Log` | Open the output channel with every step taken | - |
| `Olliberty: Toggle Plan-First Mode` | Switch between `plan` and `auto` execution | - |
| `Clear Chat` | Clear chat history | - |

## Configuration

Configure Olliberty through VS Code settings:

```json
{
  "olliberty.url": "http://localhost:11434",
  "olliberty.model": "qwen3.8:latest",
  "olliberty.mode": "plan",
  "olliberty.showActivityFeed": true,
  "olliberty.streamResponses": true,
  "olliberty.effort": "medium",
  "olliberty.systemPrompt": "",
  "olliberty.temperature": 0.2,
  "olliberty.maxTokens": 2048,
  "olliberty.contextLength": 4096,
  "olliberty.autoApplyEdits": false,
  "olliberty.codeIndex.autoIndexWorkspace": true,
  "olliberty.codeIndex.maxFiles": 500,
  "olliberty.codeIndex.maxFileSizeKb": 256,
  "olliberty.codeIndex.previewLines": 35,
  "olliberty.codeIndex.staleAfterMinutes": 10,
  "olliberty.privacy.networkKillSwitchEnabled": true,
  "olliberty.privacy.allowedHosts": ["localhost", "127.0.0.1", "::1"]
}
```

### Settings

- **`olliberty.url`**: Base URL of the Ollama server (default: "http://localhost:11434")
- **`olliberty.model`**: Model name sent to the Ollama daemon (default: "qwen3.8:latest")
- **`olliberty.mode`**: `plan` (draft a plan and wait for acceptance) or `auto` (run immediately). Default: `plan`
- **`olliberty.showActivityFeed`**: Show the live step-by-step activity panel (default: `true`)
- **`olliberty.streamResponses`**: Render model output token-by-token (default: `true`)
- **`olliberty.effort`**: Response depth preset (`minimal`, `low`, `medium`, `high`, `max`; default: `medium`)
- **`olliberty.systemPrompt`**: System prompt sent with every request (default: empty, i.e. none)
- **`olliberty.temperature`**: Sampling temperature 0.0-1.0 (default: 0.2)
- **`olliberty.maxTokens`**: Maximum tokens to generate (default: 2048)
- **`olliberty.contextLength`**: Maximum context length (default: 4096)
- **`olliberty.autoApplyEdits`**: If `true`, `/edit` proposals are written immediately without explicit approval (default: `false`). Ignored while `olliberty.mode` is `plan`
- **`olliberty.codeIndex.*`**: Controls local workspace indexing size, freshness, and exclusions
- **`olliberty.privacy.networkKillSwitchEnabled`**: If enabled, outbound plugin calls are blocked unless host is allowed
- **`olliberty.privacy.allowedHosts`**: Allowlist used by the kill switch (default: localhost-only)

### Chat slash commands

Inside the chat widget, you can control model selection without opening settings:

- `/mode` → show the current execution mode
- `/mode plan|auto` → plan first and wait for acceptance, or run immediately
- `/plan <goal>` → draft a plan for review without running anything
- `/accept` → accept the pending plan and execute it
- `/discard` → discard the pending plan
- `/activity` → show what Olliberty did on the last run and open the log
- `/changes` → list every file written in this session
- `/models` → list local Ollama models from `GET /api/tags`
- `/model` → show current default model
- `/model <name>` → switch default model (persists to your Olliberty settings)
- `/effort` → show current reasoning effort
- `/effort minimal|low|medium|high|max` → switch reasoning effort
- `/privacy` → show kill switch + allowed hosts
- `/token <key> <value>` → securely store a token (value is never echoed back)
- `/token list` → list stored token keys
- `/token remove <key>` → delete a stored token
- `/index` → build/refresh local code index
- `/index status` → inspect code index state
- `/edit <instruction>` → generate local file edits and open in-IDE diff previews
- `/approve` → apply pending `/edit` proposal
- `/reject` → discard pending `/edit` proposal
- `/agents <goal>` → run delegated parallel sub-agents and synthesize one final response
- `/path` → show current chat path scope (defaults to active workspace root)
- `/path <dir-or-file>` → scope chat context to a workspace-relative location
- `/path reset` → clear override and return to workspace root scope
- `/note <text>` → save a note in the active session
- `/note` → list notes in the active session
- `/notes` → show all notes for the active session in markdown
- `/graphify import` → import Graphify JSON under the opened project (`<project>/graphify-out/*.json`) into local context DB
- `/graphify status` → inspect imported Graphify context stats
- `/sessions` → show the active and past session overview
- `/session current` → show active session details
- `/session new` → start a fresh session
- `/session load <session-id>` → switch to a past session

Secret handling rule:
- Raw secrets pasted into chat are automatically scrubbed to `******`
- If you intentionally want to inject a stored token into a prompt, use `::KEY::` placeholders after setting it with `/token KEY value`

The IntelliJ IDEA plugin exposes the same options under **Settings/Preferences → Tools → Olliberty**.

## Troubleshooting

### Ollama Not Found
If you see "Ollama not found" messages:
1. **Automatic Installation**: Olliberty will show installation instructions for your OS
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

### Installing your local build

`make install` only *builds* artifacts — it does not install anything into an editor. Use these targets instead:

```bash
make install-vscode      # package the VSIX and install it into VS Code
make install-cursor      # same, into Cursor
make reinstall-vscode    # uninstall first, then install (use when the version is unchanged)
make uninstall-vscode    # remove the installed extension
```

Reload the editor window afterwards (*Developer: Reload Window*) — installing does not restart the running extension host.

The targets locate the editor CLI on `PATH` and fall back to the macOS app bundle. If neither works, point them at it explicitly:

```bash
make install-vscode VSCODE_BIN=/path/to/code
```

The VSIX filename is derived from `package.json`, so these keep working after `make bump-plugin-versions`.

For day-to-day development, `make run-vscode` launches an Extension Development Host straight from source — no install or reload cycle.

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

**Note**: Olliberty works entirely with your local Ollama installation. No data is sent to external servers, ensuring your code remains private and secure.
