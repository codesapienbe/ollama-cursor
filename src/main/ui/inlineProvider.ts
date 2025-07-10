/*  UI: ghost-text completions while typing.
 *  - Streams tokens into an InlineCompletionItem.
 *  - Abides by KISS: no context caching or diffing yet.          */

import * as vscode from 'vscode';
import { OllamaClient } from '../client';

export class InlineProvider implements vscode.InlineCompletionItemProvider {
  constructor(private readonly client: OllamaClient) {}

  async provideInlineCompletionItems(
    doc : vscode.TextDocument,
    pos : vscode.Position,
    _ctx: vscode.InlineCompletionContext,
    tok : vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | undefined> {

    /* Extract last ~2 000 characters above caret for context */
    const above = doc.getText(new vscode.Range(
      pos.translate(0, -2_000).with(undefined, 0),
      pos,
    ));
    if (!above.trim()) return;

    const abort = new AbortController();
    tok.onCancellationRequested(() => abort.abort());

    /* Get completion and build the InlineCompletionItem */
    const completion = await this.client.generate({ prompt: above, stream: true }, abort.signal);
    if (!completion) return;

    const item = new vscode.InlineCompletionItem(completion, new vscode.Range(pos, pos));

    return new vscode.InlineCompletionList([item]);
  }
}
