package com.codesapienbe.ollama.actions

import com.codesapienbe.ollama.OllamaClient
import com.codesapienbe.ollama.OllamaException
import com.codesapienbe.ollama.OllamaInstaller
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.fileEditor.FileEditorManager
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date

/** Prompts the user for a question, then streams the Ollama response into a timestamped .md file. */
class AskAIAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val client = OllamaClient()

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Checking Ollama connection", false) {
            override fun run(indicator: ProgressIndicator) {
                val healthy = try { client.isHealthy() } catch (ex: Exception) { false }
                if (!healthy) {
                    javax.swing.SwingUtilities.invokeLater { OllamaInstaller.showNotFoundNotification(project) }
                    return
                }
                javax.swing.SwingUtilities.invokeLater { promptAndAsk(project, client, e) }
            }
        })
    }

    private fun promptAndAsk(project: Project, client: OllamaClient, e: AnActionEvent) {
        val question = Messages.showInputDialog(
            project,
            "Ask Ollama",
            "Ollama: Ask AI…",
            Messages.getQuestionIcon(),
        )?.trim()
        if (question.isNullOrEmpty()) return

        val editor = e.getData(CommonDataKeys.EDITOR)
        val fileContext = editor?.document?.text.orEmpty()
        val prompt = if (fileContext.isNotBlank()) "$question\n\n$fileContext" else question

        val outputFile = createOutputFile(project, question) ?: return

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Ollama: generating response…", true) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val response = client.generate(prompt)
                    outputFile.appendText(response)
                    outputFile.appendText("\n\n---\n*Generated at ${Date()}*\n")
                } catch (ex: Exception) {
                    val message = if (ex is OllamaException) ex.message ?: "Unknown error" else "Unknown error: ${ex.message}"
                    outputFile.appendText("\n\n**Error:** $message\n")
                } finally {
                    javax.swing.SwingUtilities.invokeLater {
                        LocalFileSystem.getInstance().refreshAndFindFileByIoFile(outputFile)?.let { vFile ->
                            FileEditorManager.getInstance(project).openFile(vFile, true)
                        }
                    }
                }
            }
        })
    }

    private fun createOutputFile(project: Project, question: String): File? {
        val basePath = project.basePath ?: return null
        val ollamaDir = File(basePath, ".ollama")
        if (!ollamaDir.exists() && !ollamaDir.mkdirs()) return null

        val timestamp = SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss").format(Date())
        val safeQuestion = question.take(50).replace(Regex("[^\\w\\s-]"), "").replace(Regex("\\s+"), "-")
        val file = File(ollamaDir, "${timestamp}_$safeQuestion.md")

        file.writeText(
            """
            # Ollama Response - ${Date()}

            ## Question
            $question

            ## Response

            """.trimIndent()
        )
        return file
    }
}
