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
  private readonly baseUrl = 'http://localhost:11434/api/generate';

  constructor(settings: Settings) {
    this.settings = settings;
  }

  /* High-level streaming function used by UI components */
  async generate(params: GenerateParams, abort?: AbortSignal): Promise<string> {
    const requestData = JSON.stringify({
      model: this.settings.model,
      temperature: this.settings.temperature,
      ...params,
    });

    const options = {
      hostname: 'localhost',
      port: 11434,
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestData)
      }
    };

    return new Promise<string>((resolve, reject) => {
      const req = http.request(options, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Ollama: HTTP ${res.statusCode} ${res.statusMessage}`));
          return;
        }

        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk.toString();
        });

        res.on('end', () => {
          resolve(responseData);
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.write(requestData);
      req.end();
    });
  }
}
