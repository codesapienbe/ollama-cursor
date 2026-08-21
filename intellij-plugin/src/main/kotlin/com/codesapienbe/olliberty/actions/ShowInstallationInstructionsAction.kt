// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
package com.codesapienbe.olliberty.actions

import com.codesapienbe.olliberty.OllamaInstaller
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/** Shows OS-specific Ollama installation instructions on demand. */
class ShowInstallationInstructionsAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        OllamaInstaller.showNotFoundNotification(e.project)
    }
}
