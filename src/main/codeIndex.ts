import * as path from 'path';
import * as vscode from 'vscode';
import { Settings } from './settings';
import { getCurrentWorkspaceFolder } from './workspaceContext';

interface CodeIndexEntry {
  relativePath: string;
  language: string;
  size: number;
  mtime: number;
  preview: string;
}

interface CodeIndexDocument {
  version: number;
  generatedAt: number;
  workspaceRoot: string;
  fileCount: number;
  files: CodeIndexEntry[];
}

export interface CodeIndexStatus {
  enabled: boolean;
  exists: boolean;
  generatedAt: number;
  fileCount: number;
}

export interface CodeIndexBuildResult {
  indexedFiles: number;
  skippedFiles: number;
  generatedAt: number;
}

const INDEX_VERSION = 1;

export class CodeIndexStore {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder('utf-8');
  private rebuildPromise?: Promise<CodeIndexBuildResult>;

  constructor(private readonly settings: Settings) {}

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

    const tokens = this.tokenize(query);
    if (!tokens.length) {
      return '';
    }

    const scopedFiles = this.filterByScope(document.files, scopePrefix);
    if (!scopedFiles.length) {
      return '';
    }

    const ranked = scopedFiles
      .map(file => ({ file, score: this.scoreEntry(file, tokens) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    if (!ranked.length) {
      return '';
    }

    return this.formatContextEntries(ranked.map(item => item.file));
  }

  async buildFallbackContext(maxResults = 4, scopePrefix = ''): Promise<string> {
    const document = await this.loadDocument();
    if (!document) {
      return '';
    }

    const scopedFiles = this.filterByScope(document.files, scopePrefix);
    if (!scopedFiles.length) {
      return '';
    }

    const recentFiles = [...scopedFiles]
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, maxResults);

    return this.formatContextEntries(recentFiles);
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
        if (this.isBinary(bytes)) {
          skippedFiles += 1;
          continue;
        }

        const text = this.decoder.decode(bytes);
        const preview = this.toPreview(text);
        if (!preview.trim()) {
          skippedFiles += 1;
          continue;
        }

        const relativePath = vscode.workspace.asRelativePath(uri, false);
        files.push({
          relativePath,
          language: this.guessLanguage(relativePath),
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
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, '.olliberty'));
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

      if (
        typeof parsed.version !== 'number'
        || typeof parsed.generatedAt !== 'number'
        || typeof parsed.workspaceRoot !== 'string'
        || typeof parsed.fileCount !== 'number'
        || !Array.isArray(parsed.files)
      ) {
        return null;
      }

      return parsed as CodeIndexDocument;
    } catch {
      return null;
    }
  }

  private getIndexUri(workspaceUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(workspaceUri, '.olliberty', 'code-index.json');
  }

  private toPreview(text: string): string {
    const lines = text.split(/\r?\n/).slice(0, this.settings.codeIndexPreviewLines);
    return lines.join('\n').slice(0, 3000);
  }

  private tokenize(query: string): string[] {
    const tokens = query.toLowerCase().match(/[a-z0-9_./-]{2,}/g) ?? [];
    return Array.from(new Set(tokens)).slice(0, 12);
  }

  private scoreEntry(file: CodeIndexEntry, tokens: string[]): number {
    const haystackPath = file.relativePath.toLowerCase();
    const haystackPreview = file.preview.toLowerCase();
    let score = 0;

    for (const token of tokens) {
      if (haystackPath.includes(token)) {
        score += 5;
      }
      if (haystackPreview.includes(token)) {
        score += 1;
      }
    }

    return score;
  }

  private isBinary(content: Uint8Array): boolean {
    const maxScan = Math.min(content.length, 1024);
    for (let i = 0; i < maxScan; i += 1) {
      if (content[i] === 0) {
        return true;
      }
    }
    return false;
  }

  private guessLanguage(relativePath: string): string {
    const extension = path.extname(relativePath).toLowerCase();
    switch (extension) {
      case '.ts': return 'ts';
      case '.tsx': return 'tsx';
      case '.js': return 'js';
      case '.jsx': return 'jsx';
      case '.json': return 'json';
      case '.md': return 'markdown';
      case '.py': return 'python';
      case '.go': return 'go';
      case '.rs': return 'rust';
      case '.java': return 'java';
      case '.kt': return 'kotlin';
      case '.css': return 'css';
      case '.html': return 'html';
      case '.yml':
      case '.yaml':
        return 'yaml';
      default:
        return 'plaintext';
    }
  }

  private formatContextEntries(entries: CodeIndexEntry[]): string {
    const parts = entries.map(file => {
      const language = file.language === 'plaintext' ? '' : file.language;
      return [
        `File: ${file.relativePath}`,
        `\`\`\`${language}`,
        file.preview,
        '```'
      ].join('\n');
    });

    return parts.join('\n\n');
  }

  private filterByScope(files: CodeIndexEntry[], scopePrefix: string): CodeIndexEntry[] {
    const normalizedPrefix = this.normalizeScopePrefix(scopePrefix);
    if (!normalizedPrefix) {
      return files;
    }

    return files.filter(file =>
      file.relativePath === normalizedPrefix
      || file.relativePath.startsWith(`${normalizedPrefix}/`)
    );
  }

  private normalizeScopePrefix(scopePrefix: string): string {
    return scopePrefix.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  }
}
