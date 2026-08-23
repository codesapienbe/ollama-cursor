// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/*  Delegated sub-agent orchestration.
 *
 *  This is the default path for a request, not a special mode: `decide()`
 *  routes every prompt, and anything with real work in it is split across up
 *  to five sub-agents whose results are merged into one answer. `/agents`
 *  only skips the router.
 *
 *  Three constraints shape the design, and all three come from the model
 *  living on a local Ollama server rather than behind an elastic API:
 *
 *  1. The server generates for one request per loaded model at a time. Fanning
 *     out five requests at once does not make them parallel, it makes four of
 *     them queue — so the pool bounds concurrency and a queued agent reports
 *     `waiting` instead of looking hung.
 *  2. Reasoning models spend `num_predict` on a scratchpad before the answer.
 *     Sub-agents therefore run with reasoning off: the whole budget goes to
 *     the findings, which is faster and cannot come back empty. Only the
 *     synthesis — the part the user reads — keeps reasoning on.
 *  3. The context window is small and shared. Every prompt here is sized from
 *     the real window instead of a fixed constant, because overflowing it
 *     makes Ollama silently drop the front of the prompt: the instructions.  */

import { ActivitySink } from './core/activityContract';
import { EmptyAnswerError, OllamaClient, isAbortedError, isEmptyAnswerError, promptCharBudget } from './client';
import { CodeContextProvider } from './core/codeIndexContract';
import { DelegationMode, MAX_DELEGATED_AGENTS, OllibertySettings } from './core/settingsContract';

export type DelegatedAgentStatus = 'queued' | 'waiting' | 'running' | 'completed' | 'failed';

export interface DelegatedAgentProgress {
  id: string;
  name: string;
  goal: string;
  status: DelegatedAgentStatus;
  detail?: string;
  /** Characters streamed so far — the only progress signal a local model gives. */
  chars?: number;
  startedAt?: number;
  endedAt?: number;
  /** 2 once a failed agent has been retried, so the panel can show it. */
  attempt?: number;
}

/** Why this request is (or is not) being split, and into what. */
export interface DelegationDecision {
  fanOut: boolean;
  reason: string;
  source: 'planner' | 'heuristic' | 'forced' | 'disabled';
  blueprints: AgentBlueprint[];
}

export interface DelegatedRunOptions {
  signal?: AbortSignal;
  /** `/agents` forces the split whatever the router would have chosen. */
  force?: boolean;
  /** Caller-side prompt context (scope header, attachments) shared by all agents. */
  extraContext?: string;
  /** Streams the synthesis so the caller can render it as an ordinary answer. */
  onSynthesisToken?: (chunk: string, full: string) => void;
  /** A decision already made by `decide()`, so the router runs once per turn. */
  decision?: DelegationDecision;
}

export interface DelegatedRunResult {
  synthesis: string;
  agents: DelegatedAgentProgress[];
  decision: DelegationDecision;
}

export interface AgentBlueprint {
  id: string;
  name: string;
  goal: string;
  promptFrame: string;
}

const MAX_DETAIL_CHARS = 180;
/* Tokens arrive faster than any terminal wants to repaint; status changes are
   always published, token growth only this often. */
const PROGRESS_INTERVAL_MS = 100;
const SYNTHESIS_ID = 'synthesis';
/** Upper bound on shared context regardless of how big the window is. */
const MAX_SHARED_CONTEXT_CHARS = 24_000;
/** Sub-agents are asked to stay terse; this enforces it before synthesis. */
const MAX_AGENT_RESPONSE_CHARS = 2_400;
/** Budget for the router call. It emits a few lines of JSON, nothing more. */
const ROUTER_MAX_TOKENS = 320;
/** A prompt this short is a greeting or a one-liner, never a fan-out. */
const TRIVIAL_PROMPT_WORDS = 4;

/*  The roles a request can be split across. The router picks by id; ids it
    invents are dropped rather than trusted, so a confused model degrades to
    the default trio instead of producing nonsense agents.                  */
const ROLE_LIBRARY: AgentBlueprint[] = [
  {
    id: 'research',
    name: 'Research Agent',
    goal: 'Establish what the code already does today, before anything is proposed.',
    promptFrame: [
      'You establish current behaviour from evidence.',
      'Answer strictly from the provided context: what exists today, where, and under what name.',
      'Say plainly when the context does not show whether something exists — never assume it does.'
    ].join(' ')
  },
  {
    id: 'context-scout',
    name: 'Context Scout',
    goal: 'Map the relevant files, symbols, and data flows.',
    promptFrame: [
      'You are a focused codebase mapping agent.',
      'Name the files, functions, and data flows that the task touches, each with a one-line reason.',
      'Prefer concrete paths and symbol names over description.'
    ].join(' ')
  },
  {
    id: 'implementation',
    name: 'Implementation Agent',
    goal: 'Design the concrete change: sequence and code surfaces.',
    promptFrame: [
      'You are an implementation specialist.',
      'Give an ordered, executable approach naming the exact code surfaces to change.',
      'Choose the lowest-risk sequencing and say what each step unblocks.'
    ].join(' ')
  },
  {
    id: 'interface-design',
    name: 'Interface Agent',
    goal: 'Shape the user-facing surface: settings, flags, commands, names.',
    promptFrame: [
      'You design the surface a user actually touches.',
      'Propose concrete names, defaults, and valid ranges for any setting, flag, or command involved.',
      'Keep them consistent with the naming already used in the provided context.'
    ].join(' ')
  },
  {
    id: 'integration',
    name: 'Integration Agent',
    goal: 'Check how the change fits existing wiring and stays compatible.',
    promptFrame: [
      'You own the seams between this change and everything already shipped.',
      'Identify every call site, host, and config surface that has to move together.',
      'Call out backward-compatibility breaks explicitly.'
    ].join(' ')
  },
  {
    id: 'quality',
    name: 'Quality Agent',
    goal: 'Identify edge cases, regressions, and what to verify.',
    promptFrame: [
      'You are a quality and reliability reviewer.',
      'Find the likely failure points, edge cases, and behaviour mismatches.',
      'Give precise safeguards and the specific checks that would catch each one.'
    ].join(' ')
  },
  {
    id: 'performance',
    name: 'Performance Agent',
    goal: 'Assess cost: latency, memory, and resource limits.',
    promptFrame: [
      'You reason about runtime cost.',
      'Identify hot paths, memory growth, concurrency limits, and blocking work.',
      'Quantify wherever the context lets you, and say when it does not.'
    ].join(' ')
  },
  {
    id: 'security',
    name: 'Security Agent',
    goal: 'Assess privacy, secret handling, and untrusted input.',
    promptFrame: [
      'You review for privacy and security consequences.',
      'Check secret handling, outbound network use, and trust boundaries around untrusted input.',
      'Report only concrete exposures, not generic advice.'
    ].join(' ')
  }
];

/* The fallback trio: what to run when the router cannot be reached or its
   answer cannot be parsed. Deliberately the three lenses that apply to almost
   any coding request. */
const FALLBACK_ROLE_IDS = ['research', 'implementation', 'quality'];
/* A question about existing behaviour does not need an implementation plan. */
const QUESTION_ROLE_IDS = ['research', 'context-scout'];

interface AgentOutcome {
  id: string;
  name: string;
  goal: string;
  status: DelegatedAgentStatus;
  detail?: string;
  response: string;
}

interface ParsedRoute {
  fanOut?: unknown;
  reason?: unknown;
  agents?: unknown;
}

export class MultiAgentService {
  constructor(
    private readonly client: OllamaClient,
    private readonly codeIndex: CodeContextProvider,
    private readonly activity: ActivitySink,
    private readonly settings: OllibertySettings
  ) {}

  /**
   * Route one request: should it be split, and across which roles. Cheap by
   * design — a short reasoning-free call, and no call at all when the shape of
   * the prompt already settles it.
   */
  async decide(instruction: string, signal?: AbortSignal): Promise<DelegationDecision> {
    const mode: DelegationMode = this.settings.delegationMode;
    const maxAgents = Math.min(this.settings.agentsMaxCount, MAX_DELEGATED_AGENTS);

    if (mode === 'off') {
      return {
        fanOut: false,
        reason: 'Delegation is off — answering directly. Use `/agents <goal>` to split this request anyway.',
        source: 'disabled',
        blueprints: []
      };
    }

    if (mode === 'auto' && isTrivialPrompt(instruction)) {
      return {
        fanOut: false,
        reason: 'Short, self-contained request — a single pass is faster than a fan-out.',
        source: 'heuristic',
        blueprints: []
      };
    }

    const routed = await this.routeWithModel(instruction, maxAgents, signal);
    if (routed) {
      return routed;
    }

    /* The router is an optimisation, never a gate: when it fails the request
       still gets split, just along the default lenses. */
    return {
      fanOut: true,
      reason: 'Router unavailable — using the default agent set.',
      source: 'heuristic',
      blueprints: this.rolesById(heuristicRoleIds(instruction)).slice(0, maxAgents)
    };
  }

  async runDelegatedTask(
    instruction: string,
    onProgress: (agents: DelegatedAgentProgress[]) => void,
    optionsOrSignal?: DelegatedRunOptions | AbortSignal
  ): Promise<DelegatedRunResult> {
    /* Older callers passed a bare AbortSignal as the third argument. */
    const options: DelegatedRunOptions =
      optionsOrSignal && 'aborted' in optionsOrSignal ? { signal: optionsOrSignal } : optionsOrSignal ?? {};
    const signal = options.signal;

    const decision = options.decision ?? (options.force
      ? {
          fanOut: true,
          reason: 'Requested explicitly with `/agents`.',
          source: 'forced' as const,
          blueprints: await this.forcedBlueprints(instruction, signal)
        }
      : await this.decide(instruction, signal));

    if (!decision.fanOut || !decision.blueprints.length) {
      return { synthesis: '', agents: [], decision: { ...decision, fanOut: false } };
    }

    const blueprints = decision.blueprints;
    const progress = blueprints.map<DelegatedAgentProgress>(blueprint => ({
      id: blueprint.id,
      name: blueprint.name,
      goal: blueprint.goal,
      status: 'queued'
    }));
    /* The synthesis pass is reported alongside the agents so the caller's task
       list stays populated after the fan-out finishes, but it is not an agent
       and never appears in the returned agent list. */
    const synthesisTask: DelegatedAgentProgress = {
      id: SYNTHESIS_ID,
      name: 'Synthesis',
      goal: 'Merge sub-agent results into one answer.',
      status: 'queued'
    };
    const publish = this.progressPublisher(onProgress, [...progress, synthesisTask]);
    publish(true);

    const sharedContext = await this.buildSharedContext(instruction, options.extraContext);

    const settled = await this.runAgentPool(blueprints, progress, instruction, sharedContext, publish, signal);

    /* Skip synthesis entirely when the user stopped mid-fan-out. */
    if (signal?.aborted) {
      return { synthesis: '', agents: progress, decision };
    }

    /* Nothing to merge, and a synthesis over five failures would just invent
       an answer. Report the failure instead so the caller can fall back. */
    if (!settled.some(outcome => outcome.status === 'completed' && outcome.response.trim())) {
      synthesisTask.status = 'failed';
      synthesisTask.detail = 'No sub-agent produced output.';
      synthesisTask.endedAt = Date.now();
      publish(true);
      throw new Error(
        `Every sub-agent failed: ${settled.map(outcome => outcome.detail || outcome.status).join('; ')}`
      );
    }

    synthesisTask.status = 'running';
    synthesisTask.startedAt = Date.now();
    publish(true);

    try {
      const synthesis = await this.activity.run(
        'Synthesizing agent results',
        async step =>
          this.client.generate({
            prompt: this.buildSynthesisPrompt(instruction, settled, options.extraContext ?? ''),
            stream: true,
            signal,
            /* The synthesis is the answer the user reads, so it keeps the
               model's own reasoning and the full answer budget. */
            numPredict: this.settings.maxTokens,
            onToken: (chunk, full) => {
              step.update(`${full.length} chars`);
              synthesisTask.chars = full.length;
              publish();
              options.onSynthesisToken?.(chunk, full);
            },
            onThinking: (_chunk, full) => {
              /* Nothing is streaming to the user yet; say why. */
              synthesisTask.detail = `reasoning · ${full.length} chars`;
              publish();
            }
          })
      );

      synthesisTask.status = 'completed';
      synthesisTask.detail = undefined;
      synthesisTask.endedAt = Date.now();
      publish(true);

      return { synthesis: synthesis.trim(), agents: progress, decision };
    } catch (error) {
      synthesisTask.status = 'failed';
      synthesisTask.endedAt = Date.now();
      synthesisTask.detail = this.toStatusDetail(error instanceof Error ? error.message : String(error));
      publish(true);
      throw error;
    }
  }

  /* ────────────────────────────── routing ──────────────────────────── */

  /** `/agents` skips the fan-out decision but still picks roles by task. */
  private async forcedBlueprints(instruction: string, signal?: AbortSignal): Promise<AgentBlueprint[]> {
    const maxAgents = Math.min(this.settings.agentsMaxCount, MAX_DELEGATED_AGENTS);
    const routed = await this.routeWithModel(instruction, maxAgents, signal);
    if (routed?.blueprints.length) {
      return routed.blueprints;
    }
    return this.rolesById(heuristicRoleIds(instruction)).slice(0, maxAgents);
  }

  private async routeWithModel(
    instruction: string,
    maxAgents: number,
    signal?: AbortSignal
  ): Promise<DelegationDecision | null> {
    let raw = '';
    try {
      raw = await this.activity.run(
        'Planning the agent split',
        async step =>
          this.client.generate({
            prompt: this.buildRouterPrompt(instruction, maxAgents),
            stream: true,
            signal,
            /* Routing is a classification, not a chat turn: no reasoning, and
               a budget small enough that it never becomes the slow part. */
            think: false,
            numPredict: ROUTER_MAX_TOKENS,
            onToken: (_chunk, full) => step.update(`${full.length} chars`)
          }),
        `max ${maxAgents} agents`
      );
    } catch (error) {
      if (isAbortedError(error)) {
        throw error;
      }
      return null;
    }

    const parsed = tryParseJsonObject<ParsedRoute>(raw);
    if (!parsed) {
      return null;
    }

    const requestedIds = toStringArray(parsed.agents);
    const blueprints = this.rolesById(requestedIds).slice(0, maxAgents);
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim().slice(0, 240)
      : '';

    /* Splitting is the default, so the router has to say no clearly to be
       believed: `always` overrides it outright, and a router that picked roles
       wanted a split whatever its flag says — models emit "true", 1 and a
       populated list with `fanOut` omitted about as often as a clean `true`. */
    const wantsFanOut = this.settings.delegationMode === 'always'
      || isTruthyFlag(parsed.fanOut)
      || (parsed.fanOut === undefined && blueprints.length > 0);
    if (!wantsFanOut) {
      return {
        fanOut: false,
        reason: reason || 'Routed as a single-pass request.',
        source: 'planner',
        blueprints: []
      };
    }

    if (!blueprints.length) {
      return {
        fanOut: true,
        reason: reason || 'Split across the default agent set.',
        source: 'heuristic',
        blueprints: this.rolesById(heuristicRoleIds(instruction)).slice(0, maxAgents)
      };
    }

    return {
      fanOut: true,
      reason: reason || `Split across ${blueprints.length} agents.`,
      source: 'planner',
      blueprints
    };
  }

  private rolesById(ids: string[]): AgentBlueprint[] {
    const seen = new Set<string>();
    const selected: AgentBlueprint[] = [];
    for (const id of ids) {
      const normalized = id.trim().toLowerCase().replace(/[\s_]+/g, '-');
      const role = ROLE_LIBRARY.find(entry => entry.id === normalized);
      if (role && !seen.has(role.id)) {
        seen.add(role.id);
        selected.push(role);
      }
    }
    return selected;
  }

  private buildRouterPrompt(instruction: string, maxAgents: number): string {
    const roleList = ROLE_LIBRARY.map(role => `- ${role.id}: ${role.goal}`).join('\n');
    return [
      'You route one request in a local coding assistant. Do NOT answer the request.',
      '',
      'Available agent roles:',
      roleList,
      '',
      `Request:\n${instruction.slice(0, 2_000)}`,
      '',
      'Return ONLY this JSON, no prose and no markdown fence:',
      '{"fanOut":true,"reason":"under 20 words","agents":["role-id","role-id"]}',
      '',
      'Rules:',
      `- Pick between 2 and ${maxAgents} roles, ordered by what should be read first.`,
      '- Use role ids exactly as listed above; never invent one.',
      '- Set "fanOut" to false only for greetings, or a question one short paragraph answers;'
        + ' then return an empty "agents" list.',
      '- Pick roles that would disagree with each other, not roles that repeat one lens.'
    ].join('\n');
  }

  /* ───────────────────────────── the fan-out ───────────────────────── */

  /**
   * Runs the agents `agentsMaxParallel` at a time. Bounding this is not
   * throttling for its own sake: the model server generates for one request at
   * a time anyway, so an unbounded fan-out only buries later agents in a queue
   * deep enough to look like a hang.
   */
  private async runAgentPool(
    blueprints: AgentBlueprint[],
    progress: DelegatedAgentProgress[],
    instruction: string,
    sharedContext: string,
    publish: (force?: boolean) => void,
    signal?: AbortSignal
  ): Promise<AgentOutcome[]> {
    const limit = Math.max(1, Math.min(this.settings.agentsMaxParallel, blueprints.length));
    const outcomes = new Array<AgentOutcome>(blueprints.length);
    let next = 0;

    for (const [index, blueprint] of blueprints.entries()) {
      if (index >= limit) {
        this.updateAgent(progress, blueprint.id, {
          status: 'waiting',
          detail: `waiting for a model slot (#${index - limit + 1} in line)`
        });
      }
    }
    publish(true);

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= blueprints.length) {
          return;
        }
        if (signal?.aborted) {
          this.updateAgent(progress, blueprints[index].id, { status: 'failed', detail: 'Stopped by you.' });
          outcomes[index] = {
            ...toOutcomeShell(blueprints[index]),
            status: 'failed',
            detail: 'Stopped by you.'
          };
          continue;
        }
        outcomes[index] = await this.runOneAgent(blueprints[index], progress, instruction, sharedContext, publish, signal);
      }
    };

    await Promise.all(Array.from({ length: limit }, () => worker()));
    return outcomes;
  }

  /**
   * One agent, with one retry. A local model server fails in recoverable ways
   * — a queue that timed out, a budget spent on reasoning — and retrying once
   * turns most of those into results instead of a hole in the synthesis.
   */
  private async runOneAgent(
    blueprint: AgentBlueprint,
    progress: DelegatedAgentProgress[],
    instruction: string,
    sharedContext: string,
    publish: (force?: boolean) => void,
    signal?: AbortSignal
  ): Promise<AgentOutcome> {
    const maxAttempts = 2;
    let lastDetail = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.updateAgent(progress, blueprint.id, {
        status: 'running',
        detail: attempt > 1 ? 'retrying' : undefined,
        attempt
      });
      publish(true);
      const stepId = this.activity.begin(
        `Agent · ${blueprint.name}${attempt > 1 ? ' (retry)' : ''}`,
        blueprint.goal
      );

      /* The retry gets a leaner prompt and a bigger answer budget: the two
         things that turn "no output" into output. */
      const context = attempt === 1 ? sharedContext : trimToChars(sharedContext, Math.floor(sharedContext.length / 2));
      const numPredict = attempt === 1
        ? this.settings.agentMaxTokens
        : Math.min(this.settings.maxTokens, this.settings.agentMaxTokens * 2);

      try {
        const response = await this.client.generate({
          prompt: this.buildAgentPrompt(blueprint, instruction, context),
          stream: true,
          signal,
          /* Reasoning off: the whole budget goes to findings the synthesis can
             actually use, and an empty answer stops being possible. */
          think: false,
          numPredict,
          onToken: (_chunk, full) => {
            this.activity.update(stepId, `${full.length} chars`);
            this.updateAgent(progress, blueprint.id, { chars: full.length });
            publish();
          }
        });

        const detail = this.toStatusDetail(response) || 'no findings reported';
        this.activity.succeed(stepId, detail);
        this.updateAgent(progress, blueprint.id, { status: 'completed', detail });
        publish(true);
        return { ...toOutcomeShell(blueprint), status: 'completed', detail, response };
      } catch (error) {
        if (isAbortedError(error) || signal?.aborted) {
          this.activity.cancel(stepId, 'Stopped by you.');
          this.updateAgent(progress, blueprint.id, { status: 'failed', detail: 'Stopped by you.' });
          publish(true);
          return { ...toOutcomeShell(blueprint), status: 'failed', detail: 'Stopped by you.' };
        }

        lastDetail = this.toStatusDetail(describeAgentError(error));
        const willRetry = attempt < maxAttempts;
        if (willRetry) {
          this.activity.fail(stepId, `${lastDetail} — retrying`);
          this.updateAgent(progress, blueprint.id, { status: 'waiting', detail: `${lastDetail} — retrying` });
          publish(true);
          continue;
        }

        this.activity.fail(stepId, lastDetail);
        this.updateAgent(progress, blueprint.id, { status: 'failed', detail: lastDetail });
        publish(true);
      }
    }

    return { ...toOutcomeShell(blueprint), status: 'failed', detail: lastDetail };
  }

  /* ──────────────────────────── prompt shaping ─────────────────────── */

  /**
   * Context sized to the window the agents actually run in. The old fixed
   * 64k ceiling was six times what a 4k window holds, so Ollama dropped the
   * front of every agent prompt — instructions included.
   */
  private async buildSharedContext(instruction: string, extraContext?: string): Promise<string> {
    const budget = Math.min(
      MAX_SHARED_CONTEXT_CHARS,
      promptCharBudget(this.settings.contextLength, this.settings.agentMaxTokens) - AGENT_FRAME_CHARS
    );

    return this.activity.run(
      'Building shared agent context',
      async step => {
        const indexedContext = await this.codeIndex.buildPromptContext(instruction, 8);
        const combined = [extraContext?.trim(), indexedContext?.trim()].filter(Boolean).join('\n\n');
        if (!combined) {
          step.update('no indexed context');
          return 'Indexed workspace context: unavailable.';
        }

        /* Report what the agents will actually see, not what was retrieved —
           the gap between the two is the whole point of the budget. */
        const fitted = trimToChars(combined, Math.max(600, budget));
        step.update(
          fitted.length < combined.length
            ? `${fitted.length} of ${combined.length} chars (window-limited)`
            : `${fitted.length} chars`
        );
        return fitted;
      }
    );
  }

  private buildAgentPrompt(blueprint: AgentBlueprint, instruction: string, sharedContext: string): string {
    /* Instructions bracket the context rather than preceding it: whichever end
       a small window clips, the agent still knows its job and its format. */
    return [
      `You are the ${blueprint.name}, one of several sub-agents answering one request.`,
      blueprint.promptFrame,
      `Your sub-task: ${blueprint.goal}`,
      '',
      `The request: ${instruction}`,
      '',
      'Shared project context:',
      sharedContext,
      '',
      `Reminder — you are the ${blueprint.name}. Cover only your sub-task; another agent covers the rest.`,
      'Answer as at most 8 short bullet points under these two headings, and nothing else:',
      'Findings:',
      'Recommendations:',
      'Every bullet must be specific to this project. Name files and symbols. No filler, no preamble,',
      'and no restating the request. Say "not shown in the provided context" rather than guessing.'
    ].join('\n');
  }

  private buildSynthesisPrompt(instruction: string, results: AgentOutcome[], extraContext: string): string {
    const usable = results.filter(result => result.status === 'completed' && result.response.trim());
    const failed = results.filter(result => result.status === 'failed');

    /* The project context is deliberately left out: the agents already read
       it, and their findings are worth more per token in a small window than
       the source they came from. */
    const budget = promptCharBudget(this.settings.contextLength, this.settings.maxTokens) - SYNTHESIS_FRAME_CHARS;
    const perAgent = Math.max(400, Math.floor(Math.max(budget, 1_200) / Math.max(1, usable.length)));

    const agentSections = usable
      .map(result => [`### ${result.name}`, trimToChars(result.response.trim(), Math.min(perAgent, MAX_AGENT_RESPONSE_CHARS))].join('\n'))
      .join('\n\n');

    return [
      'You are answering the user directly. Several sub-agents investigated the request for you;',
      'their notes are below. Merge them into one answer in your own voice.',
      '',
      `The user asked: ${instruction}`,
      extraContext.trim() ? `\n${trimToChars(extraContext.trim(), 800)}` : '',
      '',
      'Sub-agent notes:',
      agentSections,
      failed.length
        ? `\nThese agents produced nothing, so their angle is uncovered: ${failed.map(entry => entry.name).join(', ')}.`
          + ' Do not invent their findings; say what is still unverified.'
        : '',
      '',
      'Write the answer as if you had done the work yourself:',
      '- Lead with the direct answer to what was asked.',
      '- Then the concrete steps, naming real files and symbols.',
      '- Then the risks or checks that matter, if any.',
      'Do not mention agents, notes, or synthesis. Drop anything the notes contradict each other on,',
      'or flag it as uncertain — never average two conflicting claims into one confident sentence.'
    ].filter(Boolean).join('\n');
  }

  /* ───────────────────────────── bookkeeping ───────────────────────── */

  /* One throttled emitter per run: `tasks` is the live array the run mutates,
     so every publish sends a fresh copy of the current state. */
  private progressPublisher(
    onProgress: (agents: DelegatedAgentProgress[]) => void,
    tasks: DelegatedAgentProgress[]
  ): (force?: boolean) => void {
    let lastPublishedAt = 0;
    return (force = false) => {
      const now = Date.now();
      if (!force && now - lastPublishedAt < PROGRESS_INTERVAL_MS) {
        return;
      }
      lastPublishedAt = now;
      onProgress(tasks.map(task => ({ ...task })));
    };
  }

  private updateAgent(
    progress: DelegatedAgentProgress[],
    agentId: string,
    patch: Partial<Pick<DelegatedAgentProgress, 'status' | 'detail' | 'chars' | 'attempt'>>
  ): void {
    const entry = progress.find(agent => agent.id === agentId);
    if (!entry) {
      return;
    }

    if (patch.status) {
      entry.status = patch.status;
      if (patch.status === 'running' && !entry.startedAt) {
        entry.startedAt = Date.now();
      } else if (patch.status === 'completed' || patch.status === 'failed') {
        entry.endedAt = Date.now();
      }
    }
    if ('detail' in patch) {
      entry.detail = patch.detail;
    }
    if (patch.chars !== undefined) {
      entry.chars = patch.chars;
    }
    if (patch.attempt !== undefined) {
      entry.attempt = patch.attempt;
    }
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

/*  Rough sizes of the fixed framing around each prompt, held back from the
    context budget so the framing itself never pushes the context out.       */
const AGENT_FRAME_CHARS = 1_200;
const SYNTHESIS_FRAME_CHARS = 1_400;

/** Greetings and one-liners: a fan-out would cost minutes and add nothing. */
export function isTrivialPrompt(instruction: string): boolean {
  const normalized = instruction.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return true;
  }
  const words = normalized.split(' ').filter(Boolean);
  if (words.length <= TRIVIAL_PROMPT_WORDS) {
    return true;
  }
  /* Social openers and meta-questions about the assistant itself. */
  return /^(hi|hey|hello|yo|thanks|thank you|ok|okay|cool|nice|who are you|what can you do)\b/i.test(normalized);
}

/**
 * Role choice without a model call: the fallback when the router is
 * unreachable. A question about what already exists gets read, not planned.
 */
export function heuristicRoleIds(instruction: string): string[] {
  const normalized = instruction.trim().toLowerCase();
  const asksForChange = /\b(add|implement|create|build|fix|refactor|change|migrate|remove|rename|write|expose|wire)\b/
    .test(normalized);
  const asksAboutState = /\b(does|do|is|are|can|could|why|what|where|how|which|already|support(s|ed)?)\b/
    .test(normalized);

  if (asksAboutState && !asksForChange) {
    return QUESTION_ROLE_IDS;
  }
  return FALLBACK_ROLE_IDS;
}

/**
 * One line naming the agents behind an answer. The answer itself never
 * mentions them — but when one of five failed, the reader needs to know which
 * angle went uncovered before trusting the rest.
 */
export function formatAgentFooter(agents: DelegatedAgentProgress[]): string {
  if (!agents.length) {
    return '';
  }

  const failed = agents.filter(agent => agent.status !== 'completed');
  const names = agents
    .map(agent => (agent.status === 'completed' ? agent.name : `~~${agent.name}~~`))
    .join(' · ');
  const suffix = failed.length
    ? ` — ${failed.length} of ${agents.length} produced nothing, so that angle is unverified.`
    : '';

  return `\n_${agents.length} agents: ${names}${suffix}_`;
}

function toOutcomeShell(blueprint: AgentBlueprint): AgentOutcome {
  return {
    id: blueprint.id,
    name: blueprint.name,
    goal: blueprint.goal,
    status: 'failed',
    response: ''
  };
}

/** Turns transport-level failures into something a user can act on. */
function describeAgentError(error: unknown): string {
  if (isEmptyAnswerError(error)) {
    const empty = error as EmptyAnswerError;
    return `spent its ${empty.thinkingChars}-char reasoning budget without answering`;
  }
  return error instanceof Error ? error.message : String(error);
}

function trimToChars(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n…[truncated]`;
}

/* Router output is a model's idea of JSON, not a schema: "true", "yes" and 1
   all mean the same thing here. */
function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    return /^(true|yes|1)$/i.test(value.trim());
  }
  return false;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(Boolean);
}

/** Same tolerance as the plan parser: fenced, embedded, or bare JSON. */
function tryParseJsonObject<T>(raw: string): T | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  const sliced = first === -1 || last <= first ? '' : raw.slice(first, last + 1);
  const candidates = [fenced?.[1], sliced, raw].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as T;
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      /* Try the next candidate shape. */
    }
  }
  return null;
}
