package com.codesapienbe.ollama.ui

import com.codesapienbe.ollama.OllamaClient
import com.codesapienbe.ollama.OllamaException
import com.codesapienbe.ollama.OllamaInstaller
import com.codesapienbe.ollama.settings.OllamaSettingsState
import com.codesapienbe.ollama.util.JsonLite
import com.intellij.openapi.Disposable
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import java.awt.BorderLayout
import java.nio.charset.StandardCharsets
import javax.swing.JPanel
import javax.swing.SwingConstants
import javax.swing.SwingUtilities

/**
 * Chat widget rendered as an embedded JCEF (Chromium) webview, sharing the same
 * glassmorphic HTML/CSS/JS design language as the VS Code/Cursor extension.
 * Falls back to a plain label if this IDE build has no JCEF support.
 */
class OllamaChatPanel(private val project: Project) : JPanel(BorderLayout()), Disposable {

    private data class ChatMessage(val role: String, val content: String, val timestamp: Long)

    private val client = OllamaClient()
    private val messages = mutableListOf<ChatMessage>()
    private var isConnected = false
    private val browser: JBCefBrowser? = if (JBCefApp.isSupported()) JBCefBrowser() else null

    init {
        val browser = browser
        if (browser != null) {
            val dispatchQuery = JBCefJSQuery.create(browser)
            dispatchQuery.addHandler { payload -> handleClientMessage(browser, payload); null }

            add(browser.component, BorderLayout.CENTER)
            browser.loadHTML(buildHtml(dispatchQuery), "http://olliberty.local/")
        } else {
            add(
                JBLabel(
                    "<html><div style='text-align:center;'>Olliberty requires JCEF (bundled Chromium) support,<br/>" +
                        "which is unavailable in this IDE environment.</div></html>",
                    SwingConstants.CENTER,
                ),
                BorderLayout.CENTER,
            )
        }
    }

    override fun dispose() {
        browser?.dispose()
    }

    private fun buildHtml(dispatchQuery: JBCefJSQuery): String {
        val html = readResource("/webview/chat.html")
        val css = readResource("/webview/chat.css")
        val js = readResource("/webview/chat.js").replace("/*__DISPATCH_INJECT__*/", dispatchQuery.inject("message"))
        return html
            .replace("<!--STYLE-->", "<style>$css</style>")
            .replace("<!--SCRIPT-->", "<script>$js</script>")
    }

    private fun readResource(path: String): String =
        javaClass.getResourceAsStream(path)!!.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }

    private fun handleClientMessage(browser: JBCefBrowser, payload: String) {
        when (JsonLite.extractStringField(payload, "type")) {
            "sendMessage" -> JsonLite.extractStringField(payload, "message")?.let { send(browser, it) }
            "checkConnection" -> checkConnectionAndPush(browser)
            "clearChat" -> {
                messages.clear()
                checkConnectionAndPush(browser)
            }
            "installOllama" -> SwingUtilities.invokeLater { OllamaInstaller.showNotFoundNotification(project) }
        }
    }

    private fun checkConnectionAndPush(browser: JBCefBrowser) {
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Olliberty: checking connection…", false) {
            override fun run(indicator: ProgressIndicator) {
                isConnected = client.isHealthy()
                SwingUtilities.invokeLater { pushState(browser) }
            }
        })
    }

    private fun send(browser: JBCefBrowser, text: String) {
        val trimmedText = text.trim()
        if (trimmedText.isEmpty()) return
        val slashCommand = trimmedText.startsWith("/")

        if (!slashCommand) {
            messages.add(ChatMessage("user", trimmedText, System.currentTimeMillis()))
            pushState(browser)
        }

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Olliberty: thinking…", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val commandResponse = tryHandleSlashCommand(trimmedText)
                    if (commandResponse != null) {
                        messages.add(ChatMessage("system", commandResponse, System.currentTimeMillis()))
                        return
                    }

                    if (!client.isHealthy()) {
                        isConnected = false
                        messages.add(ChatMessage("system", "Ollama not reachable on ${OllamaSettingsState.getInstance().url}", System.currentTimeMillis()))
                        SwingUtilities.invokeLater {
                            pushState(browser)
                            OllamaInstaller.showNotFoundNotification(project)
                        }
                        return
                    }
                    isConnected = true
                    val response = client.generate(trimmedText)
                    messages.add(ChatMessage("assistant", response, System.currentTimeMillis()))
                } catch (ex: Exception) {
                    val message = if (ex is OllamaException) ex.message else ex.message
                    messages.add(ChatMessage("assistant", "Olliberty error: $message", System.currentTimeMillis()))
                } finally {
                    SwingUtilities.invokeLater { pushState(browser) }
                }
            }
        })
    }

    private fun tryHandleSlashCommand(input: String): String? {
        if (!input.startsWith("/")) return null

        val tokens = input.drop(1).trim().split(Regex("\\s+"), limit = 2)
        val command = tokens.firstOrNull()?.lowercase().orEmpty()
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
                        val suggestionText = if (suggestions.isEmpty()) "" else "\n\nClosest matches:\n${suggestions.joinToString("\n") { "- `$it`" }}"
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
            "help" -> slashHelp()
            else -> "⚠️ Unknown command: `/$command`\n\n${slashHelp()}"
        }
    }

    private fun slashHelp(): String {
        return """
            🛠️ **Available slash commands**

            - `/models` — list available local Ollama models
            - `/model` — show the current default model
            - `/model <name>` — switch the default model
            - `/effort` — show current reasoning effort
            - `/effort minimal|low|medium|high|max` — set reasoning effort
        """.trimIndent()
    }

    private fun pushState(browser: JBCefBrowser) {
        val items = messages.joinToString(",") { m ->
            """{"role":${JsonLite.escape(m.role)},"content":${JsonLite.escape(m.content)},"timestamp":${m.timestamp}}"""
        }
        val json = """{"type":"updateMessages","messages":[$items],"isConnected":$isConnected}"""
        val script = "window.__olliberty_receive && window.__olliberty_receive(${JsonLite.escape(json)});"
        browser.cefBrowser.executeJavaScript(script, browser.cefBrowser.url, 0)
    }
}
