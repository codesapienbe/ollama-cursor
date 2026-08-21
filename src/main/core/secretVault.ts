// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Minimal secret storage port. `vscode.SecretStorage` satisfies it
 *  structurally, so the extension keeps using the OS keychain while the
 *  CLI supplies a file-backed vault.                                    */

export interface SecretVault {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}
