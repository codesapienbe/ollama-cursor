package com.codesapienbe.ollama.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class OllamaChatToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = OllamaChatPanel(project)
        val content = ContentFactory.getInstance().createContent(panel, "", false)
        Disposer.register(content, panel)
        toolWindow.contentManager.addContent(content)
    }
}
