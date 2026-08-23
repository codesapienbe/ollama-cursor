# Change Log

All notable changes to "Olliberty" (formerly "ollama-cursor") will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Sub-agents are the default path

- **Every request is now split across sub-agents, without a command.** A router runs first on each request: greetings and one-liners still answer in a single pass, and anything with real work in it is split across 2–5 role-specific agents whose findings are merged into one answer. The answer reads like an ordinary reply — the agents appear in the task panel and a footer names them. `/agents <goal>` is the same machinery with the router skipped, so it now forces a split rather than being the only way to get one. New `olliberty.agents.delegation` (`auto` | `always` | `off`), `--agents`, `--no-agents`, and `OLLIBERTY_DELEGATION`.
- **A library of eight roles replaces the fixed trio.** Research, context scout, implementation, interface design, integration, quality, performance and security; the router picks by role id, capped by `olliberty.agents.maxCount` (default 5, hard maximum 5). Role ids the model invents are dropped rather than trusted, and if the router is unreachable or its answer unparseable the request is still split — along heuristic lines, because routing is an optimisation and never a gate.
- **Concurrency is bounded (`olliberty.agents.maxParallel`, default 2).** Ollama generates for one request per loaded model at a time, so an unbounded fan-out did not run in parallel — it buried the later agents in a queue deep enough to time them out. Agents held back by the pool now report `waiting` with their place in line instead of looking hung.
- **Each agent gets one retry**, with a leaner prompt and a larger answer budget — the two things that turn "no output" into output. Retries are visible in the panel. A single dead agent no longer costs the answer: the synthesis proceeds with what came back and names the angle that went uncovered. Only a fan-out where *every* agent failed reports failure, and even then the turn falls back to a single-pass answer rather than leaving the user with nothing.

### Fixed

- **A delegated agent could fail at 45 s while the model server was working normally.** One timeout covered both the wait for the model server's queue and silence during streaming, and on a large local model the queue wait alone exceeds it. These are now two budgets: `olliberty.timeoutMs` (default 90 s) is the idle budget for a stream that has already started, and the new `olliberty.queueTimeoutMs` (default 10 min) covers the wait for the first token. The timeout message names which one expired.
- **A reasoning model could report a completed agent with an empty answer.** Ollama streams reasoning in a separate `thinking` field that is not part of `response` but does consume `num_predict`, so an agent that spent its budget thinking returned nothing and the synthesis had nothing to merge — the symptom was completed sub-agents with no detail and a blank final answer. Reasoning tokens are now tracked separately (and surfaced as progress), sub-agents run with reasoning disabled so their whole budget goes to findings, and an answer that is empty despite reasoning raises a distinct error that triggers the retry instead of surfacing as a blank turn.
- **`olliberty.temperature` never reached the model.** It was sent as a top-level field of the Ollama request, where sampling parameters are silently ignored; it now goes in `options` alongside `num_predict` and `num_ctx`. Every request until now ran at the model's default temperature regardless of the setting.
- **Agent prompts were built to a fixed 64k context ceiling** — six times what the default 4096-token window holds — so Ollama dropped the front of every agent prompt, which is where the instructions were. Prompt context is now sized from the actual window, and agent prompts repeat their role and output contract after the context so a clip at either end still leaves the agent its job. Instructions in agent prompts also state explicitly that "not shown in the provided context" is the correct answer when the context does not settle a question.
- `olliberty.contextLength` accepts up to 131072 (was 8192); the old ceiling limited how many sub-agent findings could be merged at once.

### Licensing

- **Relicensed to GPL-3.0-or-later.** Olliberty was previously marked MIT (with an unfilled `[Your Name]` copyright placeholder). `LICENSE.txt` now carries the verbatim GNU GPL v3 text, `package.json` declares the `GPL-3.0-or-later` SPDX identifier, and every source file carries `SPDX-FileCopyrightText` / `SPDX-License-Identifier` headers. Contributions are accepted under the same terms.
- **Ollama is consistently called the LLM server** in user-facing text — settings descriptions, README, install guidance, the CLI banner and `--help` — replacing the mixed "daemon" / "process" / "service" / "installation" wording.

### Olliberty CLI

- **New `olliberty` terminal client.** A TUI built from the same engine as the plugin: plan-first by default, diff-before-write approvals, live activity feed, delegated sub-agents, sessions, notes, Graphify import, token vault, and the local-only network kill switch. `make install` (or `npm link`) puts it on your PATH; `npm run cli -- --help` runs it in place.
- **Shared engine, not a fork.** The plan gate, edit-proposal contract, code index format, secret scrubber, conversation store, multi-agent runner, and Ollama client are the same modules the extension loads. Host-specific pieces were extracted into `src/main/core/` (`settingsContract`, `activityContract`, `codeIndexContract`, `editProposal`, `secretVault`, `ollamaInstall`) so both surfaces implement one contract instead of drifting apart.
- **Shared code index.** `.olliberty/code-index.json` is written and read by both the IDE plugin and the CLI, so an index built in either surface is immediately useful in the other.
- **Sub-task side panel.** While `/agents` runs, sub-tasks move into their own column on the right of the frame — one tinted block per task, each keeping its colour for the whole run, with a live spinner, elapsed time, streamed character count, and a progress bar that sweeps while the task is generating. The synthesis pass is listed as a task too, so the panel stays populated until the answer lands. Terminals narrower than 76 columns keep the stacked tree.
- **Terminal rendering.** Markdown output is rendered in the terminal (headings, lists, tables, blockquotes, fenced code with syntax tinting), and diffs render as file panels with real line numbers, hunk headers, and tinted add/remove rows. Sub-agent fan-out renders as a live tree; the activity feed shows per-step durations while a turn runs.
- **Composer.** Slash-command and argument completion (models, config keys, session ids, token keys, paths), `@path` file mentions, multi-line entry, prompt history, bracketed paste, and shell-style line editing. `Esc` interrupts a run, `Shift+Tab` toggles plan/auto.
- **Non-interactive mode.** `olliberty "<prompt>"`, `-p`, `--json`, `--plain`, and the `index`, `models`, `doctor`, `sessions`, `changes`, `context`, `privacy`, `config` subcommands. `-y/--yes` opts into auto mode with automatic edit application for scripting; interactive sessions always show the diff first.
- **Layered configuration.** Defaults < `~/.olliberty/config.json` < `<workspace>/.olliberty/config.json` < environment (`OLLIBERTY_URL`/`OLLAMA_HOST`, `OLLIBERTY_MODEL`, `OLLIBERTY_MODE`, `OLLIBERTY_EFFORT`) < flags, using the same keys as the VS Code settings. `/config` shows the effective value and which layer it came from. The request timeout is now configurable (`timeoutMs`) instead of hard-coded.
- **CLI-only commands:** `/diff <file>`, `/attach`, `/detach`, `/context`, `/config`, `/doctor`, `/clear`, `/exit`.
- **Known difference:** `/token` secrets are stored in `~/.olliberty/secrets.json` with `0600` permissions and are not encrypted at rest — a terminal has no OS keychain equivalent to VS Code's `SecretStorage`. `/privacy` and `/token` state this explicitly.
- Zero new runtime dependencies: the terminal UI (colour degradation, width measurement, wrapping, key decoding, rendering) is hand-rolled.
- **`make install` now installs, not just builds** — all three surfaces in one shot: the VSIX into whichever of VS Code and Cursor is present (missing editors are skipped instead of failing the run), the IntelliJ plugin unpacked into every detected IntelliJ IDEA plugins directory (`JETBRAINS_PLUGIN_DIR` overrides the search; manual instructions are printed when no IDE is found), and the `olliberty` CLI linked onto PATH. New `install-intellij` / `uninstall-intellij` targets, and `make uninstall` reverses all three.
- **`make bundle` produces all three installables** in `dist/`: the `.vsix`, the IntelliJ plugin `.zip`, and an npm tarball of the CLI (`npm install -g dist/olliberty-<version>.tgz`), with the install command for each printed at the end.

### Changed

- `computeFileDiff` now returns structured hunks and emits standard `@@ -a,b +c,d @@` headers instead of bare `@@` separators, which is what lets both the webview and the terminal show real line numbers.
- `ConversationStore` takes explicit storage and sql.js paths instead of a VS Code `ExtensionContext`, and `TokenStore` takes a `SecretVault` port (`vscode.SecretStorage` satisfies it unchanged).
- Packaging lists are split per packager: `.vscodeignore` governs the VSIX and a new `.npmignore` governs the npm tarball. A `files` property in `package.json` cannot be used for the latter — `vsce` refuses to package when both it and `.vscodeignore` exist.
- Added CLI unit tests (`npm run test:cli`) covering key decoding, the line editor, display width/wrapping, glob pruning, configuration layering, diff hunks, and markdown rendering.

### Visibility and plan-first execution

- **Plan-first mode is now the default.** New `olliberty.mode` setting (`plan` | `auto`, default `plan`). In `plan` mode every request produces a numbered plan — steps, expected files, risks — and nothing runs until you press **Accept plan** (`/accept`) or discard it (`/discard`). Plans that touch files still require a separate diff approval before anything is written; `olliberty.autoApplyEdits` is ignored in this mode.
- **Interruptible runs.** Any in-flight run can be stopped with `Esc`, the stop button (the send button becomes a red ■ while working), the view title bar, or *Olliberty: Stop*. Stopping destroys the HTTP socket so Ollama actually stops generating; whatever streamed so far is kept in the transcript, interrupted steps show as `⏹` in the activity feed, and nothing is written to disk. `OllamaClient.generate` now accepts an `AbortSignal` (previously it declared one but no caller ever passed it) and reports cancellation as a distinct `AbortedError` rather than a failure.
- **Live activity feed.** A **Working** panel above the transcript shows every step as it happens — indexing, context retrieval, plan drafting, model calls, per-file writes — with running/done/failed state and durations. Controlled by `olliberty.showActivityFeed`.
- **Activity log output channel.** The same feed is written to an **Olliberty** output channel as a durable record, reachable via the `Log` chip, `/activity`, or the new *Olliberty: Show Activity Log* command.
- **Streaming responses.** Model output now renders token-by-token in the chat instead of appearing only when generation finishes. Controlled by `olliberty.streamResponses`.
- **Inline diffs for every change.** Proposed and applied edits are rendered in the transcript as coloured unified diffs with per-file `+`/`−` counts, in addition to the existing in-IDE diff previews.
- **Changes panel.** Every file written during the session is listed with its line counts; clicking an entry reopens its before/after diff. Also available as `/changes`.
- New slash commands: `/mode`, `/plan`, `/accept`, `/discard`, `/activity`, `/changes`.
- New commands: *Olliberty: Stop*, *Olliberty: Show Activity Log*, *Olliberty: Toggle Plan-First Mode*.
- Chat header now shows the active model and mode, with a one-click mode toggle.

### Changed

- Default model changed from `gemma4:12b-it-qat` to `qwen3.8:latest` across the VS Code/Cursor extension and the IntelliJ plugin.

### Earlier

- Renamed the project to Olliberty: extension id, command ids, view/container ids, and the `olliberty.*` settings namespace all changed from their `ollama.*` predecessors. The IntelliJ plugin id changed to `com.codesapienbe.olliberty`.
- Added a separate IntelliJ IDEA plugin (Kotlin/Gradle) under `intellij-plugin/`, alongside the existing VS Code/Cursor extension.
- Initial release