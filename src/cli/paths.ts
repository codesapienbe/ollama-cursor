// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Where the CLI keeps its state, and how it decides what "the project" is.
 *  Project-scoped state (`.olliberty/`) is shared with the IDE plugin; user
 *  state (`~/.olliberty/`) is the CLI's equivalent of the extension's global
 *  storage.                                                                */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const PROJECT_STATE_DIR = '.olliberty';

/** Markers that make a directory look like the root of a project. */
const ROOT_MARKERS = [
  '.git',
  PROJECT_STATE_DIR,
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  '.hg',
  '.svn'
];

export function userDataDir(): string {
  const override = process.env.OLLIBERTY_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.olliberty');
}

export function userConfigPath(): string {
  return path.join(userDataDir(), 'config.json');
}

export function historyPath(): string {
  return path.join(userDataDir(), 'history');
}

export function secretsPath(): string {
  return path.join(userDataDir(), 'secrets.json');
}

export function projectStateDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, PROJECT_STATE_DIR);
}

export function projectConfigPath(workspaceRoot: string): string {
  return path.join(projectStateDir(workspaceRoot), 'config.json');
}

export function activityLogPath(workspaceRoot: string): string {
  return path.join(projectStateDir(workspaceRoot), 'cli-activity.log');
}

/** Walk up from `startDir` until a project marker shows up. */
export function findWorkspaceRoot(startDir: string): string {
  let current = path.resolve(startDir);

  for (;;) {
    for (const marker of ROOT_MARKERS) {
      if (fs.existsSync(path.join(current, marker))) {
        return current;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      /* Nothing looked like a project root — treat the start directory as one
         rather than silently indexing the whole home directory. */
      return path.resolve(startDir);
    }
    current = parent;
  }
}

/** Directory that holds sql-wasm.wasm for the bundled sql.js copy. */
export function resolveSqlJsWasmDir(): string {
  return path.dirname(require.resolve('sql.js'));
}

/** Home-relative path, trimmed to its last segments when very long. */
export function compactPath(target: string, maxLength = 34): string {
  const shortened = shortenPath(target);
  if (shortened.length <= maxLength) {
    return shortened;
  }

  const segments = shortened.split(path.sep).filter(Boolean);
  for (let keep = 2; keep < segments.length; keep += 1) {
    const candidate = `…${path.sep}${segments.slice(-keep).join(path.sep)}`;
    if (candidate.length > maxLength) {
      return `…${path.sep}${segments.slice(-(keep - 1)).join(path.sep)}`;
    }
  }
  return shortened;
}

export function shortenPath(target: string): string {
  const home = os.homedir();
  const resolved = path.resolve(target);
  return resolved === home || resolved.startsWith(`${home}${path.sep}`)
    ? `~${resolved.slice(home.length)}`
    : resolved;
}
