/**
 * Run orchestrator (07 §2, B1-04): owns the state machine walk — send →
 * queue → dispatch → ingest (batched, idempotent) → terminal transition —
 * each persistence step one HubStore transaction (09 §3). Also provisioning
 * (UC-01), cancellation (UC-04), the boot reconciler (UC-06) and queue
 * rebuild. Talks to the runtime ONLY through the RuntimeAdapter port and to
 * the substrate ONLY for session lifecycle (07 §2 arrows).
 */

import { systemClock, type Clock } from '../domain/ids.js';
import {
  NOOP_NOTIFIER,
  type AdapterItem,
  type HubNotifier,
  type RuntimeAdapter,
  type SubstrateExecPort,
  type TurnRequest,
} from '../domain/ports.js';
import {
  assembleAssistantText,
  deriveRunSummary,
} from '../domain/projections.js';
import type {
  Agent,
  Conversation,
  KillOutcome,
  Message,
  Project,
  Run,
  RunErrorCode,
  TerminalRunState,
  UsageSource,
} from '../domain/types.js';
import type { HubStore, NewRunEvent } from '../store/types.js';

export class OrchestratorError extends Error {
  constructor(
    readonly code: 'unknown_agent' | 'project_not_ready' | 'run_not_cancellable' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

export interface OrchestratorDeps {
  store: HubStore;
  adapter: RuntimeAdapter;
  /** session lifecycle only (UC-01) — turns go through the adapter */
  execPort: SubstrateExecPort;
  agents: ReadonlyMap<string, Agent>;
  clock?: Clock;
  /** extra env for every run (e.g. the OAuth token in Increment 2) */
  runEnv?: Record<string, string>;
  /** live-delivery sink (ADR-004); losing notifications loses nothing (NFR-07) */
  notify?: HubNotifier;
}

const STDERR_EXCERPT_MAX = 500;
const STDERR_EXCERPTS_MAX = 5;
const KILL_GRACE_MS = 5000;

export class Orchestrator {
  private readonly store: HubStore;
  private readonly adapter: RuntimeAdapter;
  private readonly execPort: SubstrateExecPort;
  private readonly agents: ReadonlyMap<string, Agent>;
  private readonly now: Clock;
  private readonly runEnv: Record<string, string>;
  private readonly notify: HubNotifier;

  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly cancelRequested = new Set<string>();
  private readonly killOutcomes = new Map<string, KillOutcome>();

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store;
    this.adapter = deps.adapter;
    this.execPort = deps.execPort;
    this.agents = deps.agents;
    this.now = deps.clock ?? systemClock;
    this.runEnv = deps.runEnv ?? {};
    this.notify = deps.notify ?? NOOP_NOTIFIER;
  }

  // — UC-01: create project + provision its substrate session —

  /**
   * Returns immediately with the `provisioning` project (the API's 202,
   * 08 §1); provisioning continues asynchronously and resolves to
   * ready | error (UC-01), observable via project.state / GET.
   */
  createProject(input: {
    name: string;
    defaultAgentId: string;
    instructions?: string | null;
  }): Project {
    const agent = this.mustAgent(input.defaultAgentId);
    const project = this.store.createProject(input);
    const key = `provision_${project.id}`;
    const promise = this.provision(project.id, agent, input.instructions ?? '').finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return project;
  }

  private async provision(projectId: string, agent: Agent, instructions: string): Promise<void> {
    try {
      const { sessionId } = await this.execPort.createSession(agent.sessionTemplateId, {
        settings: { allowedTools: agent.allowedTools },
        claudeMd: [agent.instructions, instructions].filter(Boolean).join('\n\n'),
      });
      this.store.setProjectSession(projectId, {
        sessionId,
        templateId: agent.sessionTemplateId,
        lastKnownState: 'ready',
      });
      this.store.updateProject(projectId, { status: 'ready' });
      this.notify.projectState(projectId, 'ready');
    } catch {
      this.store.updateProject(projectId, { status: 'error' });
      this.notify.projectState(projectId, 'error');
    }
  }

  /** PATCH archive semantics: archiving stops the session (08 §1, FR-30). */
  async archiveProject(projectId: string): Promise<Project> {
    const project = this.store.getProject(projectId);
    if (!project) throw new OrchestratorError('not_found', `project ${projectId}`);
    if (project.sessionBinding.sessionId) {
      try {
        await this.execPort.stopSession(project.sessionBinding.sessionId);
        this.store.setProjectSession(projectId, { lastKnownState: 'stopped' });
      } catch {
        // the substrate remains the authority on session state (06 §2)
      }
    }
    const updated = this.store.updateProject(projectId, { status: 'archived' });
    this.notify.projectState(projectId, 'archived');
    return updated;
  }

  createConversation(input: {
    projectId: string;
    title?: string;
    agentId?: string;
  }): Conversation {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new OrchestratorError('not_found', `project ${input.projectId}`);
    const agentId = input.agentId ?? project.defaultAgentId;
    this.mustAgent(agentId);
    return this.store.createConversation({
      projectId: input.projectId,
      title: input.title ?? 'New conversation',
      agentId,
    });
  }

  // — UC-02/03: send → queue → dispatch —

  send(conversationId: string, content: string): { message: Message; run: Run } {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new OrchestratorError('not_found', `conversation ${conversationId}`);
    const project = this.store.getProject(conversation.projectId);
    if (!project || project.status !== 'ready') {
      throw new OrchestratorError(
        'project_not_ready',
        `project is ${project?.status ?? 'missing'} (409 while provisioning/error, 08 §1)`,
      );
    }
    const agent = this.mustAgent(conversation.agentId);
    const result = this.store.sendMessage({
      conversationId,
      content,
      caps: agent.defaultCaps,
      policy: agent.allowedTools,
    });
    this.notify.runState(conversationId, { runId: result.run.id, state: 'queued' });
    this.pump(conversation.projectId);
    const run = this.store.getRun(result.run.id) ?? result.run;
    return { message: result.message, run };
  }

  /** Dispatch the project's queue (I-2 serialized, FIFO FR-04). */
  pump(projectId: string): void {
    const run = this.store.dispatchNextRun(projectId);
    if (!run) return;
    this.notify.runState(run.conversationId, { runId: run.id, state: 'starting' });
    const promise = this.executeRun(run)
      .catch(() => {
        // executeRun finalizes its own failures; a throw here is a bug guard
      })
      .finally(() => {
        this.inFlight.delete(run.id);
        this.pump(projectId); // the queue survives every terminal outcome (FR-04)
      });
    this.inFlight.set(run.id, promise);
  }

  /** Awaits every in-flight run — deterministic tests, clean shutdown. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()]);
    }
  }

  // — UC-04: cancellation —

  async cancelRun(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) throw new OrchestratorError('not_found', `run ${runId}`);
    if (run.state === 'queued') {
      const conversation = this.store.getConversation(run.conversationId)!;
      const message = this.store.getMessage(run.messageId)!;
      this.finalize(run, 'queued', 'cancelled', {
        usageSource: 'cancelled-unknown',
        userMessageContent: message.content,
        warnings: [],
        runtimeSessionId: conversation.runtimeSessionId,
      });
      this.pump(conversation.projectId);
      return;
    }
    if (run.state === 'starting' || run.state === 'streaming') {
      this.cancelRequested.add(runId);
      if (run.execId) {
        const conversation = this.store.getConversation(run.conversationId)!;
        const project = this.store.getProject(conversation.projectId)!;
        const { outcome } = await this.adapter.kill(
          project.sessionBinding.sessionId!,
          run.execId,
          KILL_GRACE_MS,
        );
        this.killOutcomes.set(runId, outcome);
      }
      return;
    }
    throw new OrchestratorError('run_not_cancellable', `run is ${run.state} (409, 08 §1)`);
  }

  // — UC-06: boot reconciliation (two transactions per run) —

  async reconcile(): Promise<void> {
    // tx 1 per run: stage every in-flight run to interrupted
    for (const run of this.store.listRunsByState(['starting', 'streaming'])) {
      this.store.transitionRun(run.id, run.state, 'interrupted');
      this.notify.runState(run.conversationId, { runId: run.id, state: 'interrupted' });
    }
    // network probe between the two transactions; tx 2 resolves
    for (const run of this.store.listRunsByState(['interrupted'])) {
      const conversation = this.store.getConversation(run.conversationId)!;
      const project = this.store.getProject(conversation.projectId)!;
      const message = this.store.getMessage(run.messageId)!;
      const sessionId = project.sessionBinding.sessionId;
      const probe =
        run.execId && sessionId
          ? await this.adapter.status(sessionId, run.execId)
          : ({ state: 'unknown' } as const);

      if (probe.state === 'exited') {
        // finalize from stored events + exit (05: no stream replay exists)
        const events = this.store.getEvents(run.id);
        const exitEvent = events.findLast((e) => e.type === 'exit');
        const exitCode = (exitEvent?.payload as { exitCode?: number | null } | undefined)
          ?.exitCode ?? probe.exitCode;
        const ok = exitCode === 0;
        this.finalize(run, 'interrupted', ok ? 'completed' : 'failed', {
          usageSource: 'error-partial',
          assistantContent: ok ? assembleAssistantText(events) || null : null,
          ...(ok
            ? {}
            : {
                errorCode: 'runtime_error' as const,
                errorDetail: `exited ${String(exitCode)} while Hub was down`,
              }),
          userMessageContent: message.content,
          warnings: [],
          runtimeSessionId: conversation.runtimeSessionId,
        });
      } else if (probe.state === 'running') {
        // no re-attach in v1 → kill, then cancelled
        const { outcome } = await this.adapter.kill(sessionId!, run.execId!, KILL_GRACE_MS);
        this.finalize(run, 'interrupted', 'cancelled', {
          usageSource: 'cancelled-unknown',
          killOutcome: outcome,
          userMessageContent: message.content,
          warnings: [],
          runtimeSessionId: conversation.runtimeSessionId,
        });
      } else {
        this.finalize(run, 'interrupted', 'failed', {
          usageSource: 'error-partial',
          errorCode: 'internal',
          errorDetail: 'exec state unknown after restart; orphan possible (UC-06)',
          userMessageContent: message.content,
          warnings: [],
          runtimeSessionId: conversation.runtimeSessionId,
        });
      }
    }
    // queue rebuild: re-arm every project that still has queued runs
    const projectIds = new Set<string>();
    for (const run of this.store.listRunsByState(['queued'])) {
      const conversation = this.store.getConversation(run.conversationId);
      if (conversation) projectIds.add(conversation.projectId);
    }
    for (const projectId of projectIds) this.pump(projectId);
  }

  // — the run loop —

  private async executeRun(run: Run): Promise<void> {
    const conversation = this.store.getConversation(run.conversationId)!;
    const project = this.store.getProject(conversation.projectId)!;
    const message = this.store.getMessage(run.messageId)!;
    const sessionId = project.sessionBinding.sessionId;

    if (!sessionId) {
      this.finalize(run, 'starting', 'failed', {
        usageSource: 'error-partial',
        errorCode: 'exec_refused',
        errorDetail: 'project has no substrate session (FR-33)',
        userMessageContent: message.content,
        warnings: [],
        runtimeSessionId: conversation.runtimeSessionId,
      });
      return;
    }

    const turn: TurnRequest = {
      prompt: message.content,
      policy: run.policySnapshot,
      caps: run.capsSnapshot,
      runtimeSessionId: conversation.runtimeSessionId,
      env: { ...this.runEnv, HUB_RUN_ID: run.id },
    };

    let seq = 0;
    let resultMeta: Extract<AdapterItem, { kind: 'result' }> | null = null;
    let exitMeta: Extract<AdapterItem, { kind: 'exit' }> | null = null;
    let runtimeSessionId = conversation.runtimeSessionId;
    const stderr: string[] = [];

    const ingest = (type: NewRunEvent['type'], payload: unknown): void => {
      seq += 1;
      const event = { id: `ev_${run.id}_${seq}`, seq, type, payload, ts: this.now() };
      const { inserted } = this.store.ingestEvents(run.id, [event]);
      if (inserted === 1 && (type === 'output' || type === 'tool_use' || type === 'permission_denial')) {
        // the cursor was just bumped for this row — its index is cursor-1
        const index = this.store.getSseCursor(conversation.id) - 1;
        this.notify.replayable(conversation.id, run.messageId, [
          { index, event: { ...event, runId: run.id } },
        ]);
      }
    };

    try {
      for await (const item of this.adapter.runTurn(sessionId, turn)) {
        switch (item.kind) {
          case 'started':
            this.store.transitionRun(run.id, 'starting', 'streaming', {
              execId: item.execId,
              pgid: item.pgid,
              seamRequestId: item.requestId,
            });
            this.notify.runState(conversation.id, { runId: run.id, state: 'streaming' });
            ingest('started', {
              execId: item.execId,
              pgid: item.pgid,
              requestId: item.requestId,
            });
            // a cancel that arrived while starting lands now that we have an id
            if (this.cancelRequested.has(run.id) && !this.killOutcomes.has(run.id)) {
              const { outcome } = await this.adapter.kill(sessionId, item.execId, KILL_GRACE_MS);
              this.killOutcomes.set(run.id, outcome);
            }
            break;
          case 'init':
            this.store.setRunInitMeta(run.id, {
              cliVersion: item.cliVersion,
              model: item.model,
            });
            if (item.runtimeSessionId) {
              runtimeSessionId = item.runtimeSessionId;
              this.store.setRuntimeSessionId(conversation.id, item.runtimeSessionId);
            }
            break;
          case 'event':
            ingest(item.type, item.payload);
            break;
          case 'stderr':
            if (stderr.length < STDERR_EXCERPT_MAX) stderr.push(item.data);
            break;
          case 'result':
            resultMeta = item;
            if (item.runtimeSessionId && item.runtimeSessionId !== runtimeSessionId) {
              runtimeSessionId = item.runtimeSessionId; // drift is captured (FR-24)
              this.store.setRuntimeSessionId(conversation.id, item.runtimeSessionId);
            }
            break;
          case 'exit':
            exitMeta = item;
            ingest('exit', { exitCode: item.exitCode, reason: item.reason ?? null });
            break;
        }
      }
    } catch (err) {
      const current = this.store.getRun(run.id)!;
      if (current.state === 'starting' || current.state === 'streaming') {
        this.finalize(current, current.state, 'failed', {
          usageSource: 'error-partial',
          errorCode: 'seam_unavailable',
          errorDetail: err instanceof Error ? err.message : String(err),
          userMessageContent: message.content,
          warnings: this.excerpts(stderr),
          runtimeSessionId,
        });
      }
      return;
    }

    const current = this.store.getRun(run.id)!;
    const from = current.state;
    if (from !== 'streaming' && from !== 'starting') return; // already resolved elsewhere

    const cancelled =
      this.cancelRequested.has(run.id) || exitMeta?.reason === 'killed';
    this.cancelRequested.delete(run.id);
    const killOutcome = this.killOutcomes.get(run.id);
    this.killOutcomes.delete(run.id);

    if (cancelled) {
      // killed runs emit no result event → usage unknown (FR-18, S-01)
      this.finalize(current, from, 'cancelled', {
        usageSource: 'cancelled-unknown',
        ...(killOutcome ? { killOutcome } : {}),
        userMessageContent: message.content,
        warnings: this.excerpts(stderr),
        runtimeSessionId,
      });
      return;
    }

    if (resultMeta && !resultMeta.isError) {
      const outcome: TerminalRunState =
        resultMeta.permissionDenialCount > 0 ? 'completed_with_denials' : 'completed'; // FR-15: never plain completed
      const text =
        resultMeta.resultText || assembleAssistantText(this.store.getEvents(run.id));
      this.finalize(current, from, outcome, {
        usageSource: 'result-event',
        usage: {
          totalCostUsd: resultMeta.totalCostUsd,
          numTurns: resultMeta.numTurns,
          usage: resultMeta.usage,
        },
        assistantContent: text || null,
        userMessageContent: message.content,
        warnings: this.excerpts(stderr),
        runtimeSessionId,
      });
      return;
    }

    this.finalize(current, from, 'failed', {
      usageSource: resultMeta ? 'result-event' : 'error-partial',
      ...(resultMeta
        ? {
            usage: {
              totalCostUsd: resultMeta.totalCostUsd,
              numTurns: resultMeta.numTurns,
              usage: resultMeta.usage,
            },
          }
        : {}),
      errorCode: 'runtime_error',
      errorDetail: `exit ${String(exitMeta?.exitCode ?? 'unknown')}${
        stderr.length > 0 ? `: ${this.excerpts(stderr)[0]}` : ''
      }`,
      userMessageContent: message.content,
      warnings: this.excerpts(stderr),
      runtimeSessionId,
    });
  }

  // — shared terminal-transition helper (09 §3: one transaction) —

  private finalize(
    run: Run,
    from: Run['state'],
    to: TerminalRunState,
    opts: {
      usageSource: UsageSource;
      usage?: { totalCostUsd: number | null; numTurns: number | null; usage: unknown };
      assistantContent?: string | null;
      errorCode?: RunErrorCode;
      errorDetail?: string;
      killOutcome?: KillOutcome;
      userMessageContent: string;
      warnings: string[];
      runtimeSessionId: string | null;
    },
  ): void {
    const endedAt = this.now();
    const usage = opts.usage ?? { totalCostUsd: null, numTurns: null, usage: null };
    const summary = deriveRunSummary({
      run: this.store.getRun(run.id) ?? run,
      outcome: to,
      events: this.store.getEvents(run.id),
      usage: { totalCostUsd: usage.totalCostUsd, numTurns: usage.numTurns },
      userMessageContent: opts.userMessageContent,
      warnings: opts.warnings,
      runtimeSessionId: opts.runtimeSessionId,
      endedAt,
    });
    const finalRun = this.store.finalizeRun({
      runId: run.id,
      from,
      to,
      assistantContent: opts.assistantContent ?? null,
      usage: { ...usage, source: opts.usageSource },
      summary,
      ...(opts.errorCode ? { errorCode: opts.errorCode } : {}),
      ...(opts.errorDetail ? { errorDetail: opts.errorDetail } : {}),
      ...(opts.killOutcome ? { killOutcome: opts.killOutcome } : {}),
    });
    // terminal projections, after the transaction (08 §3)
    this.notify.runState(run.conversationId, {
      runId: run.id,
      state: finalRun.state,
      errorCode: finalRun.errorCode,
      killOutcome: finalRun.killOutcome,
      sweepResult: finalRun.sweepResult,
    });
    const usageRecord = this.store.getUsage(run.id);
    if (usageRecord) this.notify.usage(run.conversationId, usageRecord);
    this.notify.summary(run.conversationId, summary);
  }

  private excerpts(stderr: string[]): string[] {
    return stderr
      .join('')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(0, STDERR_EXCERPTS_MAX)
      .map((l) => l.slice(0, STDERR_EXCERPT_MAX));
  }

  private mustAgent(agentId: string): Agent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new OrchestratorError('unknown_agent', `agent ${agentId} not configured`);
    return agent;
  }
}
