package com.codesapienbe.olliberty.ui

import com.codesapienbe.olliberty.OllamaInstaller
import com.codesapienbe.olliberty.settings.OllamaSettingsState
import com.codesapienbe.olliberty.util.JsonLite
import com.intellij.openapi.Disposable
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import java.nio.charset.StandardCharsets
import javax.swing.JComponent
import javax.swing.SwingUtilities

/**
 * Encapsulates all JCEF (Chromium Embedded Framework) functionality.
 *
 * This class is **only instantiated** when [com.intellij.ui.jcef.JBCefApp.isSupported]
 * returns `true`. Keeping every reference to [JBCefBrowser] and [JBCefJSQuery] inside
 * this separate class prevents the JVM from attempting to resolve those types while
 * loading [OllamaChatPanel] — which would crash with [NoClassDefFoundError] on IDEs
 * that ship without JCEF support (e.g. some remote-development / gateway builds).
 */
internal class JcefChatView(private val panel: OllamaChatPanel) : Disposable {

    private val browser = JBCefBrowser()
    private val dispatchQuery: JBCefJSQuery = JBCefJSQuery.create(browser)

    /** The Swing component that should be added to the parent panel. */
    val component: JComponent get() = browser.component

    init {
        dispatchQuery.addHandler { payload ->
            handleClientMessage(payload)
            null
        }
        browser.loadHTML(buildHtml(dispatchQuery), "http://olliberty.local/")
    }

    override fun dispose() {
        browser.dispose()
    }

    // ── HTML assembly ─────────────────────────────────────────────────────────

    private fun buildHtml(query: JBCefJSQuery): String {
        val html = readResource("/webview/chat.html")
        val css  = readResource("/webview/chat.css")
        val js   = readResource("/webview/chat.js")
            .replace("/*__DISPATCH_INJECT__*/", query.inject("message"))
        return html
            .replace("<!--STYLE-->",  "<style>$css</style>")
            .replace("<!--SCRIPT-->", "<script>$js</script>")
    }

    private fun readResource(path: String): String =
        javaClass.getResourceAsStream(path)!!
            .bufferedReader(StandardCharsets.UTF_8)
            .use { it.readText() }

    // ── Message dispatch from JS → Kotlin ─────────────────────────────────────

    private fun handleClientMessage(payload: String) {
        when (JsonLite.extractStringField(payload, "type")) {
            "sendMessage"      -> JsonLite.extractStringField(payload, "message")?.let { send(it) }
            "checkConnection"  -> checkConnectionAndPush()
            "clearChat"        -> { panel.messages.clear(); checkConnectionAndPush() }
            "installOllama"    -> SwingUtilities.invokeLater {
                OllamaInstaller.showNotFoundNotification(panel.project)
            }
        }
    }

    // ── Background tasks ──────────────────────────────────────────────────────

    fun checkConnectionAndPush() {
        ProgressManager.getInstance().run(
            object : Task.Backgroundable(panel.project, "Olliberty: checking connection…", false) {
                override fun run(indicator: ProgressIndicator) {
                    panel.isConnected = panel.client.isHealthy()
                    SwingUtilities.invokeLater { pushState() }
                }
            }
        )
    }

    private fun send(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return

        if (!trimmed.startsWith("/")) {
            panel.messages.add(OllamaChatPanel.ChatMessage("user", trimmed, System.currentTimeMillis()))
            pushState()
        }

        ProgressManager.getInstance().run(
            object : Task.Backgroundable(panel.project, "Olliberty: thinking…", false) {
                override fun run(indicator: ProgressIndicator) {
                    try {
                        val commandResponse = panel.tryHandleSlashCommand(trimmed)
                        if (commandResponse != null) {
                            panel.messages.add(OllamaChatPanel.ChatMessage("system", commandResponse, System.currentTimeMillis()))
                            return
                        }

                        if (!panel.client.isHealthy()) {
                            panel.isConnected = false
                            panel.messages.add(
                                OllamaChatPanel.ChatMessage(
                                    "system",
                                    "Ollama not reachable on ${OllamaSettingsState.getInstance().url}",
                                    System.currentTimeMillis(),
                                )
                            )
                            SwingUtilities.invokeLater {
                                pushState()
                                OllamaInstaller.showNotFoundNotification(panel.project)
                            }
                            return
                        }

                        panel.isConnected = true
                        val response = panel.client.generate(panel.buildPrompt(trimmed))
                        panel.messages.add(OllamaChatPanel.ChatMessage("assistant", response, System.currentTimeMillis()))
                    } catch (ex: Exception) {
                        panel.messages.add(
                            OllamaChatPanel.ChatMessage("assistant", "Olliberty error: ${ex.message}", System.currentTimeMillis())
                        )
                    } finally {
                        SwingUtilities.invokeLater { pushState() }
                    }
                }
            }
        )
    }

    // ── State → JS bridge ─────────────────────────────────────────────────────

    fun pushState() {
        val items = panel.messages.joinToString(",") { m ->
            """{"role":${JsonLite.escape(m.role)},"content":${JsonLite.escape(m.content)},"timestamp":${m.timestamp}}"""
        }
        val json   = """{"type":"updateMessages","messages":[$items],"isConnected":${panel.isConnected}}"""
        val script = "window.__olliberty_receive && window.__olliberty_receive(${JsonLite.escape(json)});"
        browser.cefBrowser.executeJavaScript(script, browser.cefBrowser.url, 0)
    }
}

