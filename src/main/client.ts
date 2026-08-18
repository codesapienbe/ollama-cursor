/*  Stateless HTTP client that streams tokens from the Ollama
 *  daemon.  Dependency-Inversion: accepts an abstract Settings
 *  interface instead of querying VS Code directly.               */

import * as https from 'https';
import * as http from 'http';
import { ReasoningEffort, Settings } from './settings';

export interface GenerateParams {
  prompt: string;
  stream?: boolean;
  /** Called for every chunk while streaming, so callers can render partial output. */
  onToken?: (chunk: string, fullResponse: string) => void;
  /** Aborts the in-flight request when the user interrupts the run. */
  signal?: AbortSignal;
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

export class OllamaClient {
  private readonly settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  private transport(url: URL) {
    return url.protocol === 'https:' ? https : http;
  }

  /* High-level streaming function used by UI components */
  async generate(params: GenerateParams, abort?: AbortSignal): Promise<string> {
    const signal = params.signal ?? abort;
    if (signal?.aborted) {
      throw new AbortedError();
    }

    const prompt = this.applyEffortToPrompt(params.prompt);
    const requestData = JSON.stringify({
      model: this.settings.model,
      prompt,
      ...(this.settings.systemPrompt ? { system: this.settings.systemPrompt } : {}),
      temperature: this.settings.temperature,
      stream: params.stream ?? false,
      options: {
        num_predict: this.settings.maxTokens,
        num_ctx: this.settings.contextLength,
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

    return new Promise<string>((rawResolve, rawReject) => {
      let settled = false;
      let onAbort: (() => void) | undefined;

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

        res.on('data', (chunk) => {
          responseData += chunk.toString();
          
          // Handle streaming response
          if (params.stream) {
            const lines = responseData.split('\n');
            responseData = lines.pop() || ''; // Keep incomplete line
            
            for (const line of lines) {
              if (line.trim()) {
                try {
                  const parsed = JSON.parse(line);
                  if (parsed.response) {
                    fullResponse += parsed.response;
                    params.onToken?.(parsed.response as string, fullResponse);
                  }
                  if (parsed.done) {
                    resolve(fullResponse);
                    return;
                  }
                } catch (e) {
                  // Ignore JSON parsing errors for partial responses
                }
              }
            }
          }
        });

        res.on('end', () => {
          if (!params.stream) {
            try {
              const parsed = JSON.parse(responseData);
              resolve(parsed.response || responseData);
            } catch (e) {
              resolve(responseData);
            }
          } else if (fullResponse) {
            resolve(fullResponse);
          } else {
            reject(new Error('No response received from Ollama'));
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

      /* User interruption: kill the socket so Ollama stops generating,
         and report it as a cancellation rather than a failure. */
      if (signal) {
        onAbort = () => {
          req.destroy();
          reject(new AbortedError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      req.setTimeout(this.settings.timeoutMs);
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
