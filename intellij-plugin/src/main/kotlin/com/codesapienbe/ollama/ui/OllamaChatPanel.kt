package com.codesapienbe.ollama.ui

import com.codesapienbe.ollama.OllamaClient
import com.codesapienbe.ollama.OllamaException
import com.codesapienbe.ollama.OllamaInstaller
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import java.awt.BorderLayout
import java.awt.event.ActionEvent
import javax.swing.AbstractAction
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.KeyStroke
import javax.swing.SwingUtilities

/** Minimal chat widget: a scrollable transcript plus a single-line input box. */
class OllamaChatPanel(private val project: Project) : JPanel(BorderLayout()) {

    private val client = OllamaClient()
    private val transcript = JBTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
    }
    private val input = JBTextField()
    private val sendButton = JButton("Send")
    private val clearButton = JButton("Clear")

    init {
        add(JBScrollPane(transcript), BorderLayout.CENTER)

        val inputPanel = JPanel(BorderLayout()).apply {
            add(input, BorderLayout.CENTER)
            add(JPanel().apply {
                add(sendButton)
                add(clearButton)
            }, BorderLayout.EAST)
        }
        add(inputPanel, BorderLayout.SOUTH)

        clearButton.addActionListener { clear() }

        sendButton.addActionListener { send() }
        input.actionMap.put("send", object : AbstractAction() {
            override fun actionPerformed(e: ActionEvent) = send()
        })
        input.inputMap.put(KeyStroke.getKeyStroke("ENTER"), "send")
    }

    fun clear() {
        transcript.text = ""
    }

    private fun send() {
        val message = input.text.trim()
        if (message.isEmpty()) return
        input.text = ""
        appendLine("You: $message")
        sendButton.isEnabled = false

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Olliberty: thinking…", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    if (!client.isHealthy()) {
                        SwingUtilities.invokeLater {
                            appendLine("Olliberty: Ollama not reachable on localhost:11434")
                            OllamaInstaller.showNotFoundNotification(project)
                        }
                        return
                    }
                    val response = client.generate(message)
                    SwingUtilities.invokeLater { appendLine("Olliberty: $response") }
                } catch (ex: Exception) {
                    val text = if (ex is OllamaException) ex.message else ex.message
                    SwingUtilities.invokeLater { appendLine("Olliberty error: $text") }
                } finally {
                    SwingUtilities.invokeLater { sendButton.isEnabled = true }
                }
            }
        })
    }

    private fun appendLine(text: String) {
        transcript.append(if (transcript.text.isEmpty()) text else "\n\n$text")
    }
}
