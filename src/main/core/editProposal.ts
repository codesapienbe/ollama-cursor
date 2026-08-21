/*  Host-agnostic file-edit proposal logic: prompt construction, strict JSON
 *  parsing, path safety, and chat rendering. The IDE plugin applies the
 *  result through the workspace filesystem, the CLI through node:fs, but
 *  the contract with the model — and the safety rules — are identical.    */

import * as path from 'path';
import { FileDiff, computeFileDiff, formatDiffForChat } from '../diff';

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

export const MAX_EDITOR_CONTEXT_CHARS = 14_000;

export interface EditPromptInput {
  /** Host label used in the system framing ("VS Code", "CLI", …). */
  host: string;
  workspaceRoot: string;
  editorContext: string;
  indexedContext: string;
  instruction: string;
}

export function buildEditPrompt(input: EditPromptInput): string {
  return [
    `You are a local coding agent running inside ${input.host}.`,
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
    `Workspace root: ${input.workspaceRoot}`,
    '',
    input.editorContext,
    input.indexedContext ? `Indexed workspace context:\n${input.indexedContext}` : '',
    '',
    `Instruction:\n${input.instruction}`
  ].filter(Boolean).join('\n');
}

export function parseProposalResponse(rawResponse: string): { summary?: string; edits: ProposedFileEdit[] } {
  const jsonText = extractJson(rawResponse);
  let parsed: ParsedEditProposal;

  try {
    parsed = JSON.parse(jsonText) as ParsedEditProposal;
  } catch {
    throw new Error('Edit generation failed: model returned invalid JSON. Try a more specific /edit instruction.');
  }

  const rawEdits = Array.isArray(parsed.edits) ? parsed.edits : [];
  const edits = rawEdits
    .map(item => toFileEdit(item))
    .filter((edit): edit is ProposedFileEdit => edit !== null);

  if (!edits.length) {
    throw new Error('Edit generation failed: no valid file edits were returned.');
  }

  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
    edits
  };
}

function toFileEdit(candidate: unknown): ProposedFileEdit | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const raw = candidate as ParsedFileEdit;
  if (typeof raw.filePath !== 'string' || typeof raw.newContent !== 'string') {
    return null;
  }

  return {
    filePath: normalizeEditPath(raw.filePath),
    newContent: raw.newContent
  };
}

/** Rejects absolute paths and traversal before anything reaches the disk. */
export function normalizeEditPath(inputPath: string): string {
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

export function extractJson(rawResponse: string): string {
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

/** Summary, per-file stats, and inline diffs for a not-yet-applied proposal. */
export function formatProposalForChat(summary: string, diffs: FileDiff[]): string {
  const totalAdditions = diffs.reduce((sum, diff) => sum + diff.additions, 0);
  const totalRemovals = diffs.reduce((sum, diff) => sum + diff.removals, 0);

  return [
    `🛠️ **${summary}**`,
    `${diffs.length} file(s) · +${totalAdditions} −${totalRemovals}`,
    '',
    ...diffs.map(diff => formatDiffForChat(diff, 'Update'))
  ].join('\n');
}

export function formatAppliedChangesForChat(changes: AppliedChange[]): string {
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
