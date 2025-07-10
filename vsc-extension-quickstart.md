# Extension Manifest (Quick Reference)

- **Name:** ollama-cursor
- **Description:** Alternative code assistance in case you reach API limits.
- **Version:** 0.0.1
- **Publisher:** [Your Name or Organization]
- **Engines:** VS Code ^1.101.0
- **Categories:** Other
- **Main:** ./out/extension.js
- **Contributes:**
  - **Configuration:**
    - `ollama.model` (string, default: "codellama"): Model name passed to the local Ollama daemon
    - `ollama.temperature` (number, default: 0.2, min: 0, max: 1): Temperature value for the model
