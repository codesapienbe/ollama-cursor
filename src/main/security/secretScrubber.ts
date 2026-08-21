// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
const MASK = '******';
const SECRET_KEY_NAME = /(token|secret|api[_-]?key|password|passwd|auth|credential|bearer)/i;

export interface SecretScrubResult {
  readonly text: string;
  readonly redactionCount: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scrubSensitiveContent(input: string, knownSecrets: readonly string[] = []): SecretScrubResult {
  let text = input;
  let redactionCount = 0;

  const sortedKnownSecrets = [...knownSecrets]
    .map(secret => secret.trim())
    .filter(secret => secret.length >= 4)
    .sort((left, right) => right.length - left.length);

  for (const secret of sortedKnownSecrets) {
    const regex = new RegExp(escapeRegExp(secret), 'g');
    text = text.replace(regex, () => {
      redactionCount += 1;
      return MASK;
    });
  }

  text = text.replace(/\b(Bearer)\s+([A-Za-z0-9._-]{8,})\b/gi, (_match, prefix: string) => {
    redactionCount += 1;
    return `${prefix} ${MASK}`;
  });

  text = text.replace(
    /\b([A-Za-z_][A-Za-z0-9_-]{0,64})\b(\s*[:=]\s*)(['"]?)([^'"`\s]{8,})(\3)/g,
    (match, rawKey: string, separator: string, quote: string, rawValue: string) => {
      if (!SECRET_KEY_NAME.test(rawKey)) {
        return match;
      }
      if (/^::[A-Za-z][A-Za-z0-9_]*::$/.test(rawValue)) {
        return match;
      }
      redactionCount += 1;
      return `${rawKey}${separator}${quote}${MASK}${quote}`;
    }
  );

  const knownTokenPatterns = [
    /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
    /\bsk-[A-Za-z0-9_-]{12,}\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    /\bAIza[0-9A-Za-z\-_]{30,}\b/g
  ];

  for (const pattern of knownTokenPatterns) {
    text = text.replace(pattern, () => {
      redactionCount += 1;
      return MASK;
    });
  }

  return { text, redactionCount };
}
