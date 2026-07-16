/*  Stateless HTTP client that streams tokens from the Ollama
 *  daemon.  Dependency-Inversion: accepts an abstract Settings
 *  interface instead of querying VS Code directly.               */

import * as https from 'https';
import * as http from 'http';
import { Settings } from './settings';

export interface GenerateParams {
  prompt: string;
  stream?: boolean;
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
    const requestData = JSON.stringify({
      model: this.settings.model,
      prompt: params.prompt,
      ...(this.settings.systemPrompt ? { system: this.settings.systemPrompt } : {}),
      temperature: this.settings.temperature,
      stream: params.stream ?? false,
      options: {
        num_predict: this.settings.maxTokens,
        num_ctx: this.settings.contextLength,
      },
    });

    const url = new URL('/api/generate', this.settings.url);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestData)
      }
    };

    return new Promise<string>((resolve, reject) => {
      const req = this.transport(url).request(url, options, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Ollama: HTTP ${res.statusCode} ${res.statusMessage}`));
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

      // Handle abort signal
      if (abort) {
        abort.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('Request was aborted'));
        });
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
}
