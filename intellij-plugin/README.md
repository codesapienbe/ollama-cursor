# Olliberty for IntelliJ IDEA

A JetBrains Platform plugin that mirrors the VS Code / Cursor extension in this
repository: a chat tool window, an "Ask AI" action, and OS-aware install help,
all talking to a locally running [Ollama](https://ollama.com) daemon.

This is a separate codebase from the VS Code extension at the repository root —
IntelliJ IDEA cannot run VS Code extensions, so this plugin is built on the
[IntelliJ Platform SDK](https://plugins.jetbrains.com/docs/intellij/welcome.html)
(Kotlin + Gradle) instead.

## Requirements

- IntelliJ IDEA (Community or Ultimate) 2023.3 or newer
- JDK 17+ to run the Gradle build
- Network access to `download.jetbrains.com` / `cache-redirector.jetbrains.com`
  the first time you build, so Gradle can fetch the target IDE distribution

## Build

```bash
./gradlew buildPlugin
```

The installable plugin ZIP is written to `build/distributions/olliberty-<version>.zip`.

## Install into IntelliJ IDEA

1. `Settings/Preferences` → `Plugins` → gear icon → `Install Plugin from Disk…`
2. Select the ZIP from `build/distributions/`
3. Restart the IDE when prompted

## Try it without building a ZIP

```bash
./gradlew runIde
```

This launches a sandboxed IntelliJ IDEA instance with the plugin already installed.

## Usage

- **Tools → Olliberty → Olliberty: Open Chat Widget** (`Ctrl+Shift+O` / `Cmd+Shift+O`) opens the chat tool window (docked on the right by default).
- **Tools → Olliberty → Olliberty: Ask AI…** prompts for a question and streams the response into a timestamped Markdown file under `.ollama/` in the project root.
- **Tools → Olliberty → Olliberty: Show Installation Instructions** shows OS-specific install steps if Ollama isn't reachable at the configured server URL.
- **Settings/Preferences → Tools → Olliberty** configures the server URL, model, reasoning effort, system prompt, temperature, max tokens, and context length — the same settings the VS Code extension exposes.

Inside the chat input, slash commands are supported:

- `/models` lists local models from Ollama (`/api/tags`)
- `/model` shows the current default model
- `/model <name>` switches the default model
- `/effort` shows the current effort preset
- `/effort minimal|low|medium|high|max` switches effort

## Notes on versions

The Gradle build pins `org.jetbrains.intellij.platform` to `2.16.0`, which
requires Gradle 9.0+ (bundled via the wrapper) and targets IntelliJ Platform
`2023.3.2` as the compile/sandbox baseline. JetBrains ships new Gradle plugin
and platform releases often — if `./gradlew buildPlugin` reports a version
mismatch, check the current requirements at
[the IntelliJ Platform Gradle Plugin docs](https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html)
and bump `build.gradle.kts` / `gradle.properties` accordingly.
