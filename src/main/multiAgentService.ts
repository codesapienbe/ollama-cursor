import { ActivitySink } from './core/activityContract';
import { OllamaClient } from './client';
import { CodeContextProvider } from './core/codeIndexContract';

export type DelegatedAgentStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface DelegatedAgentProgress {
  id: string;
  name: string;
  goal: string;
  status: DelegatedAgentStatus;
  detail?: string;
}

export interface DelegatedRunResult {
  synthesis: string;
  agents: DelegatedAgentProgress[];
}

interface AgentBlueprint {
  id: string;
  name: string;
  goal: string;
  promptFrame: string;
}

const MAX_SHARED_CONTEXT_CHARS = 64_000;
const MAX_DETAIL_CHARS = 180;

const DEFAULT_BLUEPRINTS: AgentBlueprint[] = [
  {
    id: 'context-scout',
    name: 'Context Scout',
    goal: 'Map relevant files, symbols, and dependencies for the task.',
    promptFrame: [
      'You are a focused codebase mapping agent.',
      'Find the most relevant files, functions, and data flows for the task.',
      'Prioritize concrete, high-signal findings.'
    ].join(' ')
  },
  {
    id: 'implementation-agent',
    name: 'Implementation Agent',
    goal: 'Design a practical implementation strategy for the task.',
    promptFrame: [
      'You are an implementation specialist.',
      'Produce a concise, executable approach with clear sequencing and minimal risk.',
      'Highlight exact code surfaces to change.'
    ].join(' ')
  },
  {
    id: 'quality-agent',
    name: 'Quality Agent',
    goal: 'Identify edge cases, regressions, and validation focus.',
    promptFrame: [
      'You are a quality and reliability reviewer.',
      'Find likely failure points, edge cases, and behavior mismatches.',
      'Give precise safeguards and validation targets.'
    ].join(' ')
  }
];

export class MultiAgentService {
  constructor(
    private readonly client: OllamaClient,
    private readonly codeIndex: CodeContextProvider,
    private readonly activity: ActivitySink
  ) {}

  async runDelegatedTask(
    instruction: string,
    onProgress: (agents: DelegatedAgentProgress[]) => void,
    signal?: AbortSignal
  ): Promise<DelegatedRunResult> {
    const sharedContext = await this.buildSharedContext(instruction);
    const progress = DEFAULT_BLUEPRINTS.map<DelegatedAgentProgress>(blueprint => ({
      id: blueprint.id,
      name: blueprint.name,
      goal: blueprint.goal,
      status: 'queued'
    }));
    onProgress([...progress]);

    const settled = await Promise.all(
      DEFAULT_BLUEPRINTS.map(async blueprint => {
        this.updateAgentStatus(progress, blueprint.id, 'running');
        onProgress([...progress]);
        const stepId = this.activity.begin(`Agent · ${blueprint.name}`, blueprint.goal);

        try {
          const response = await this.client.generate({
            prompt: this.buildAgentPrompt(blueprint, instruction, sharedContext),
            stream: true,
            signal,
            onToken: (_chunk, full) => this.activity.update(stepId, `${full.length} chars`)
          });
          const detail = this.toStatusDetail(response);
          this.activity.succeed(stepId, detail);
          this.updateAgentStatus(progress, blueprint.id, 'completed', detail);
          onProgress([...progress]);
          return {
            id: blueprint.id,
            name: blueprint.name,
            goal: blueprint.goal,
            status: 'completed' as const,
            detail,
            response
          };
        } catch (error) {
          const detail = this.toStatusDetail(error instanceof Error ? error.message : String(error));
          this.activity.fail(stepId, detail);
          this.updateAgentStatus(progress, blueprint.id, 'failed', detail);
          onProgress([...progress]);
          return {
            id: blueprint.id,
            name: blueprint.name,
            goal: blueprint.goal,
            status: 'failed' as const,
            detail,
            response: ''
          };
        }
      })
    );

    /* Skip synthesis entirely when the user stopped mid-fan-out. */
    if (signal?.aborted) {
      return { synthesis: '', agents: progress };
    }

    const synthesis = await this.activity.run(
      'Synthesizing agent results',
      async step =>
        this.client.generate({
          prompt: this.buildSynthesisPrompt(instruction, settled, sharedContext),
          stream: true,
          signal,
          onToken: (_chunk, full) => step.update(`${full.length} chars`)
        })
    );

    return {
      synthesis: synthesis.trim(),
      agents: progress
    };
  }

  private async buildSharedContext(instruction: string): Promise<string> {
    const indexedContext = await this.activity.run(
      'Building shared agent context',
      async step => {
        const context = await this.codeIndex.buildPromptContext(instruction, 8);
        step.update(context ? `${context.length} chars` : 'no indexed context');
        return context;
      }
    );
    if (!indexedContext) {
      return 'Indexed workspace context: unavailable.';
    }

    return indexedContext.length <= MAX_SHARED_CONTEXT_CHARS
      ? indexedContext
      : `${indexedContext.slice(0, MAX_SHARED_CONTEXT_CHARS)}\n...[truncated]`;
  }

  private buildAgentPrompt(blueprint: AgentBlueprint, instruction: string, sharedContext: string): string {
    return [
      'You are one delegated sub-agent in a parent multi-agent coding workflow.',
      blueprint.promptFrame,
      '',
      'Output format (plain text, concise):',
      '1. Findings',
      '2. Recommendations',
      '',
      `Sub-task goal: ${blueprint.goal}`,
      `Parent instruction: ${instruction}`,
      '',
      'Shared project context:',
      sharedContext
    ].join('\n');
  }

  private buildSynthesisPrompt(
    instruction: string,
    results: Array<{ id: string; name: string; status: DelegatedAgentStatus; detail?: string; response: string }>,
    sharedContext: string
  ): string {
    const agentSections = results
      .map(result => {
        const normalizedResponse = result.response.trim() || '(no output)';
        const limitedResponse = normalizedResponse.slice(0, 8_000);
        return [
          `Agent: ${result.name}`,
          `Status: ${result.status}`,
          `Detail: ${result.detail ?? ''}`,
          'Response:',
          limitedResponse
        ].join('\n');
      })
      .join('\n\n---\n\n');

    return [
      'You are the parent agent synthesizing delegated sub-agent outputs.',
      'Merge results into one clear, practical final response.',
      'Respect failed agents without inventing their findings.',
      '',
      `Parent instruction: ${instruction}`,
      '',
      'Shared project context:',
      sharedContext,
      '',
      'Sub-agent outputs:',
      agentSections,
      '',
      'Output format:',
      '- Final answer',
      '- Concrete action plan',
      '- Key risks and checks'
    ].join('\n');
  }

  private updateAgentStatus(
    progress: DelegatedAgentProgress[],
    agentId: string,
    status: DelegatedAgentStatus,
    detail?: string
  ): void {
    const entry = progress.find(agent => agent.id === agentId);
    if (!entry) {
      return;
    }

    entry.status = status;
    entry.detail = detail;
  }

  private toStatusDetail(text: string): string {
    const compact = text
      .replace(/\s+/g, ' ')
      .replace(/^\W+/, '')
      .trim();
    if (!compact) {
      return '';
    }
    return compact.length <= MAX_DETAIL_CHARS
      ? compact
      : `${compact.slice(0, MAX_DETAIL_CHARS - 1)}…`;
  }
}
