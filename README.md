# Olliberty

Transform your editor — or your terminal — into an AI-powered coding assistant with a local Ollama LLM server! This project provides a modern chat interface similar to GitHub Copilot, complete with context-aware responses and inline code completion, plus a full-screen terminal UI for people who live in the shell.

## Supported surfaces

| Surface | What you install | Where |
|---|---|---|
| VS Code | The extension at the repository root, packaged as a `.vsix` | [Installation & Setup](#installation--setup) below |
| Cursor | The **same** `.vsix` — Cursor is a VS Code fork and uses the same extension format | [Installation & Setup](#installation--setup) below |
| IntelliJ IDEA | A separate JetBrains Platform plugin in [`intellij-plugin/`](intellij-plugin/) | [`intellij-plugin/README.md`](intellij-plugin/README.md) |
| Terminal | The `olliberty` CLI — a TUI built from the same engine as the plugin | [Olliberty CLI](#olliberty-cli) below |

IntelliJ IDEA cannot run VS Code extensions, so it's a distinct Kotlin/Gradle
codebase that mirrors the same features (chat widget, Ask AI, OS-aware
installer, configurable model/temperature/tokens) against the same local
Ollama LLM server.

The CLI is not a reimplementation: it imports the same plan gate, edit
proposal contract, code index, secret scrubber, conversation store, and
multi-agent runner the extension uses, and swaps only the host-specific
pieces (configuration source, filesystem access, secret storage, rendering).
Behaviour that matters — plan-first by default, no file written without an
explicit approval, the local-only network kill switch — is the same code in
both.

## Features

- **🖥️ Terminal UI**: A full `olliberty` CLI with the same engine — plan gate, diffs, live sub-task side panel, activity feed (see [Olliberty CLI](#olliberty-cli))
- **🤖 Modern Chat Interface**: Beautiful webview-based chat widget similar to GitHub Copilot
- **📱 Multiple Access Points**: Available in both left sidebar and right panel (secondary sidebar)
- **📋 Plan-First by Default**: Every request is turned into a reviewable plan; nothing runs and no file is written until you accept it
- **⏹ Interruptible**: Stop any run mid-flight with `Esc` or the stop button — partial output is kept, and the socket to the Ollama LLM server is closed so generation actually stops
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

## Olliberty CLI

A terminal client with the same engine as the plugin: plan-first by default,
diffs before writes, live activity, delegated sub-agents, and the shared
`.olliberty/code-index.json`.

### Install

```bash
npm install
npm run compile          # builds the extension and the CLI
npm link                 # puts `olliberty` on your PATH
```

`make install` does this as part of installing everything (extension + CLI) in
one step; `make uninstall` reverses both. To run the CLI without linking it:

```bash
npm run cli -- --help
node ./bin/olliberty.js "explain src/main/client.ts"
```

### First run

```bash
cd ~/your-project
olliberty
```

You get a gradient wordmark, a boxed composer, and a status bar showing the
workspace, git branch, model, reasoning effort, mode, and Ollama LLM server connectivity.

```
 ███  █     █     █████ ████  █████ ████  █████ █   █
█   █ █     █       █   █   █ █     █   █   █    █ █
█   █ █     █       █   ████  ████  ████    █     █
█   █ █     █       █   █   █ █     █  █    █     █
 ███  █████ █████ █████ ████  █████ █   █   █     █

╭──────────────────────────────────────────────────────────────╮
│ › Ask anything, or /help for commands                        │
╰──────────────────────────────────────────────────────────────╯
  ~/your-project · ⎇ main · qwen3.8:latest · medium    plan  ● ollama
```

### Keys

| Key | Action |
|---|---|
| `Enter` | Send |
| `Alt+Enter`, or `\` then `Enter` | Newline (multi-line prompts) |
| `Esc` | Interrupt the running turn — partial output is kept |
| `Shift+Tab` | Toggle plan / auto mode |
| `Tab` | Accept the highlighted completion |
| `↑` / `↓` | History (or move between lines of a multi-line prompt) |
| `Ctrl+A` / `Ctrl+E` | Start / end of line |
| `Ctrl+W`, `Ctrl+U`, `Ctrl+K` | Delete word back, to line start, to line end |
| `Ctrl+L` | Redraw |
| `Ctrl+C` | Clear the draft; twice on an empty prompt exits |
| `Ctrl+D` | Exit |

Completions open as you type: `/` lists commands with descriptions, and
argument positions complete model names, config keys, session ids, token keys,
and paths. Mention files inline with `@src/main/client.ts` to attach them as
context — the CLI's equivalent of the plugin's "active editor" context.

### What the output looks like

- **Plans** render as numbered steps with the files they expect to touch and the risks the model flagged. Nothing runs until `/accept`.
- **Diffs** render as file panels with real line numbers, hunk headers, and tinted add/remove rows — for proposals, for applied changes, and for any fenced `diff` block in a model reply.
- **Sub-agents** render as a live tree with per-agent status and detail while they run in parallel.
- **Activity** shows every step (indexing, context retrieval, model calls, per-file writes) with durations while a turn is in flight, and is mirrored to `.olliberty/cli-activity.log`.

### Commands

`/help` lists everything. The CLI understands every slash command the chat
widget does — `/mode`, `/plan`, `/accept`, `/discard`, `/edit`, `/approve`,
`/reject`, `/changes`, `/activity`, `/index`, `/path`, `/agents`, `/models`,
`/model`, `/effort`, `/privacy`, `/token`, `/graphify`, `/sessions`,
`/session`, `/note`, `/notes` — plus a few that only make sense in a terminal:

| Command | What it does |
|---|---|
| `/diff <file>` | Reprint the diff of a change applied this session |
| `/attach <path>` / `/detach <path\|all>` | Manage attached context files |
| `/context` | Show exactly what the next request will carry |
| `/config [key] [value]` | Inspect effective configuration and where each value came from, or write one to your user config |
| `/doctor` | Check the Ollama LLM server, the configured model, and print install instructions if it is missing |
| `/clear`, `/exit` | Start a new session, leave the CLI |

### Non-interactive use

```bash
olliberty "why does the code index skip binary files?"   # one request, then exit
olliberty -p "summarise src/cli/session.ts" --plain      # raw markdown, pipe-friendly
olliberty --json "list the slash commands" | jq -r .content
olliberty index                                          # rebuild the code index
olliberty models | olliberty doctor | olliberty sessions
```

One-shot runs honour the configured mode, so in the default plan mode you get
a plan rather than an answer. Pass `--mode auto` for a direct answer, or `-y`
to run immediately **and** write approved edits without prompting:

```bash
olliberty -y "/edit add a subtract function to math.js"
```

`-y` is the only way to get a file written without a human approval step, and
it exists for scripting. Interactive sessions always show the diff first.

Options: `-m/--model`, `--url`, `--mode plan|auto`, `--effort`, `-C/--cwd`,
`-y/--yes`, `--no-stream`, `--no-index`, `--no-color`, `--plain`, `--json`,
`-h/--help`, `-v/--version`.

### Configuration

Settings are the same keys as the VS Code settings, layered lowest to highest:

1. defaults
2. `~/.olliberty/config.json` (user)
3. `<workspace>/.olliberty/config.json` (project, commit it to share with your team)
4. environment — `OLLIBERTY_URL` or `OLLAMA_HOST`, `OLLIBERTY_MODEL`, `OLLIBERTY_MODE`, `OLLIBERTY_EFFORT`
5. command-line flags

```json
{
  "model": "qwen3.8:latest",
  "mode": "plan",
  "effort": "medium",
  "timeoutMs": 180000,
  "codeIndex": { "maxFiles": 800 },
  "privacy": { "allowedHosts": ["localhost", "127.0.0.1", "::1"] }
}
```

`/config <key> <value>` and `/model`, `/mode`, `/effort` write to the user
config file — the CLI's equivalent of the extension writing to global
settings. `OLLIBERTY_HOME` relocates the whole user directory, which is handy
for throwaway or per-project state.

`timeoutMs` is worth raising (it defaults to 45 s, matching the plugin) if you
run `/agents` against a large model: three sub-agents plus a synthesis pass
contend for the same Ollama LLM server, and a slow first token can otherwise time
one of them out.

While `/agents` runs, the sub-tasks get their own column on the right of the
frame: one coloured block per task — spinner, elapsed time, streamed character
count, and a bar that sweeps while that task is generating — with the synthesis
pass listed as the last task. Each task keeps its colour for the whole run, so
parallel work is easy to tell apart at a glance. Below 76 columns there is no
room for two columns and the sub-agent tree is stacked above the composer
instead.

### State, and what is shared with the IDE

| Path | Contents |
|---|---|
| `<workspace>/.olliberty/code-index.json` | Local code index — **shared with the plugin**, either side can build it |
| `<workspace>/.olliberty/config.json` | Project configuration |
| `<workspace>/.olliberty/cli-activity.log` | Durable activity log (the CLI's output channel) |
| `~/.olliberty/config.json` | User configuration |
| `~/.olliberty/conversations.db` | Sessions, messages, notes, imported Graphify graphs (SQLite) |
| `~/.olliberty/history` | Prompt history |
| `~/.olliberty/secrets.json` | `/token` values |

One honest caveat: the plugin stores `/token` secrets in the OS keychain
through VS Code's `SecretStorage`. A CLI has no keychain to talk to, so those
values live in `~/.olliberty/secrets.json` with owner-only file permissions
(`0600`) and are **not encrypted at rest**. `/privacy` and `/token` both say
so. The network kill switch still applies: outbound requests are restricted to
`privacy.allowedHosts`, which by default is localhost only.

## Installation & Setup

### Prerequisites
Olliberty requires the **Ollama LLM server** to be installed on your system. If Ollama is not installed, it will automatically detect your operating system and provide installation instructions.

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

- The HTTP socket to the Ollama LLM server is destroyed, so the model actually stops generating rather than continuing in the background.
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

- **`olliberty.url`**: Base URL of the Ollama LLM server (default: "http://localhost:11434")
- **`olliberty.model`**: Model name sent to the Ollama LLM server (default: "qwen3.8:latest")
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
- **Systemd Service**: Enable and start the Ollama LLM server
- **Dependencies**: Install required dependencies (CUDA drivers for GPU)
- **User Permissions**: Ensure user has access to required resources

## Development

This repository contains two independent codebases:

- **Repository root** — the VS Code/Cursor extension **and** the CLI (TypeScript, npm). They share everything under [`src/main/core/`](src/main/core/) plus the client, diff, plan, and multi-agent modules; `src/main/ui/` is IDE-only and `src/cli/` is terminal-only.
- **`intellij-plugin/`** — the IntelliJ IDEA plugin (Kotlin, Gradle). See [`intellij-plugin/README.md`](intellij-plugin/README.md).

### Building from source
```bash
npm install
npm run compile             # extension + CLI
npm run compile:extension   # extension only  (out/main)
npm run compile:cli         # CLI only        (out/cli)
npm run watch:cli           # CLI in watch mode
```

### Installing your local build

```bash
make install             # build everything, then install the extension and the CLI
```

`make install` builds every artifact and installs all three surfaces:

- the **VSIX** into whichever of VS Code and Cursor it finds (an editor that is not installed is skipped rather than failing the run);
- the **IntelliJ plugin**, unpacked into every IntelliJ IDEA configuration directory it detects (`~/Library/Application Support/JetBrains/<Product><Version>/plugins` on macOS, `~/.local/share/JetBrains/…` on Linux) — the same thing *Install Plugin from Disk…* does. Point it somewhere specific with `make install JETBRAINS_PLUGIN_DIR=/path/to/plugins`, and if no IDE directory is found it prints the manual instructions instead;
- the **CLI**, linked onto your PATH.

For narrower steps:

```bash
make install-vscode      # package the VSIX and install it into VS Code only
make install-cursor      # same, into Cursor only
make install-intellij    # build and unpack the IntelliJ plugin only
make reinstall-vscode    # uninstall first, then install (use when the version is unchanged)
make uninstall           # remove the extension, the IntelliJ plugin, and the CLI link
make uninstall-vscode    # remove only the installed extension
make uninstall-intellij  # remove only the IntelliJ plugin
make uninstall-cli       # remove only the CLI link
```

Afterwards: reload the editor window in VS Code/Cursor (*Developer: Reload Window*) and **restart IntelliJ IDEA** — neither host picks up a new build on its own.

To produce distributable artifacts for all three surfaces at once:

```bash
make bundle              # bumps versions, then writes dist/
```

`dist/` ends up holding the `.vsix` (VS Code and Cursor), the IntelliJ plugin
`.zip`, and an npm tarball of the CLI, and the target prints the install command
for each — including `npm install -g dist/olliberty-<version>.tgz`.

The targets locate the editor CLI on `PATH` and fall back to the macOS app bundle. If neither works, point them at it explicitly:

```bash
make install-vscode VSCODE_BIN=/path/to/code
```

The VSIX filename is derived from `package.json`, so these keep working after `make bump-plugin-versions`.

For day-to-day development, `make run-vscode` launches an Extension Development Host straight from source — no install or reload cycle.

### Testing
```bash
npm test        # extension tests, in a VS Code test host
npm run test:cli  # CLI unit tests (node:test) — key decoding, editor, wrapping, config, rendering
```

### Building the IntelliJ plugin from Source
```bash
cd intellij-plugin
./gradlew buildPlugin
```

## Requirements

- **VS Code**: Version 1.85.0 or higher, **or Cursor** (any recent version — same extension format)
- **IntelliJ IDEA**: Version 2023.3 or higher (Community or Ultimate), via the separate plugin in `intellij-plugin/`
- **Ollama LLM server**: Latest version recommended
- **Node.js**: 18 or newer — required to run the CLI, and to build the extension from source
- **JDK 17+**: For building the IntelliJ plugin from source

## License

Olliberty is free software. You can redistribute it and/or modify it under the
terms of the **GNU General Public License** as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. The full text is in [LICENSE.txt](LICENSE.txt).

It is distributed in the hope that it will be useful, but **without any
warranty** — without even the implied warranty of merchantability or fitness
for a particular purpose. See the GNU General Public License for details.

```
Copyright (C) 2026 Yilmaz Mustafa
SPDX-License-Identifier: GPL-3.0-or-later
```

That choice is deliberate: a tool whose whole point is that your code never
leaves your machine should be one you can read, change, and redistribute — and
so should anything built on top of it.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

Contributions are accepted under the same licence as the project
(GPL-3.0-or-later). Keep the `SPDX-License-Identifier` header on any new source
file you add.

## Support

- **Issues**: Report bugs and request features on GitHub
- **Documentation**: Check the README and inline documentation
- **Community**: Join discussions in the repository

---

**Note**: Olliberty works entirely against your local Ollama LLM server. No data is sent to external servers, ensuring your code remains private and secure.
