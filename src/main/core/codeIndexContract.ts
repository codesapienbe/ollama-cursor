/*  Host-agnostic code index contract plus the pure ranking helpers.
 *  The on-disk format is shared: `.olliberty/code-index.json` written by
 *  the IDE plugin is read by the CLI and vice versa.                     */

import * as path from 'path';

export interface CodeIndexEntry {
  relativePath: string;
  language: string;
  size: number;
  mtime: number;
  preview: string;
}

export interface CodeIndexDocument {
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

export const INDEX_VERSION = 1;
export const INDEX_DIRECTORY = '.olliberty';
export const INDEX_FILE_NAME = 'code-index.json';

/** The slice of the index the shared services actually consume. */
export interface CodeContextProvider {
  ensureIndexed(): Promise<void>;
  rebuild(): Promise<CodeIndexBuildResult>;
  getStatus(): Promise<CodeIndexStatus>;
  buildPromptContext(query: string, maxResults?: number, scopePrefix?: string): Promise<string>;
  buildFallbackContext(maxResults?: number, scopePrefix?: string): Promise<string>;
}

export function tokenizeQuery(query: string): string[] {
  const tokens = query.toLowerCase().match(/[a-z0-9_./-]{2,}/g) ?? [];
  return Array.from(new Set(tokens)).slice(0, 12);
}

export function scoreEntry(file: CodeIndexEntry, tokens: string[]): number {
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

export function isBinaryContent(content: Uint8Array): boolean {
  const maxScan = Math.min(content.length, 1024);
  for (let i = 0; i < maxScan; i += 1) {
    if (content[i] === 0) {
      return true;
    }
  }
  return false;
}

export function guessLanguage(relativePath: string): string {
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

export function toPreview(text: string, previewLines: number): string {
  const lines = text.split(/\r?\n/).slice(0, previewLines);
  return lines.join('\n').slice(0, 3000);
}

export function formatContextEntries(entries: CodeIndexEntry[]): string {
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

export function normalizeScopePrefix(scopePrefix: string): string {
  return scopePrefix.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

export function filterByScope(files: CodeIndexEntry[], scopePrefix: string): CodeIndexEntry[] {
  const normalizedPrefix = normalizeScopePrefix(scopePrefix);
  if (!normalizedPrefix) {
    return files;
  }

  return files.filter(file =>
    file.relativePath === normalizedPrefix
    || file.relativePath.startsWith(`${normalizedPrefix}/`)
  );
}

export function rankEntries(files: CodeIndexEntry[], query: string, maxResults: number, scopePrefix: string): CodeIndexEntry[] {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) {
    return [];
  }

  const scopedFiles = filterByScope(files, scopePrefix);
  if (!scopedFiles.length) {
    return [];
  }

  return scopedFiles
    .map(file => ({ file, score: scoreEntry(file, tokens) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxResults)
    .map(item => item.file);
}

export function isValidIndexDocument(parsed: Partial<CodeIndexDocument> | null): parsed is CodeIndexDocument {
  return Boolean(
    parsed
    && typeof parsed.version === 'number'
    && typeof parsed.generatedAt === 'number'
    && typeof parsed.workspaceRoot === 'string'
    && typeof parsed.fileCount === 'number'
    && Array.isArray(parsed.files)
  );
}
