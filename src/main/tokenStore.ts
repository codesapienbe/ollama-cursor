import * as vscode from 'vscode';

const TOKEN_KEY_REGEX = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const INDEX_SECRET_KEY = 'olliberty.tokens.index';
const TOKEN_SECRET_PREFIX = 'olliberty.token.';

export interface TokenResolutionResult {
  readonly text: string;
  readonly missingKeys: string[];
}

export class TokenStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async setToken(key: string, value: string): Promise<string> {
    const normalizedKey = this.normalizeKey(key);
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      throw new Error('Token value cannot be empty.');
    }

    await this.secrets.store(this.tokenSecretName(normalizedKey), normalizedValue);

    const knownKeys = await this.listTokenKeys();
    if (!knownKeys.includes(normalizedKey)) {
      await this.storeKeyIndex([...knownKeys, normalizedKey]);
    }

    return normalizedKey;
  }

  async deleteToken(key: string): Promise<boolean> {
    const normalizedKey = this.normalizeKey(key);
    const existing = await this.secrets.get(this.tokenSecretName(normalizedKey));
    if (!existing) {
      return false;
    }

    await this.secrets.delete(this.tokenSecretName(normalizedKey));
    const knownKeys = await this.listTokenKeys();
    await this.storeKeyIndex(knownKeys.filter(knownKey => knownKey !== normalizedKey));
    return true;
  }

  async listTokenKeys(): Promise<string[]> {
    const keys = await this.readKeyIndex();
    if (!keys.length) {
      return [];
    }

    const existingEntries = await Promise.all(
      keys.map(async key => ({
        key,
        exists: Boolean(await this.secrets.get(this.tokenSecretName(key)))
      }))
    );

    const existingKeys = existingEntries
      .filter(entry => entry.exists)
      .map(entry => entry.key)
      .sort((left, right) => left.localeCompare(right));

    if (existingKeys.length !== keys.length) {
      await this.storeKeyIndex(existingKeys);
    }

    return existingKeys;
  }

  async listTokenValues(): Promise<string[]> {
    const keys = await this.listTokenKeys();
    const values = await Promise.all(
      keys.map(async key => this.secrets.get(this.tokenSecretName(key)))
    );

    return values
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
  }

  async resolvePlaceholders(input: string): Promise<TokenResolutionResult> {
    const placeholderRegex = /::([A-Za-z][A-Za-z0-9_]*)::/g;
    const matches = Array.from(input.matchAll(placeholderRegex));
    if (!matches.length) {
      return { text: input, missingKeys: [] };
    }

    const uniqueKeys = Array.from(
      new Set(matches.map(match => this.normalizeKey(match[1])))
    );

    const replacementMap = new Map<string, string>();
    const missingKeys: string[] = [];
    for (const key of uniqueKeys) {
      const value = await this.secrets.get(this.tokenSecretName(key));
      if (value) {
        replacementMap.set(key, value);
      } else {
        missingKeys.push(key);
      }
    }

    const text = input.replace(placeholderRegex, (_fullMatch, rawKey: string) => {
      const normalizedKey = this.normalizeKey(rawKey);
      return replacementMap.get(normalizedKey) ?? `::${normalizedKey}::`;
    });

    return { text, missingKeys };
  }

  private tokenSecretName(key: string): string {
    return `${TOKEN_SECRET_PREFIX}${key}`;
  }

  private normalizeKey(key: string): string {
    const normalized = key.trim().toUpperCase();
    if (!TOKEN_KEY_REGEX.test(normalized)) {
      throw new Error('Token key must match [A-Za-z][A-Za-z0-9_]{0,63}.');
    }
    return normalized;
  }

  private async readKeyIndex(): Promise<string[]> {
    const raw = await this.secrets.get(INDEX_SECRET_KEY);
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter((key): key is string => typeof key === 'string' && TOKEN_KEY_REGEX.test(key))
        .map(key => key.trim().toUpperCase());
    } catch {
      return [];
    }
  }

  private async storeKeyIndex(keys: string[]): Promise<void> {
    const normalized = Array.from(
      new Set(keys.map(key => this.normalizeKey(key)))
    ).sort((left, right) => left.localeCompare(right));
    await this.secrets.store(INDEX_SECRET_KEY, JSON.stringify(normalized));
  }
}
