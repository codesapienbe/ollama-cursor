// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Local workspace code index for the IDE host.
 *  Writes `.olliberty/code-index.json` in the workspace root — the same
 *  document the CLI reads and writes, so an index built in either surface
 *  is immediately usable by the other. Ranking/preview logic is shared
 *  through core/codeIndexContract.                                        */

import * as vscode from 'vscode';
import {
  CodeContextProvider,
  CodeIndexBuildResult,
  CodeIndexDocument,
  CodeIndexEntry,
  CodeIndexStatus,
  INDEX_DIRECTORY,
  INDEX_FILE_NAME,
  INDEX_VERSION,
  filterByScope,
  formatContextEntries,
  guessLanguage,
  isBinaryContent,
  isValidIndexDocument,
  rankEntries,
  toPreview
} from './core/codeIndexContract';
import { OllibertySettings } from './core/settingsContract';
import { getCurrentWorkspaceFolder } from './workspaceContext';

export type { CodeIndexBuildResult, CodeIndexStatus };

export class CodeIndexStore implements CodeContextProvider {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder('utf-8');
  private rebuildPromise?: Promise<CodeIndexBuildResult>;

  constructor(private readonly settings: OllibertySettings) {}

  async ensureIndexed(): Promise<void> {
    if (!this.settings.autoIndexWorkspace) {
      return;
    }

    const status = await this.getStatus();
    if (!status.exists) {
      await this.rebuild();
      return;
    }

    const staleAfterMs = this.settings.codeIndexStaleAfterMinutes * 60_000;
    if (Date.now() - status.generatedAt > staleAfterMs) {
      await this.rebuild();
    }
  }

  async rebuild(): Promise<CodeIndexBuildResult> {
    if (this.rebuildPromise) {
      return this.rebuildPromise;
    }

    this.rebuildPromise = this.performRebuild().finally(() => {
      this.rebuildPromise = undefined;
    });

    return this.rebuildPromise;
  }

  async getStatus(): Promise<CodeIndexStatus> {
    const document = await this.loadDocument();
    if (!document) {
      return {
        enabled: this.settings.autoIndexWorkspace,
        exists: false,
        generatedAt: 0,
        fileCount: 0
      };
    }

    return {
      enabled: this.settings.autoIndexWorkspace,
      exists: true,
      generatedAt: document.generatedAt,
      fileCount: document.fileCount
    };
  }

  async buildPromptContext(query: string, maxResults = 4, scopePrefix = ''): Promise<string> {
    const document = await this.loadDocument();
    if (!document) {
      return '';
    }

    const ranked = rankEntries(document.files, query, maxResults, scopePrefix);
    return ranked.length ? formatContextEntries(ranked) : '';
  }

  async buildFallbackContext(maxResults = 4, scopePrefix = ''): Promise<string> {
    const document = await this.loadDocument();
    if (!document) {
      return '';
    }

    const scopedFiles = filterByScope(document.files, scopePrefix);
    if (!scopedFiles.length) {
      return '';
    }

    const recentFiles = [...scopedFiles]
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, maxResults);

    return formatContextEntries(recentFiles);
  }

  private async performRebuild(): Promise<CodeIndexBuildResult> {
    const workspaceFolder = getCurrentWorkspaceFolder();
    if (!workspaceFolder) {
      return { indexedFiles: 0, skippedFiles: 0, generatedAt: Date.now() };
    }

    const maxFiles = Math.max(1, this.settings.codeIndexMaxFiles);
    const maxFileSizeBytes = Math.max(1, this.settings.codeIndexMaxFileSizeKb) * 1024;
    const maxCandidates = Math.max(maxFiles * 4, maxFiles + 100);
    const uris = await vscode.workspace.findFiles('**/*', this.settings.codeIndexExcludeGlob, maxCandidates);

    const files: CodeIndexEntry[] = [];
    let skippedFiles = 0;

    for (const uri of uris) {
      if (files.length >= maxFiles) {
        break;
      }

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) === 0 || stat.size > maxFileSizeBytes) {
          skippedFiles += 1;
          continue;
        }

        const bytes = await vscode.workspace.fs.readFile(uri);
        if (isBinaryContent(bytes)) {
          skippedFiles += 1;
          continue;
        }

        const text = this.decoder.decode(bytes);
        const preview = toPreview(text, this.settings.codeIndexPreviewLines);
        if (!preview.trim()) {
          skippedFiles += 1;
          continue;
        }

        const relativePath = vscode.workspace.asRelativePath(uri, false);
        files.push({
          relativePath,
          language: guessLanguage(relativePath),
          size: stat.size,
          mtime: stat.mtime,
          preview
        });
      } catch {
        skippedFiles += 1;
      }
    }

    const generatedAt = Date.now();
    const document: CodeIndexDocument = {
      version: INDEX_VERSION,
      generatedAt,
      workspaceRoot: workspaceFolder.uri.fsPath,
      fileCount: files.length,
      files
    };

    const indexUri = this.getIndexUri(workspaceFolder.uri);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, INDEX_DIRECTORY));
    await vscode.workspace.fs.writeFile(indexUri, this.encoder.encode(JSON.stringify(document)));

    return {
      indexedFiles: files.length,
      skippedFiles,
      generatedAt
    };
  }

  private async loadDocument(): Promise<CodeIndexDocument | null> {
    const workspaceFolder = getCurrentWorkspaceFolder();
    if (!workspaceFolder) {
      return null;
    }

    const indexUri = this.getIndexUri(workspaceFolder.uri);
    try {
      const bytes = await vscode.workspace.fs.readFile(indexUri);
      const parsed = JSON.parse(this.decoder.decode(bytes)) as Partial<CodeIndexDocument>;
      return isValidIndexDocument(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private getIndexUri(workspaceUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(workspaceUri, INDEX_DIRECTORY, INDEX_FILE_NAME);
  }
}
