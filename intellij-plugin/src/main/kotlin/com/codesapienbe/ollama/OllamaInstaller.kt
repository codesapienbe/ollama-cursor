package com.codesapienbe.ollama

import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project

data class InstallationInfo(
    val os: String,
    val commands: List<String>,
    val downloadUrl: String,
)

/** Detects the current OS and offers tailored Ollama install instructions. */
object OllamaInstaller {

    fun detect(): InstallationInfo {
        val osName = System.getProperty("os.name").lowercase()
        return when {
            osName.contains("win") -> InstallationInfo(
                os = "Windows",
                commands = listOf(
                    "winget install Ollama.Ollama",
                    "ollama --version",
                    "ollama serve",
                ),
                downloadUrl = "https://ollama.com/download/windows",
            )
            osName.contains("mac") || osName.contains("darwin") -> InstallationInfo(
                os = "macOS",
                commands = listOf(
                    "brew install ollama",
                    "ollama --version",
                    "ollama serve",
                ),
                downloadUrl = "https://ollama.com/download/mac",
            )
            osName.contains("nux") || osName.contains("nix") -> InstallationInfo(
                os = "Linux",
                commands = listOf(
                    "curl -fsSL https://ollama.com/install.sh | sh",
                    "ollama --version",
                    "ollama serve",
                ),
                downloadUrl = "https://ollama.com/download/linux",
            )
            else -> InstallationInfo(
                os = osName,
                commands = listOf("ollama --version", "ollama serve"),
                downloadUrl = "https://ollama.com/download",
            )
        }
    }

    fun showNotFoundNotification(project: Project?) {
        val info = detect()
        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup("Ollama Assistant")
            .createNotification(
                "Ollama not found on ${info.os}",
                "Install it, then start it with \"ollama serve\" before using Ollama Assistant.",
                NotificationType.WARNING,
            )
        notification.addAction(NotificationAction.createSimple("Show Instructions") {
            showInstructionsNotification(project, info)
        })
        notification.addAction(NotificationAction.createSimple("Open Download Page") {
            BrowserUtil.browse(info.downloadUrl)
        })
        notification.notify(project)
    }

    private fun showInstructionsNotification(project: Project?, info: InstallationInfo) {
        val body = info.commands.joinToString("<br/>") { it }
        NotificationGroupManager.getInstance()
            .getNotificationGroup("Ollama Assistant")
            .createNotification("Install Ollama on ${info.os}", body, NotificationType.INFORMATION)
            .notify(project)
    }
}
