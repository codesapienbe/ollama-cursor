# Change Log

All notable changes to "Olliberty" (formerly "ollama-cursor") will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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