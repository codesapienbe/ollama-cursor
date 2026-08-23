// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Stateless HTTP client that streams tokens from the Ollama
 *  LLM server.  Dependency-Inversion: accepts an abstract Settings
 *  interface instead of querying VS Code directly.               */

import * as https from 'https';
import * as http from 'http';
import { OllibertySettings, ReasoningEffort } from './core/settingsContract';

export interface GenerateParams {
  prompt: string;
  stream?: boolean;
  /** Called for every chunk while streaming, so callers can render partial output. */
  onToken?: (chunk: string, fullResponse: string) => void;
  /* Reasoning models stream their scratchpad in a separate `thinking` field.
     It never counts as the answer, but it proves the model is alive while the
     answer is still empty. */
  onThinking?: (chunk: string, fullThinking: string) => void;
  /** Aborts the in-flight request when the user interrupts the run. */
  signal?: AbortSignal;
  /* Reasoning switch for models that support it. Sub-agents set this to false:
     their whole token budget then goes to the answer instead of a scratchpad
     nobody reads, which is both faster and impossible to come back empty.
     Left undefined the field is omitted and the model keeps its default. */
  think?: boolean;
  /** Per-request answer budget; falls back to the configured maxTokens. */
  numPredict?: number;
  /** Per-request context window; falls back to the configured contextLength. */
  numCtx?: number;
  /* Ollama serialises requests per loaded model, so a fanned-out agent can sit
     in the server queue for minutes before its first token. That wait is not a
     hang and must not share a budget with the between-token idle timeout. */
  firstTokenTimeoutMs?: number;
}

/** Thrown when the user stops a run; callers treat this as "not an error". */
export class AbortedError extends Error {
  constructor(message = 'Stopped by user.') {
    super(message);
    this.name = 'AbortedError';
  }
}

export function isAbortedError(error: unknown): boolean {
  return error instanceof AbortedError;
}

/**
 * The request succeeded but the answer is empty — a reasoning model spent its
 * whole `num_predict` budget on thinking tokens. Distinct from a failure so
 * callers can retry with reasoning off instead of reporting a blank answer.
 */
export class EmptyAnswerError extends Error {
  constructor(
    readonly thinkingChars: number,
    readonly doneReason: string,
    message = 'The model returned reasoning but no answer. Raise maxTokens or turn reasoning off for this call.'
  ) {
    super(message);
    this.name = 'EmptyAnswerError';
  }
}

export function isEmptyAnswerError(error: unknown): boolean {
  return error instanceof EmptyAnswerError;
}

/*  Rough characters-per-token for source code and English prose. Deliberately
    conservative: overshooting means Ollama silently drops the front of the
    prompt, which is where the instructions live.                            */
const CHARS_PER_TOKEN = 3.2;
/** Tokens held back for the system prompt, effort preamble and framing. */
const PROMPT_OVERHEAD_TOKENS = 320;

/**
 * How many characters of prompt actually fit next to an answer of
 * `numPredict` tokens inside a `numCtx` window. Callers size their context
 * blocks with this instead of a fixed constant that ignores the window.
 */
export function promptCharBudget(numCtx: number, numPredict: number): number {
  const usableTokens = numCtx - numPredict - PROMPT_OVERHEAD_TOKENS;
  return Math.max(1_000, Math.floor(usableTokens * CHARS_PER_TOKEN));
}

export class OllamaClient {
  private readonly settings: OllibertySettings;

  constructor(settings: OllibertySettings) {
    this.settings = settings;
  }

  private transport(url: URL) {
    return url.protocol === 'https:' ? https : http;
  }

  /**
   * Streams one completion. Resolves with the answer text only — reasoning
   * tokens are reported through `onThinking` and never concatenated into it.
   */
  async generate(params: GenerateParams, abort?: AbortSignal): Promise<string> {
    const signal = params.signal ?? abort;
    if (signal?.aborted) {
      throw new AbortedError();
    }

    const numPredict = params.numPredict ?? this.settings.maxTokens;
    const numCtx = params.numCtx ?? this.settings.contextLength;
    /* A call with reasoning explicitly off carries its own output contract —
       a role brief, or "return only this JSON". Prefixing it with "use deeper
       reasoning" would contradict both the contract and `think: false`. */
    const prompt = params.think === false
      ? params.prompt
      : this.applyEffortToPrompt(params.prompt);
    const requestData = JSON.stringify({
      model: this.settings.model,
      prompt,
      ...(this.settings.systemPrompt ? { system: this.settings.systemPrompt } : {}),
      ...(params.think === undefined ? {} : { think: params.think }),
      stream: params.stream ?? false,
      options: {
        /* Ollama reads sampling parameters from `options` only. A top-level
           `temperature` is accepted and silently ignored, so the configured
           value never reached the model. */
        temperature: this.settings.temperature,
        num_predict: numPredict,
        num_ctx: numCtx,
      },
    });

    const url = new URL('/api/generate', this.settings.url);
    this.settings.assertUrlAllowed(url);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestData)
      }
    };

    /* Two budgets, not one. The first covers the wait in Ollama's queue (a
       cold 27B model behind two other requests is minutes, not seconds); the
       second covers silence *after* generation has started, which is the only
       silence that actually means something is wrong. */
    const queueBudget = Math.max(
      params.firstTokenTimeoutMs ?? this.settings.queueTimeoutMs,
      this.settings.timeoutMs
    );
    const idleBudget = this.settings.timeoutMs;

    return new Promise<string>((rawResolve, rawReject) => {
      let settled = false;
      let onAbort: (() => void) | undefined;
      /* Which budget a timeout belongs to, so the message names the real
         problem: a queue that never got to us, or a stream that went quiet. */
      let streamingStarted = false;

      const cleanup = () => {
        if (onAbort && signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };
      const resolve = (value: string) => {
        if (settled) { return; }
        settled = true;
        cleanup();
        rawResolve(value);
      };
      const reject = (error: Error) => {
        if (settled) { return; }
        settled = true;
        cleanup();
        rawReject(error);
      };

      const req = this.transport(url).request(url, options, (res) => {
        if (res.statusCode !== 200) {
          let errorBody = '';
          res.on('data', (chunk) => {
            if (errorBody.length < 4000) {
              errorBody += chunk.toString();
            }
          });
          res.on('end', () => {
            reject(new Error(this.formatHttpError(res.statusCode ?? 0, res.statusMessage ?? '', errorBody)));
          });
          return;
        }

        let responseData = '';
        let fullResponse = '';
        let fullThinking = '';
        let doneReason = '';
        let sawFirstToken = false;

        /* The queue wait is over the moment anything generated arrives, so the
           socket drops to the tighter idle budget from here on. */
        const markFirstToken = () => {
          if (sawFirstToken) { return; }
          sawFirstToken = true;
          streamingStarted = true;
          req.setTimeout(idleBudget);
        };

        const consume = (line: string): boolean => {
          let parsed: { response?: unknown; thinking?: unknown; done?: unknown; done_reason?: unknown };
          try {
            parsed = JSON.parse(line);
          } catch {
            /* A partial line: the next chunk completes it. */
            return false;
          }

          if (typeof parsed.thinking === 'string' && parsed.thinking) {
            markFirstToken();
            fullThinking += parsed.thinking;
            params.onThinking?.(parsed.thinking, fullThinking);
          }
          if (typeof parsed.response === 'string' && parsed.response) {
            markFirstToken();
            fullResponse += parsed.response;
            params.onToken?.(parsed.response, fullResponse);
          }
          if (typeof parsed.done_reason === 'string') {
            doneReason = parsed.done_reason;
          }
          return parsed.done === true;
        };

        const finish = () => {
          if (fullResponse.trim()) {
            resolve(fullResponse);
            return;
          }
          /* Reasoning arrived but no answer did: the budget went to the
             scratchpad. Callers retry with reasoning off rather than showing
             the user an empty turn. */
          if (fullThinking.trim()) {
            reject(new EmptyAnswerError(fullThinking.length, doneReason || 'unknown'));
            return;
          }
          reject(new Error('No response received from Ollama'));
        };

        res.on('data', (chunk) => {
          if (!params.stream) {
            responseData += chunk.toString();
            return;
          }

          responseData += chunk.toString();
          const lines = responseData.split('\n');
          responseData = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) {
              continue;
            }
            if (consume(line)) {
              finish();
              return;
            }
          }
        });

        res.on('end', () => {
          if (!params.stream) {
            try {
              const parsed = JSON.parse(responseData) as {
                response?: unknown;
                thinking?: unknown;
                done_reason?: unknown;
              };
              fullResponse = typeof parsed.response === 'string' ? parsed.response : '';
              fullThinking = typeof parsed.thinking === 'string' ? parsed.thinking : '';
              doneReason = typeof parsed.done_reason === 'string' ? parsed.done_reason : '';
              if (!fullResponse.trim() && !fullThinking.trim()) {
                resolve(responseData);
                return;
              }
            } catch {
              resolve(responseData);
              return;
            }
          }
          finish();
        });

        res.on('error', (err) => {
          reject(err);
        });
      });

      req.on('error', (err) => {
        reject(new Error(`Failed to connect to Ollama: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(this.formatTimeoutError(streamingStarted, streamingStarted ? idleBudget : queueBudget)));
      });

      /* User interruption: kill the socket so Ollama stops generating,
         and report it as a cancellation rather than a failure. */
      if (signal) {
        onAbort = () => {
          req.destroy();
          reject(new AbortedError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      req.setTimeout(queueBudget);
      req.write(requestData);
      req.end();
    });
  }

  /* Health check method */
  async isHealthy(): Promise<boolean> {
    try {
      const url = new URL('/api/tags', this.settings.url);
      this.settings.assertUrlAllowed(url);
      const options = {
        method: 'GET',
        timeout: 5000,
      };

      return new Promise<boolean>((resolve) => {
        const req = this.transport(url).request(url, options, (res) => {
          resolve(res.statusCode === 200);
        });

        req.on('error', () => {
          resolve(false);
        });

        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });

        req.setTimeout(5000);
        req.end();
      });
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    const url = new URL('/api/tags', this.settings.url);
    this.settings.assertUrlAllowed(url);
    const options = {
      method: 'GET',
      timeout: 10_000,
    };

    return new Promise<string[]>((resolve, reject) => {
      const req = this.transport(url).request(url, options, (res) => {
        if (res.statusCode !== 200) {
          let errorBody = '';
          res.on('data', chunk => {
            if (errorBody.length < 4000) {
              errorBody += chunk.toString();
            }
          });
          res.on('end', () => {
            reject(new Error(this.formatHttpError(res.statusCode ?? 0, res.statusMessage ?? '', errorBody)));
          });
          return;
        }

        let body = '';
        res.on('data', chunk => {
          body += chunk.toString();
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { models?: Array<{ name?: string; model?: string }> };
            const models = (parsed.models ?? [])
              .map(entry => entry.name ?? entry.model)
              .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
            resolve(models);
          } catch {
            reject(new Error('Failed to parse model list from Ollama'));
          }
        });

        res.on('error', (err) => {
          reject(err);
        });
      });

      req.on('error', (err) => {
        reject(new Error(`Failed to connect to Ollama: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request to Ollama timed out'));
      });

      req.setTimeout(10_000);
      req.end();
    });
  }

  getCurrentModel(): string {
    return this.settings.model;
  }

  async setModel(model: string): Promise<void> {
    await this.settings.setModel(model);
  }

  getEffort(): ReasoningEffort {
    return this.settings.effort;
  }

  async setEffort(effort: ReasoningEffort): Promise<void> {
    await this.settings.setEffort(effort);
  }

  private applyEffortToPrompt(prompt: string): string {
    const instructionsByEffort: Record<ReasoningEffort, string> = {
      minimal: 'Keep reasoning minimal and provide a direct answer.',
      low: 'Use light reasoning and keep the response concise.',
      medium: 'Use balanced reasoning with concise explanations.',
      high: 'Use deeper reasoning, including key tradeoffs and edge cases.',
      max: 'Use very thorough reasoning before giving the final answer.'
    };

    return `[Reasoning effort: ${this.settings.effort}] ${instructionsByEffort[this.settings.effort]}\n\n${prompt}`;
  }

  /* Two very different failures used to share one message. Naming which
     budget expired is the difference between "raise the timeout" and "the
     model server is wedged". */
  private formatTimeoutError(streamingStarted: boolean, budgetMs: number): string {
    const seconds = Math.round(budgetMs / 1000);
    return streamingStarted
      ? `Ollama stopped sending tokens for ${seconds}s. Raise olliberty.timeoutMs if the model is simply slow.`
      : `Ollama did not start responding within ${seconds}s — it is likely still busy with another request. `
        + 'Raise olliberty.queueTimeoutMs, or lower olliberty.agents.maxParallel so fewer requests queue at once.';
  }

  private formatHttpError(statusCode: number, statusMessage: string, responseBody: string): string {
    const parsedMessage = this.extractOllamaError(responseBody);
    if (parsedMessage) {
      return `Ollama: HTTP ${statusCode} ${statusMessage} ${parsedMessage}`;
    }
    return `Ollama: HTTP ${statusCode} ${statusMessage}`;
  }

  private extractOllamaError(responseBody: string): string {
    if (!responseBody.trim()) {
      return '';
    }

    try {
      const parsed = JSON.parse(responseBody) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
        return parsed.error;
      }
    } catch {
      // Ignore non-JSON responses and fall back to plain text.
    }

    return responseBody.trim().slice(0, 240);
  }
}
