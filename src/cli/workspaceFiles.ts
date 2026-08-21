// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Workspace file helpers the CLI needs where the IDE plugin would ask
 *  VS Code: locating Graphify exports, reading `@file` attachments, and
 *  listing paths for completion.                                        */

import * as fs from 'fs';
import * as path from 'path';
import { guessLanguage } from '../main/core/codeIndexContract';
import { MAX_EDITOR_CONTEXT_CHARS } from '../main/core/editProposal';
import { AttachedFile } from './editService';

const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.ollama'
]);
const MAX_WALK_DEPTH = 10;

/** Mirrors the plugin's `**​/graphify-out/*.json` search, hidden files included. */
export async function findGraphifyJsonFiles(workspaceRoot: string, limit = 400): Promise<string[]> {
  const found: string[] = [];

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || found.length >= limit) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= limit) {
        return;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) {
          continue;
        }
        if (entry.name === 'graphify-out') {
          found.push(...await listJsonFiles(absolutePath));
          continue;
        }
        await walk(absolutePath, depth + 1);
      }
    }
  };

  await walk(workspaceRoot, 0);
  return Array.from(new Set(found)).slice(0, limit);
}

async function listJsonFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map(entry => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

/** Read one `@file` attachment, scoped to the workspace root. */
export async function readAttachment(workspaceRoot: string, requestedPath: string): Promise<AttachedFile> {
  const absolutePath = path.resolve(workspaceRoot, requestedPath);
  const root = path.resolve(workspaceRoot);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`\`${requestedPath}\` is outside the workspace root.`);
  }

  const stat = await fs.promises.stat(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`\`${requestedPath}\` is not a file.`);
  }

  const raw = await fs.promises.readFile(absolutePath, 'utf8');
  const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
  const truncated = raw.length > MAX_EDITOR_CONTEXT_CHARS;

  return {
    relativePath,
    language: guessLanguage(relativePath),
    content: truncated ? raw.slice(0, MAX_EDITOR_CONTEXT_CHARS) : raw,
    truncated
  };
}

/** Directory listing used by `@path` completion when the index is cold. */
export async function listPathCompletions(workspaceRoot: string, fragment: string, limit = 40): Promise<string[]> {
  const normalized = fragment.replace(/\\/g, '/');
  const hasTrailingSlash = normalized.endsWith('/');
  const directoryPart = hasTrailingSlash ? normalized : path.posix.dirname(normalized);
  const namePart = hasTrailingSlash ? '' : path.posix.basename(normalized);
  const searchDirectory = path.resolve(
    workspaceRoot,
    directoryPart === '.' || directoryPart === '' ? '' : directoryPart
  );

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(searchDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const prefix = directoryPart === '.' || directoryPart === '' ? '' : `${directoryPart.replace(/\/+$/, '')}/`;

  return entries
    .filter(entry => !SKIP_DIRECTORIES.has(entry.name))
    .filter(entry => entry.name.toLowerCase().startsWith(namePart.toLowerCase()))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, limit)
    .map(entry => `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
}

export function gitBranch(workspaceRoot: string): string {
  try {
    const headPath = path.join(workspaceRoot, '.git', 'HEAD');
    const head = fs.readFileSync(headPath, 'utf8').trim();
    const match = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return match ? match[1] : head.slice(0, 7);
  } catch {
    return '';
  }
}
