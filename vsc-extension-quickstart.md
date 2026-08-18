# Extension Manifest (Quick Reference)

- **Name:** olliberty
- **Display Name:** Olliberty
- **Description:** Local, private AI coding assistant powered by Ollama — for VS Code, Cursor, and IntelliJ IDEA.
- **Version:** 0.0.1
- **Publisher:** codesapienbe
- **Engines:** VS Code ^1.85.0
- **Categories:** Other
- **Main:** ./out/main/extension.js
- **Contributes:**
  - **Configuration:**
    - `olliberty.model` (string, default: "qwen3.8:latest"): Model name passed to the local Ollama daemon
    - `olliberty.temperature` (number, default: 0.2, min: 0, max: 1): Temperature value for the model
