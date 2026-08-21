// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  CLI file editing: generate a proposal, render the diffs in the terminal,
 *  and write only after an explicit approval. Prompt, JSON contract, path
 *  safety, and chat formatting come from core/editProposal, so the CLI and
 *  the IDE plugin propose and apply edits identically.                    */

import * as fs from 'fs';
import * as path from 'path';
import { OllamaClient } from '../main/client';
import { ActivitySink } from '../main/core/activityContract';
import { CodeContextProvider } from '../main/core/codeIndexContract';
import {
  AppliedChange,
  EditProposal,
  MAX_EDITOR_CONTEXT_CHARS,
  buildEditPrompt,
  formatAppliedChangesForChat,
  formatProposalForChat,
  parseProposalResponse
} from '../main/core/editProposal';
import { FileDiff, computeFileDiff } from '../main/diff';

export interface AttachedFile {
  relativePath: string;
  language: string;
  content: string;
  truncated: boolean;
}

export class CliEditService {
  private readonly appliedChanges: AppliedChange[] = [];

  constructor(
    private readonly client: OllamaClient,
    private readonly codeIndex: CodeContextProvider,
    private readonly activity: ActivitySink,
    private readonly workspaceRoot: string
  ) {}

  async createProposal(
    instruction: string,
    attachments: AttachedFile[],
    signal?: AbortSignal
  ): Promise<EditProposal> {
    const indexedContext = await this.activity.run(
      'Reading workspace index',
      async step => {
        const context = await this.codeIndex.buildPromptContext(instruction, 4);
        step.update(context ? `${context.length} chars of context` : 'no indexed context');
        return context;
      }
    );

    const prompt = buildEditPrompt({
      host: 'a terminal (Olliberty CLI)',
      workspaceRoot: this.workspaceRoot,
      editorContext: formatAttachments(attachments),
      indexedContext,
      instruction
    });

    const response = await this.activity.run(
      'Generating edit proposal',
      async step =>
        this.client.generate({
          prompt,
          stream: true,
          signal,
          onToken: (_chunk, full) => step.update(`${full.length} chars generated`)
        }),
      `model: ${this.client.getCurrentModel()}`
    );

    const parsed = parseProposalResponse(response);
    return {
      summary: parsed.summary?.trim() || `Proposed ${parsed.edits.length} file edit(s).`,
      edits: parsed.edits,
      rawResponse: response
    };
  }

  async buildProposalDiffs(proposal: EditProposal): Promise<FileDiff[]> {
    const diffs: FileDiff[] = [];
    for (const edit of proposal.edits) {
      const currentContent = await this.readFileOrEmpty(this.resolveTarget(edit.filePath));
      diffs.push(computeFileDiff(edit.filePath, currentContent, edit.newContent));
    }
    return diffs;
  }

  async formatProposalForChat(proposal: EditProposal): Promise<string> {
    return formatProposalForChat(proposal.summary, await this.buildProposalDiffs(proposal));
  }

  async applyProposal(proposal: EditProposal): Promise<AppliedChange[]> {
    const applied: AppliedChange[] = [];

    for (const edit of proposal.edits) {
      const targetPath = this.resolveTarget(edit.filePath);
      const stepId = this.activity.begin(`Writing ${edit.filePath}`);

      try {
        const existed = await this.fileExists(targetPath);
        const previousContent = existed ? await this.readFileOrEmpty(targetPath) : '';
        const diff = computeFileDiff(edit.filePath, previousContent, edit.newContent);

        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.promises.writeFile(targetPath, edit.newContent, 'utf8');

        const change: AppliedChange = {
          filePath: edit.filePath,
          appliedAt: Date.now(),
          isNewFile: !existed,
          additions: diff.additions,
          removals: diff.removals,
          previousContent,
          newContent: edit.newContent
        };
        this.appliedChanges.push(change);
        applied.push(change);
        this.activity.succeed(stepId, `+${diff.additions} -${diff.removals}`);
      } catch (error) {
        this.activity.fail(stepId, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }

    return applied;
  }

  listAppliedChanges(): AppliedChange[] {
    return this.appliedChanges.map(change => ({ ...change }));
  }

  clearAppliedChanges(): void {
    this.appliedChanges.length = 0;
  }

  /** Most recent recorded change for a path, for re-showing its diff. */
  findAppliedChange(filePath: string): AppliedChange | undefined {
    return [...this.appliedChanges].reverse().find(change => change.filePath === filePath);
  }

  formatAppliedChangesForChat(changes: AppliedChange[]): string {
    return formatAppliedChangesForChat(changes);
  }

  /** Second line of defence: never write outside the workspace root. */
  private resolveTarget(relativePath: string): string {
    const target = path.resolve(this.workspaceRoot, relativePath);
    const root = path.resolve(this.workspaceRoot);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Refusing to write outside the workspace root: ${relativePath}`);
    }
    return target;
  }

  private async fileExists(absolutePath: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(absolutePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  private async readFileOrEmpty(absolutePath: string): Promise<string> {
    try {
      return await fs.promises.readFile(absolutePath, 'utf8');
    } catch {
      return '';
    }
  }
}

/** The CLI's stand-in for "the active editor": files the user attached. */
export function formatAttachments(attachments: AttachedFile[]): string {
  if (!attachments.length) {
    return 'Active file context: none';
  }

  const blocks = attachments.map(attachment => {
    const body = attachment.content.slice(0, MAX_EDITOR_CONTEXT_CHARS);
    return [
      `Attached file: ${attachment.relativePath}${attachment.truncated ? ' (truncated)' : ''}`,
      `\`\`\`${attachment.language === 'plaintext' ? '' : attachment.language}`,
      body,
      '```'
    ].join('\n');
  });

  return blocks.join('\n\n');
}
