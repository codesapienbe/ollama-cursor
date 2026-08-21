/*  Plan-first execution gate.
 *  Every request in `plan` mode is turned into an explicit, reviewable
 *  plan before any answer is produced or any file is touched.        */

import { ActivitySink } from './core/activityContract';
import { OllamaClient } from './client';
import { CodeContextProvider } from './core/codeIndexContract';

export interface PlanStep {
  title: string;
  detail: string;
  files: string[];
}

export interface Plan {
  goal: string;
  summary: string;
  steps: PlanStep[];
  files: string[];
  risks: string[];
  touchesFiles: boolean;
  raw: string;
  createdAt: number;
}

interface ParsedPlan {
  summary?: unknown;
  steps?: unknown;
  files?: unknown;
  risks?: unknown;
  touchesFiles?: unknown;
}

const MAX_PLAN_CONTEXT_CHARS = 24_000;
const MAX_STEPS = 12;

export class PlanService {
  constructor(
    private readonly client: OllamaClient,
    private readonly codeIndex: CodeContextProvider,
    private readonly activity: ActivitySink
  ) {}

  async createPlan(goal: string, extraContext = '', signal?: AbortSignal): Promise<Plan> {
    const indexedContext = await this.activity.run(
      'Gathering plan context',
      async step => {
        const context = await this.codeIndex.buildPromptContext(goal, 6);
        step.update(context ? `${context.length} chars of indexed context` : 'no indexed context available');
        return context;
      }
    );

    const contextBlock = [extraContext, indexedContext]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, MAX_PLAN_CONTEXT_CHARS);

    const raw = await this.activity.run(
      'Drafting plan',
      async step => {
        let received = 0;
        return this.client.generate({
          prompt: this.buildPlanPrompt(goal, contextBlock),
          stream: true,
          signal,
          onToken: (_chunk, full) => {
            received = full.length;
            step.update(`${received} chars drafted`);
          }
        });
      },
      `model: ${this.client.getCurrentModel()}`
    );

    return this.parsePlan(goal, raw);
  }

  formatPlanForChat(plan: Plan): string {
    const stepLines = plan.steps.length
      ? plan.steps.map((step, index) => {
          const files = step.files.length ? `\n   Files: ${step.files.map(file => `\`${file}\``).join(', ')}` : '';
          const detail = step.detail ? `\n   ${step.detail}` : '';
          return `${index + 1}. **${step.title}**${detail}${files}`;
        })
      : ['1. **Answer the request directly** (no file changes expected).'];

    const lines = [
      '📋 **Plan — review before it runs**',
      '',
      `Goal: ${plan.goal}`,
      '',
      plan.summary,
      '',
      '**Steps**',
      ...stepLines
    ];

    if (plan.files.length) {
      lines.push('', '**Files this plan expects to touch**', ...plan.files.map(file => `- \`${file}\``));
    } else {
      lines.push('', '**Files this plan expects to touch**', '- none (read-only answer)');
    }

    if (plan.risks.length) {
      lines.push('', '**Risks and checks**', ...plan.risks.map(risk => `- ${risk}`));
    }

    lines.push('', 'Approve with `/accept` (or the **Accept plan** button in the IDE), or discard with `/discard`.');
    return lines.join('\n');
  }

  /** Compact plan text injected into the execution prompt after approval. */
  toExecutionBrief(plan: Plan): string {
    const steps = plan.steps
      .map((step, index) => `${index + 1}. ${step.title}${step.detail ? ` — ${step.detail}` : ''}`)
      .join('\n');

    return [
      'The user already reviewed and approved this plan. Follow it.',
      `Goal: ${plan.goal}`,
      plan.summary ? `Summary: ${plan.summary}` : '',
      steps ? `Steps:\n${steps}` : '',
      plan.files.length ? `Files in scope: ${plan.files.join(', ')}` : ''
    ].filter(Boolean).join('\n');
  }

  private buildPlanPrompt(goal: string, context: string): string {
    return [
      'You are a local coding agent running inside VS Code, in plan-first mode.',
      'Do NOT answer the request yet and do NOT write any code. Produce only a plan.',
      '',
      'Return ONLY valid JSON (no markdown fence, no prose) in this exact shape:',
      '{"summary":"one or two sentences","touchesFiles":true,'
        + '"steps":[{"title":"short step title","detail":"what happens in this step","files":["relative/path"]}],'
        + '"files":["relative/path"],"risks":["what could go wrong"]}',
      '',
      'Rules:',
      `- At most ${MAX_STEPS} steps, ordered, each independently checkable.`,
      '- Use workspace-relative paths only.',
      '- Set "touchesFiles" to false when the request only needs an explanation and no file changes.',
      '- List every file you expect to create or modify in "files".',
      '- Be concrete about the code surfaces involved; no filler steps.',
      '',
      context ? `Project context:\n${context}` : '',
      '',
      `Request:\n${goal}`
    ].filter(Boolean).join('\n');
  }

  private parsePlan(goal: string, raw: string): Plan {
    const parsed = this.tryParseJson(raw);

    if (!parsed) {
      /* The model ignored the JSON contract. Keep its prose rather than
         failing the turn — a readable plan still gates execution. */
      return {
        goal,
        summary: raw.trim().slice(0, 4_000) || 'The model returned an empty plan.',
        steps: [],
        files: [],
        risks: [],
        touchesFiles: false,
        raw,
        createdAt: Date.now()
      };
    }

    const steps = this.toSteps(parsed.steps);
    const files = this.toStringArray(parsed.files);
    const stepFiles = steps.flatMap(step => step.files);
    const allFiles = Array.from(new Set([...files, ...stepFiles]));

    return {
      goal,
      summary: typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'No summary was returned for this plan.',
      steps,
      files: allFiles,
      risks: this.toStringArray(parsed.risks),
      touchesFiles: typeof parsed.touchesFiles === 'boolean'
        ? parsed.touchesFiles || allFiles.length > 0
        : allFiles.length > 0,
      raw,
      createdAt: Date.now()
    };
  }

  private tryParseJson(raw: string): ParsedPlan | null {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [fenced?.[1], this.sliceBraces(raw), raw].filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0
    );

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate.trim()) as ParsedPlan;
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      } catch {
        // Try the next candidate shape.
      }
    }

    return null;
  }

  private sliceBraces(raw: string): string {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    return first === -1 || last <= first ? '' : raw.slice(first, last + 1);
  }

  private toSteps(value: unknown): PlanStep[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .slice(0, MAX_STEPS)
      .map(entry => {
        if (typeof entry === 'string') {
          return { title: entry.trim(), detail: '', files: [] };
        }
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        const raw = entry as { title?: unknown; detail?: unknown; files?: unknown };
        const title = typeof raw.title === 'string' ? raw.title.trim() : '';
        if (!title) {
          return null;
        }
        return {
          title,
          detail: typeof raw.detail === 'string' ? raw.detail.trim() : '',
          files: this.toStringArray(raw.files)
        };
      })
      .filter((step): step is PlanStep => step !== null && step.title.length > 0);
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const normalized = value
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0);

    return Array.from(new Set(normalized));
  }
}
