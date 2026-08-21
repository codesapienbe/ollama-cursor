// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';

export function getCurrentWorkspaceFolder(preferredUri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  if (preferredUri) {
    const preferredFolder = vscode.workspace.getWorkspaceFolder(preferredUri);
    if (preferredFolder) {
      return preferredFolder;
    }
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (activeFolder) {
      return activeFolder;
    }
  }

  return folders[0];
}
