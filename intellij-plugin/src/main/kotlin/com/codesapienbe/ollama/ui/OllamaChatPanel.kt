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
        messages.add(ChatMessage("user", text, System.currentTimeMillis()))
        pushState(browser)

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Olliberty: thinking…", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
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
                    val response = client.generate(text)
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

    private fun pushState(browser: JBCefBrowser) {
        val items = messages.joinToString(",") { m ->
            """{"role":${JsonLite.escape(m.role)},"content":${JsonLite.escape(m.content)},"timestamp":${m.timestamp}}"""
        }
        val json = """{"type":"updateMessages","messages":[$items],"isConnected":$isConnected}"""
        val script = "window.__olliberty_receive && window.__olliberty_receive(${JsonLite.escape(json)});"
        browser.cefBrowser.executeJavaScript(script, browser.cefBrowser.url, 0)
    }
}
