/*  Filesystem-backed code index for the CLI.
 *  Reads and writes the very same `.olliberty/code-index.json` the IDE
 *  plugin uses, with the same ranking, previews, and exclude glob — so an
 *  index built in the editor is reused by the CLI and vice versa.        */

import * as fs from 'fs';
import * as path from 'path';
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
} from '../main/core/codeIndexContract';
import { OllibertySettings } from '../main/core/settingsContract';
import { compileGlob } from './glob';

const MAX_DIRECTORY_DEPTH = 12;

export class FileCodeIndexStore implements CodeContextProvider {
  private rebuildPromise?: Promise<CodeIndexBuildResult>;

  constructor(
    private readonly settings: OllibertySettings,
    private readonly workspaceRoot: string
  ) {}

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

    return formatContextEntries(
      [...scopedFiles].sort((left, right) => right.mtime - left.mtime).slice(0, maxResults)
    );
  }

  /** Indexed paths, newest first — used for `@file` completion. */
  async listIndexedPaths(): Promise<string[]> {
    const document = await this.loadDocument();
    if (!document) {
      return [];
    }
    return [...document.files]
      .sort((left, right) => right.mtime - left.mtime)
      .map(file => file.relativePath);
  }

  private async performRebuild(): Promise<CodeIndexBuildResult> {
    const maxFiles = Math.max(1, this.settings.codeIndexMaxFiles);
    const maxFileSizeBytes = Math.max(1, this.settings.codeIndexMaxFileSizeKb) * 1024;
    const maxCandidates = Math.max(maxFiles * 4, maxFiles + 100);
    const candidates = await this.collectCandidates(maxCandidates);

    const files: CodeIndexEntry[] = [];
    let skippedFiles = 0;

    for (const candidate of candidates) {
      if (files.length >= maxFiles) {
        break;
      }

      try {
        if (candidate.size > maxFileSizeBytes) {
          skippedFiles += 1;
          continue;
        }

        const bytes = await fs.promises.readFile(candidate.absolutePath);
        if (isBinaryContent(bytes)) {
          skippedFiles += 1;
          continue;
        }

        const preview = toPreview(bytes.toString('utf8'), this.settings.codeIndexPreviewLines);
        if (!preview.trim()) {
          skippedFiles += 1;
          continue;
        }

        files.push({
          relativePath: candidate.relativePath,
          language: guessLanguage(candidate.relativePath),
          size: candidate.size,
          mtime: candidate.mtime,
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
      workspaceRoot: this.workspaceRoot,
      fileCount: files.length,
      files
    };

    await fs.promises.mkdir(path.join(this.workspaceRoot, INDEX_DIRECTORY), { recursive: true });
    await fs.promises.writeFile(this.indexPath(), JSON.stringify(document), 'utf8');

    return { indexedFiles: files.length, skippedFiles, generatedAt };
  }

  /** Breadth-first walk so shallow, more relevant files win the cap. */
  private async collectCandidates(limit: number): Promise<Array<{ absolutePath: string; relativePath: string; size: number; mtime: number }>> {
    const exclude = compileGlob(this.settings.codeIndexExcludeGlob);
    const results: Array<{ absolutePath: string; relativePath: string; size: number; mtime: number }> = [];
    let queue: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
      { absolutePath: this.workspaceRoot, relativePath: '', depth: 0 }
    ];

    while (queue.length && results.length < limit) {
      const next: typeof queue = [];

      for (const directory of queue) {
        if (results.length >= limit) {
          break;
        }

        let entries: fs.Dirent[];
        try {
          entries = await fs.promises.readdir(directory.absolutePath, { withFileTypes: true });
        } catch {
          continue;
        }

        entries.sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of entries) {
          const relativePath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name;

          if (entry.isSymbolicLink()) {
            /* Never follow links: they invite cycles and escapes from the
               workspace the user scoped us to. */
            continue;
          }

          if (entry.isDirectory()) {
            if (directory.depth + 1 <= MAX_DIRECTORY_DEPTH && !exclude.prunesDirectory(relativePath)) {
              next.push({
                absolutePath: path.join(directory.absolutePath, entry.name),
                relativePath,
                depth: directory.depth + 1
              });
            }
            continue;
          }

          if (!entry.isFile() || exclude.matches(relativePath)) {
            continue;
          }

          try {
            const stat = await fs.promises.stat(path.join(directory.absolutePath, entry.name));
            results.push({
              absolutePath: path.join(directory.absolutePath, entry.name),
              relativePath,
              size: stat.size,
              mtime: stat.mtimeMs
            });
          } catch {
            continue;
          }

          if (results.length >= limit) {
            break;
          }
        }
      }

      queue = next;
    }

    return results;
  }

  private indexPath(): string {
    return path.join(this.workspaceRoot, INDEX_DIRECTORY, INDEX_FILE_NAME);
  }

  private async loadDocument(): Promise<CodeIndexDocument | null> {
    try {
      const raw = await fs.promises.readFile(this.indexPath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<CodeIndexDocument>;
      return isValidIndexDocument(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
