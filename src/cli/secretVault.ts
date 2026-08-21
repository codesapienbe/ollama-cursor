// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  File-backed secret vault for the CLI.
 *
 *  Honest limitation: the IDE plugin stores tokens in the OS keychain via
 *  vscode.SecretStorage. The CLI has no keychain to talk to, so values are
 *  kept in a 0600 JSON file under the user data directory. That protects
 *  them from other users on the machine, but not from anything running as
 *  this user, and they are NOT encrypted at rest. `/token` says so too.   */

import * as fs from 'fs';
import * as path from 'path';
import { SecretVault } from '../main/core/secretVault';

export class FileSecretVault implements SecretVault {
  private cache: Record<string, string> | null = null;

  constructor(private readonly filePath: string) {}

  async get(key: string): Promise<string | undefined> {
    return this.load()[key];
  }

  async store(key: string, value: string): Promise<void> {
    const data = this.load();
    data[key] = value;
    await this.persist(data);
  }

  async delete(key: string): Promise<void> {
    const data = this.load();
    delete data[key];
    await this.persist(data);
  }

  /** Human-readable note about where secrets live and how protected they are. */
  describeStorage(): string {
    return `file \`${this.filePath}\` (owner-only permissions, not encrypted)`;
  }

  private load(): Record<string, string> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
      this.cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>)
              .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          )
        : {};
    } catch {
      this.cache = {};
    }

    return this.cache;
  }

  private async persist(data: Record<string, string>): Promise<void> {
    this.cache = data;
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    /* writeFile only applies mode when creating the file. */
    await fs.promises.chmod(this.filePath, 0o600).catch(() => undefined);
  }
}
