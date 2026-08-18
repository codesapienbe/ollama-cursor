import * as path from 'path';
import * as vscode from 'vscode';
import { ActivityReporter } from './activity';
import { OllamaClient } from './client';
import { CodeIndexStore } from './codeIndex';
import { FileDiff, computeFileDiff, formatDiffForChat } from './diff';
import { getCurrentWorkspaceFolder } from './workspaceContext';

export interface ProposedFileEdit {
  filePath: string;
  newContent: string;
}

export interface EditProposal {
  summary: string;
  edits: ProposedFileEdit[];
  rawResponse: string;
}

export interface AppliedChange {
  filePath: string;
  appliedAt: number;
  isNewFile: boolean;
  additions: number;
  removals: number;
  previousContent: string;
  newContent: string;
}

interface ParsedEditProposal {
  summary?: string;
  edits?: unknown;
}

interface ParsedFileEdit {
  filePath?: unknown;
  newContent?: unknown;
}

const MAX_EDITOR_CONTEXT_CHARS = 14_000;
const EDIT_PREVIEW_SCHEME = 'olliberty-edit-preview';
const MAX_STORED_PREVIEW_DOCS = 240;

export class AgentEditService {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly appliedChanges: AppliedChange[] = [];
  private readonly previewContentByUri = new Map<string, string>();
  private readonly previewContentProvider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: (uri: vscode.Uri) => this.previewContentByUri.get(uri.toString()) ?? ''
  };

  constructor(
    private readonly client: OllamaClient,
    private readonly codeIndex: CodeIndexStore,
    private readonly activity: ActivityReporter
  ) {}

  registerPreviewContentProvider(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(
      EDIT_PREVIEW_SCHEME,
      this.previewContentProvider
    );
  }

  async createProposal(
    instruction: string,
    editor: vscode.TextEditor | undefined,
    signal?: AbortSignal
  ): Promise<EditProposal> {
    const workspaceFolder = this.getWorkspaceFolder(editor?.document.uri);
    const editorContext = this.buildEditorContext(editor);
    const indexedContext = await this.activity.run(
      'Reading workspace index',
      async step => {
        const context = await this.codeIndex.buildPromptContext(instruction, 4);
        step.update(context ? `${context.length} chars of context` : 'no indexed context');
        return context;
      }
    );

    const prompt = [
      'You are a local coding agent running inside VS Code.',
      'Create a safe file edit plan for the instruction below.',
      '',
      'Return ONLY valid JSON (no markdown, no explanation) in this exact shape:',
      '{"summary":"short summary","edits":[{"filePath":"relative/path/from/workspace","newContent":"full file content"}]}',
      '',
      'Rules:',
      '- Use workspace-relative file paths.',
      '- Never use absolute paths.',
      '- Never include ".." path traversal.',
      '- Include complete file content for each edited file.',
      '- Keep edits minimal and directly related to the instruction.',
      '',
      `Workspace root: ${workspaceFolder.uri.fsPath}`,
      '',
      editorContext,
      indexedContext ? `Indexed workspace context:\n${indexedContext}` : '',
      '',
      `Instruction:\n${instruction}`
    ].filter(Boolean).join('\n');

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

    const proposal = this.parseProposal(response);
    const summary = proposal.summary?.trim() || `Proposed ${proposal.edits.length} file edit(s).`;
    return {
      summary,
      edits: proposal.edits,
      rawResponse: response
    };
  }

  async applyProposal(proposal: EditProposal): Promise<AppliedChange[]> {
    const workspaceFolder = this.getWorkspaceFolder();
    const applied: AppliedChange[] = [];

    for (const edit of proposal.edits) {
      const targetUri = this.resolveTargetUri(workspaceFolder.uri, edit.filePath);
      const dirtyDoc = vscode.workspace.textDocuments.find(
        document => document.uri.toString() === targetUri.toString() && document.isDirty
      );
      if (dirtyDoc) {
        throw new Error(`Cannot apply edit to ${edit.filePath} because the file has unsaved changes.`);
      }

      const stepId = this.activity.begin(`Writing ${edit.filePath}`);
      try {
        const existed = await this.fileExists(targetUri);
        const previousContent = existed ? await this.readFileContent(targetUri) : '';
        const diff = computeFileDiff(edit.filePath, previousContent, edit.newContent);

        const directoryUri = vscode.Uri.file(path.dirname(targetUri.fsPath));
        await vscode.workspace.fs.createDirectory(directoryUri);
        await vscode.workspace.fs.writeFile(targetUri, this.encoder.encode(edit.newContent));

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

  /** Every file this session has written, newest last. */
  listAppliedChanges(): AppliedChange[] {
    return this.appliedChanges.map(change => ({ ...change }));
  }

  clearAppliedChanges(): void {
    this.appliedChanges.length = 0;
  }

  /** Reopen the before/after diff for an already-applied change. */
  async showAppliedChangeDiff(filePath: string): Promise<void> {
    const change = [...this.appliedChanges].reverse().find(entry => entry.filePath === filePath);
    if (!change) {
      throw new Error(`No recorded change for ${filePath}.`);
    }

    const beforeUri = this.buildPreviewUri(filePath, 'before', this.appliedChanges.length);
    const afterUri = this.buildPreviewUri(filePath, 'after', this.appliedChanges.length);
    this.storePreviewContent(beforeUri, change.previousContent);
    this.storePreviewContent(afterUri, change.newContent);

    await vscode.commands.executeCommand(
      'vscode.diff',
      beforeUri,
      afterUri,
      `Olliberty Applied · ${filePath}`,
      { preview: false }
    );
  }

  /** Diff each proposed edit against what is on disk right now. */
  async buildProposalDiffs(proposal: EditProposal): Promise<FileDiff[]> {
    const workspaceFolder = this.getWorkspaceFolder();
    const diffs: FileDiff[] = [];

    for (const edit of proposal.edits) {
      const targetUri = this.resolveTargetUri(workspaceFolder.uri, edit.filePath);
      const exists = await this.fileExists(targetUri);
      const currentContent = exists ? await this.readFileContent(targetUri) : '';
      diffs.push(computeFileDiff(edit.filePath, currentContent, edit.newContent));
    }

    return diffs;
  }

  async showProposalDiffs(proposal: EditProposal): Promise<void> {
    const workspaceFolder = this.getWorkspaceFolder();

    for (const [index, edit] of proposal.edits.entries()) {
      const targetUri = this.resolveTargetUri(workspaceFolder.uri, edit.filePath);
      const exists = await this.fileExists(targetUri);
      const currentContent = exists ? await this.readFileContent(targetUri) : '';
      const beforeUri = this.buildPreviewUri(edit.filePath, 'before', index);
      const afterUri = this.buildPreviewUri(edit.filePath, 'after', index);

      this.storePreviewContent(beforeUri, currentContent);
      this.storePreviewContent(afterUri, edit.newContent);

      const title = exists
        ? `Olliberty Edit Preview · ${edit.filePath}`
        : `Olliberty Edit Preview · ${edit.filePath} (new file)`;

      await vscode.commands.executeCommand(
        'vscode.diff',
        beforeUri,
        afterUri,
        title,
        {
          preview: false,
          preserveFocus: index > 0
        }
      );
    }
  }

  async revealAppliedFiles(filePaths: string[]): Promise<void> {
    const workspaceFolder = this.getWorkspaceFolder();

    for (const [index, filePath] of filePaths.entries()) {
      const targetUri = this.resolveTargetUri(workspaceFolder.uri, filePath);
      const document = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: index > 0,
        viewColumn: vscode.ViewColumn.Active
      });
    }
  }

  /** Full proposal rendering: summary, per-file stats, and inline diffs. */
  async formatProposalForChat(proposal: EditProposal): Promise<string> {
    const diffs = await this.buildProposalDiffs(proposal);
    const totalAdditions = diffs.reduce((sum, diff) => sum + diff.additions, 0);
    const totalRemovals = diffs.reduce((sum, diff) => sum + diff.removals, 0);

    return [
      `🛠️ **${proposal.summary}**`,
      `${diffs.length} file(s) · +${totalAdditions} −${totalRemovals}`,
      '',
      ...diffs.map(diff => formatDiffForChat(diff, 'Update'))
    ].join('\n');
  }

  formatAppliedChangesForChat(changes: AppliedChange[]): string {
    const totalAdditions = changes.reduce((sum, change) => sum + change.additions, 0);
    const totalRemovals = changes.reduce((sum, change) => sum + change.removals, 0);

    const blocks = changes.map(change =>
      formatDiffForChat(
        computeFileDiff(change.filePath, change.previousContent, change.newContent),
        'Applied'
      )
    );

    return [
      `✅ **Applied ${changes.length} file change(s)** · +${totalAdditions} −${totalRemovals}`,
      '',
      ...blocks
    ].join('\n');
  }

  private parseProposal(rawResponse: string): { summary?: string; edits: ProposedFileEdit[] } {
    const jsonText = this.extractJson(rawResponse);
    let parsed: ParsedEditProposal;

    try {
      parsed = JSON.parse(jsonText) as ParsedEditProposal;
    } catch {
      throw new Error('Edit generation failed: model returned invalid JSON. Try a more specific /edit instruction.');
    }

    const rawEdits = Array.isArray(parsed.edits) ? parsed.edits : [];
    const edits = rawEdits
      .map(item => this.toFileEdit(item))
      .filter((edit): edit is ProposedFileEdit => edit !== null);

    if (!edits.length) {
      throw new Error('Edit generation failed: no valid file edits were returned.');
    }

    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      edits
    };
  }

  private toFileEdit(candidate: unknown): ProposedFileEdit | null {
    if (!candidate || typeof candidate !== 'object') {
      return null;
    }

    const raw = candidate as ParsedFileEdit;
    if (typeof raw.filePath !== 'string' || typeof raw.newContent !== 'string') {
      return null;
    }

    const normalizedPath = this.normalizePath(raw.filePath);
    return {
      filePath: normalizedPath,
      newContent: raw.newContent
    };
  }

  private normalizePath(inputPath: string): string {
    const normalized = inputPath.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!normalized) {
      throw new Error('Edit generation failed: empty file path returned.');
    }

    if (path.isAbsolute(normalized)) {
      throw new Error(`Edit generation failed: absolute path '${inputPath}' is not allowed.`);
    }

    const segments = normalized.split('/');
    if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
      throw new Error(`Edit generation failed: unsafe file path '${inputPath}'.`);
    }

    return segments.join('/');
  }

  private extractJson(rawResponse: string): string {
    const fencedMatch = rawResponse.match(/```json\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      return fencedMatch[1].trim();
    }

    const firstBrace = rawResponse.indexOf('{');
    const lastBrace = rawResponse.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error('Edit generation failed: model did not return a JSON payload.');
    }

    return rawResponse.slice(firstBrace, lastBrace + 1).trim();
  }

  private buildEditorContext(editor: vscode.TextEditor | undefined): string {
    if (!editor) {
      return 'Active file context: none';
    }

    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
    const selection = editor.selection;
    const selectedText = selection.isEmpty ? '' : editor.document.getText(selection);
    const fullText = editor.document.getText();
    const contextText = selectedText || fullText.slice(0, MAX_EDITOR_CONTEXT_CHARS);
    const scopeLabel = selectedText ? 'selected text' : 'file snapshot';

    return [
      `Active file (${scopeLabel}): ${relativePath}`,
      `\`\`\`${editor.document.languageId}`,
      contextText,
      '```'
    ].join('\n');
  }

  private getWorkspaceFolder(preferredUri?: vscode.Uri): vscode.WorkspaceFolder {
    const folder = getCurrentWorkspaceFolder(preferredUri);
    if (!folder) {
      throw new Error('No workspace folder is open.');
    }
    return folder;
  }

  private resolveTargetUri(workspaceUri: vscode.Uri, filePath: string): vscode.Uri {
    return vscode.Uri.joinPath(workspaceUri, ...filePath.split('/'));
  }

  private async fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private async readFileContent(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return this.decoder.decode(bytes);
  }

  private buildPreviewUri(filePath: string, side: 'before' | 'after', index: number): vscode.Uri {
    const encodedPath = filePath
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
    const nonce = `${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 8)}`;

    return vscode.Uri.from({
      scheme: EDIT_PREVIEW_SCHEME,
      path: `/${encodedPath}`,
      query: `${side}-${nonce}`
    });
  }

  private storePreviewContent(uri: vscode.Uri, content: string): void {
    this.previewContentByUri.set(uri.toString(), content);

    while (this.previewContentByUri.size > MAX_STORED_PREVIEW_DOCS) {
      const oldestKey = this.previewContentByUri.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.previewContentByUri.delete(oldestKey);
    }
  }
}
