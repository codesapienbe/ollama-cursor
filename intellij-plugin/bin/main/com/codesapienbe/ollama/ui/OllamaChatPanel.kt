package com.codesapienbe.ollama.ui

import com.codesapienbe.ollama.OllamaClient
import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.io.FileUtil
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import java.awt.BorderLayout
import java.io.File
import javax.swing.JPanel
import javax.swing.SwingConstants

/**
 * Chat widget rendered as an embedded JCEF (Chromium) webview, sharing the same
 * glassmorphic HTML/CSS/JS design language as the VS Code/Cursor extension.
 * Falls back to a plain label if this IDE build has no JCEF support.
 *
 * **Important:** this class must never declare fields or method signatures that
 * reference [com.intellij.ui.jcef.JBCefBrowser] or [com.intellij.ui.jcef.JBCefJSQuery].
 * Those types live in [JcefChatView], which is loaded only when JCEF is available.
 * If JCEF types appeared in *this* class's descriptor, the JVM would attempt to
 * resolve them during [java.awt.Component.checkCoalescing] reflection at construction
 * time and throw [NoClassDefFoundError] on IDEs without JCEF support.
 */
class OllamaChatPanel(internal val project: Project) : JPanel(BorderLayout()), Disposable {

    internal data class ChatMessage(val role: String, val content: String, val timestamp: Long)

    internal val client = OllamaClient()
    internal val messages = mutableListOf<ChatMessage>()
    internal var isConnected = false
    internal var pathOverride: String? = null

    /**
     * Stored as [Disposable]? so that the field descriptor does not reference any
     * JCEF class; the actual runtime type is [JcefChatView] when JCEF is available.
     */
    private val jcefView: Disposable? = if (JBCefApp.isSupported()) {
        val view = JcefChatView(this)
        add(view.component, BorderLayout.CENTER)
        view
    } else {
        add(
            JBLabel(
                "<html><div style='text-align:center;'>Olliberty requires JCEF (bundled Chromium) support,<br/>" +
                    "which is unavailable in this IDE environment.</div></html>",
                SwingConstants.CENTER,
            ),
            BorderLayout.CENTER,
        )
        null
    }

    override fun dispose() {
        jcefView?.dispose()
    }

    // ── Slash-command handling ────────────────────────────────────────────────

    internal fun tryHandleSlashCommand(input: String): String? {
        if (!input.startsWith("/")) return null

        val tokens   = input.drop(1).trim().split(Regex("\\s+"), limit = 2)
        val command  = tokens.firstOrNull()?.lowercase().orEmpty()
        val argument = tokens.getOrNull(1)?.trim().orEmpty()

        return when (command) {
            "models" -> {
                val models = client.listModels()
                if (models.isEmpty()) {
                    "📦 No models found in Ollama. Pull one first, for example: `ollama pull gemma4:12b-it-qat`."
                } else {
                    val current = client.getCurrentModel()
                    val lines = models.joinToString("\n") { model ->
                        "- `$model`${if (model == current) " **(current)**" else ""}"
                    }
                    "📦 **Available models (${models.size})**\n\n$lines"
                }
            }
            "model" -> {
                if (argument.isBlank()) {
                    "🤖 **Current model:** `${client.getCurrentModel()}`\n\nUse `/model <name>` to switch, or `/models` to list all available models."
                } else {
                    val available = runCatching { client.listModels() }.getOrDefault(emptyList())
                    if (available.isNotEmpty() && !available.contains(argument)) {
                        val suggestions = available.filter { it.contains(argument, ignoreCase = true) }.take(5)
                        val suggestionText = if (suggestions.isEmpty()) ""
                            else "\n\nClosest matches:\n${suggestions.joinToString("\n") { "- `$it`" }}"
                        "⚠️ Model `$argument` is not in your local Ollama models. Run `/models` to see available models.$suggestionText"
                    } else {
                        client.setModel(argument)
                        "✅ Default model switched to `$argument`."
                    }
                }
            }
            "effort" -> {
                if (argument.isBlank()) {
                    "🧠 **Current effort:** `${client.getEffort()}`\n\nUse `/effort minimal|low|medium|high|max` to change it."
                } else {
                    val normalized = argument.lowercase()
                    if (normalized !in setOf("minimal", "low", "medium", "high", "max")) {
                        "⚠️ Unknown effort value. Use one of: `minimal`, `low`, `medium`, `high`, `max`."
                    } else {
                        client.setEffort(normalized)
                        "✅ Reasoning effort set to `$normalized`."
                    }
                }
            }
            "path" -> handlePathCommand(argument)
            "help" -> slashHelp()
            else   -> "⚠️ Unknown command: `/$command`\n\n${slashHelp()}"
        }
    }

    private fun slashHelp(): String = """
        🛠️ **Available slash commands**

        - `/models` — list available local Ollama models
        - `/model` — show the current default model
        - `/model <name>` — switch the default model
        - `/effort` — show current reasoning effort
        - `/effort minimal|low|medium|high|max` — set reasoning effort
        - `/path` — show current chat path scope (defaults to project root)
        - `/path <dir-or-file>` — scope chat context to a project-relative path
        - `/path reset` — clear override and use project root again
    """.trimIndent()

    // ── Prompt assembly ───────────────────────────────────────────────────────

    internal fun buildPrompt(message: String): String {
        val projectRoot  = project.basePath ?: ""
        val activeScope  = resolveActiveScopePath(projectRoot)
        val sections     = mutableListOf<String>()

        buildScopeHeader(projectRoot, activeScope).takeIf { it.isNotBlank() }?.let { sections += it }
        buildEditorContext().takeIf { it.isNotBlank() }?.let { sections += it }
        buildScopeFallbackContext(projectRoot, activeScope).takeIf { it.isNotBlank() }?.let { sections += it }
        sections += message

        val prompt  = sections.joinToString("\n\n")
        val history = messages.takeLast(8)
            .filter { it.role != "system" }
            .joinToString("\n\n") { "${it.role}: ${it.content}" }

        return if (history.isNotBlank()) "Previous conversation:\n$history\n\nCurrent request: $prompt" else prompt
    }

    private fun buildEditorContext(): String {
        val editor: Editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return ""
        val selection    = editor.selectionModel.selectedText ?: ""
        val documentText = editor.document.text
        val filePath     = editor.virtualFile?.path ?: "active file"
        val languageId   = editor.virtualFile?.extension?.takeIf { it.isNotBlank() } ?: "text"

        return when {
            selection.isNotBlank() ->
                listOf("Based on this selected code:", "```$languageId", selection, "```").joinToString("\n")
            documentText.length < 5_000 ->
                listOf("In the context of file $filePath:", "```$languageId", documentText, "```").joinToString("\n")
            else -> ""
        }
    }

    private fun buildScopeFallbackContext(projectRootPath: String, activeScopePath: String): String {
        if (activeScopePath.isBlank()) return ""
        val scopeDir = File(activeScopePath)
        if (!scopeDir.exists() || !scopeDir.isDirectory) return ""

        val excludedDirs = setOf(".git", "node_modules", "dist", "build", "out", "target", "coverage", ".next", ".idea")
        val files = runCatching {
            scopeDir.walkTopDown()
                .onEnter { dir -> !excludedDirs.contains(dir.name) }
                .filter { it.isFile && it.canRead() && it.length() <= 256 * 1024 }
                .take(120)
                .toList()
        }.getOrDefault(emptyList())

        if (files.isEmpty()) return ""

        val snippets = files
            .sortedByDescending { it.lastModified() }
            .mapNotNull { file ->
                runCatching {
                    val text = file.readText(Charsets.UTF_8)
                    if (text.contains('\u0000')) return@mapNotNull null
                    val preview = text.lineSequence().take(35).joinToString("\n").take(3000).trim()
                    if (preview.isBlank()) return@mapNotNull null
                    val relativePath = toProjectRelativePath(projectRootPath, file.absolutePath)
                    val langId       = file.extension.takeIf { it.isNotBlank() } ?: "text"
                    listOf("File: $relativePath", "```$langId", preview, "```").joinToString("\n")
                }.getOrNull()
            }
            .take(4)

        if (snippets.isEmpty()) return ""
        return "Recent files from the active workspace scope:\n\n${snippets.joinToString("\n\n")}"
    }

    // ── /path command ─────────────────────────────────────────────────────────

    private fun handlePathCommand(argument: String): String {
        val projectRootPath = project.basePath
            ?: return "⚠️ No project directory is open. Open a project to use `/path`."

        val projectRoot        = File(projectRootPath).canonicalFile
        val normalizedArgument = argument.trim()

        if (normalizedArgument.isBlank()) {
            val activeScope = resolveActiveScopePath(projectRoot.path)
            val isDefault   = FileUtil.filesEqual(File(activeScope).canonicalFile, projectRoot)
            return listOf(
                "📁 **Current path scope**",
                "",
                "Project root: `${projectRoot.path}`",
                "Active scope: `$activeScope`${if (isDefault) " **(default)**" else " **(/path override)**"}",
                "",
                "Relative paths are resolved from the active scope unless you run `/path reset`.",
            ).joinToString("\n")
        }

        if (normalizedArgument.lowercase() in setOf("reset", "clear", "default")) {
            pathOverride = null
            return "✅ Path scope reset to project root: `${projectRoot.path}`."
        }

        val requested = if (File(normalizedArgument).isAbsolute) File(normalizedArgument)
                        else File(projectRoot, normalizedArgument)
        val canonical = runCatching { requested.canonicalFile }.getOrNull()
            ?: return "⚠️ Invalid path: `$normalizedArgument`."

        if (!isSameOrChildPath(projectRoot, canonical))
            return "⚠️ Path must stay inside the current project root: `${projectRoot.path}`."
        if (!canonical.exists())
            return "⚠️ Path not found: `${canonical.path}`."

        val scopedPath = if (canonical.isDirectory) canonical else (canonical.parentFile ?: projectRoot)
        pathOverride   = scopedPath.path
        return "✅ Active path scope set to `${scopedPath.path}`.\nAll relative paths now resolve from this directory until `/path reset`."
    }

    private fun buildScopeHeader(projectRootPath: String, activeScopePath: String): String {
        if (projectRootPath.isBlank()) return ""
        val projectRoot = File(projectRootPath).canonicalFile
        val activeScope = File(activeScopePath).canonicalFile
        val isDefault   = FileUtil.filesEqual(activeScope, projectRoot)
        return listOf(
            "Filesystem scope for this request:",
            "- Project root: `${projectRoot.path}`",
            "- Active scope: `${activeScope.path}`${if (isDefault) " (default)" else " (/path override)"}",
            "- Resolve all relative paths from the active scope unless the user changes it with `/path`.",
        ).joinToString("\n")
    }

    private fun resolveActiveScopePath(projectRootPath: String): String {
        if (projectRootPath.isBlank()) return ""
        val projectRoot = File(projectRootPath).canonicalFile
        val override    = pathOverride ?: return projectRoot.path

        val overrideFile = runCatching { File(override).canonicalFile }.getOrNull()
        if (overrideFile == null || !isSameOrChildPath(projectRoot, overrideFile)) {
            pathOverride = null
            return projectRoot.path
        }
        return overrideFile.path
    }

    private fun toProjectRelativePath(projectRootPath: String, absolutePath: String): String {
        if (projectRootPath.isBlank()) return absolutePath
        val projectRoot = runCatching { File(projectRootPath).canonicalFile }.getOrNull() ?: return absolutePath
        val target      = runCatching { File(absolutePath).canonicalFile }.getOrNull() ?: return absolutePath
        if (!isSameOrChildPath(projectRoot, target)) return target.path
        val relative = target.relativeTo(projectRoot).path.replace(File.separatorChar, '/')
        return relative.ifBlank { "." }
    }

    private fun isSameOrChildPath(parent: File, candidate: File): Boolean {
        val parentPath    = parent.toPath().normalize()
        val candidatePath = candidate.toPath().normalize()
        return candidatePath == parentPath || candidatePath.startsWith(parentPath)
    }
}
