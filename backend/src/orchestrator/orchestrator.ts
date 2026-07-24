/**
 * Run orchestrator (07 §2, B1-04): owns the state machine walk — send →
 * queue → dispatch → ingest (batched, idempotent) → terminal transition —
 * each persistence step one HubStore transaction (09 §3). Also provisioning
 * (UC-01), cancellation (UC-04), the boot reconciler (UC-06) and queue
 * rebuild. Talks to the runtime ONLY through the RuntimeAdapter port and to
 * the substrate ONLY for session lifecycle (07 §2 arrows).
 */

import {
  DEFAULT_TOKEN_PRICES,
  estimateCostUsd,
  type TokenPrices,
} from '../config/budget.js';
import { systemClock, type Clock } from '../domain/ids.js';
import {
  NOOP_LOGGER,
  NOOP_METRICS,
  NOOP_NOTIFIER,
  type AdapterItem,
  type HubNotifier,
  type Logger,
  type Metrics,
  type ReportExtractorPort,
  type RouterPort,
  type RuntimeAdapter,
  type SubstrateExecPort,
  type TurnRequest,
  type WorkspaceManagerPort,
} from '../domain/ports.js';
import { isTerminalTask } from '../domain/taskStateMachine.js';
import { mustAgent, OrchestratorError } from './errors.js';
import { ProvisioningService } from './provisioningService.js';
import { DeterministicRouter } from './router.js';
import { DeterministicReportExtractor } from './reportExtractor.js';
import { FakeWorkspaceManager } from './workspaceManager.js';
import { TaskCoordinator } from './taskCoordinator.js';
import { NoExecutionTargetError, selectExecutionTarget } from './selector.js';
import {
  assembleAssistantText,
  deriveRunSummary,
  deriveConversationTitle,
  DEFAULT_CONVERSATION_TITLE,
} from '../domain/projections.js';
import { workspaceKeyFor } from '../domain/types.js';
import type {
  Agent,
  Conversation,
  ConversationMode,
  ExecutionTargetDecision,
  KillOutcome,
  Message,
  Project,
  RouteProposal,
  Run,
  RunErrorCode,
  SpecialistSessionBinding,
  SweepResult,
  Task,
  TaskStep,
  TerminalRunState,
  UsageSource,
} from '../domain/types.js';
import type { HubStore, NewRunEvent } from '../store/types.js';

// Moved to its own file so ADR-013 collaborators can throw it without
// importing the facade; re-exported to keep the api module's import unchanged.
export { OrchestratorError } from './errors.js';

export interface OrchestratorDeps {
  store: HubStore;
  adapter: RuntimeAdapter;
  /** session lifecycle only (UC-01) — turns go through the adapter */
  execPort: SubstrateExecPort;
  agents: ReadonlyMap<string, Agent>;
  /**
   * Proposes which specialist handles a turn in automatic mode (ADR-008).
   * Defaults to the deterministic router (N4a — echoes the conversation's own
   * specialist, no model, fully offline); N4b injects a model-backed router into
   * `real` mode behind this same port. Only automatic-mode conversations use it.
   */
  router?: RouterPort;
  /**
   * Turns a specialist step's output into a typed work product (N5b, ADR-009).
   * Defaults to the deterministic (mechanical) extractor; `real` mode injects
   * the model-backed one behind the same port. Used only by the task supervisor.
   */
  reportExtractor?: ReportExtractorPort;
  /**
   * Isolates each task in a git worktree over the exec seam (ADR-010 B, N5b-2).
   * Defaults to the offline fake (a deterministic worktree descriptor, no git);
   * `real` mode injects the git-backed one. Used only by the task supervisor.
   */
  workspaceManager?: WorkspaceManagerPort;
  /** Bound on the dev↔QA cycle before a task fails (N5b); supervisor default otherwise. */
  maxQaCycles?: number;
  /**
   * The specialist that reviews (QA) a task's implementation (N5b). The task
   * envelope only fires when this is set (and differs from the routed developer),
   * so a hub with no QA specialist configured never spawns tasks — an ordinary
   * turn runs instead. `real` mode sets it from config.
   */
  qaSpecialistId?: string;
  clock?: Clock;
  /** extra env for every run (e.g. the OAuth token in Increment 2) */
  runEnv?: Record<string, string>;
  /** token prices for the lagging budget estimate (B3-06); defaults applied by config */
  tokenPrices?: TokenPrices;
  /** wall-clock backstop grace over caps.timeoutMs before the Hub kills a hung run (FR-25) */
  timeoutGraceMs?: number;
  /** live-delivery sink (ADR-004); losing notifications loses nothing (NFR-07) */
  notify?: HubNotifier;
  /** structured logging + metrics (B3-07); no-ops by default */
  logger?: Logger;
  metrics?: Metrics;
}

const STDERR_EXCERPT_MAX = 500;
const STDERR_EXCERPTS_MAX = 5;
const KILL_GRACE_MS = 5000;

/** Post-cancel sweep exec wall-clock cap (FR-21). */
const SWEEP_MAX_MS = 15_000;

/** Hub wall-clock backstop over caps.timeoutMs before killing a hung run (FR-25). */
const DEFAULT_TIMEOUT_GRACE_MS = 30_000;

/**
 * Runs inside the session container as `bash -c <script> hub_sweep <runId>`.
 * Lists pids whose environ carries the exact HUB_RUN_ID marker, TERMs them,
 * waits, KILLs the stubborn, and reports `HUB_SWEEP|<found>|<post-term>|<final>`
 * (space-separated pid lists). Self-excluded via $$; the sweep exec itself
 * carries no HUB_RUN_ID env.
 */
const SWEEP_SCRIPT = `
MARK="HUB_RUN_ID=$1"
list() {
  for e in /proc/[0-9]*/environ; do
    p="\${e#/proc/}"; p="\${p%/environ}"
    [ "$p" = "$$" ] && continue
    if tr "\\0" "\\n" < "$e" 2>/dev/null | grep -qxF "$MARK"; then printf "%s " "$p"; fi
  done
}
FOUND="$(list)"
for p in $FOUND; do kill -TERM "$p" 2>/dev/null || true; done
[ -n "$FOUND" ] && sleep 2
REMAIN="$(list)"
for p in $REMAIN; do kill -KILL "$p" 2>/dev/null || true; done
[ -n "$REMAIN" ] && sleep 1
FINAL="$(list)"
echo "HUB_SWEEP|\${FOUND% }|\${REMAIN% }|\${FINAL% }"
`;

export class Orchestrator {
  private readonly store: HubStore;
  private readonly adapter: RuntimeAdapter;
  private readonly execPort: SubstrateExecPort;
  private readonly agents: ReadonlyMap<string, Agent>;
  private readonly router: RouterPort;
  private readonly now: Clock;
  private readonly runEnv: Record<string, string>;
  private readonly tokenPrices: TokenPrices;
  private readonly timeoutGraceMs: number;
  private readonly notify: HubNotifier;
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly cancelRequested = new Set<string>();
  /** runs the Hub timed out (FR-25 backstop) or budget-tripped (R-06), for terminal classification (B3-06). */
  private readonly timedOut = new Set<string>();
  private readonly budgetTripped = new Set<string>();
  /**
   * In-flight kill round-trips (B3-01). The seam kills the process group
   * and the stream can emit its `exit(killed)` and END before the kill
   * HTTP response returns — reading a plain outcome map at stream end
   * loses the outcome (found by the Increment-2 live acceptance; the
   * fake's synchronous kill never loses that race). Terminal resolution
   * AWAITS the pending promise instead.
   */
  private readonly pendingKills = new Map<string, Promise<KillOutcome | undefined>>();

  /** Everything task-shaped (ADR-013): the Supervisor wrapper, envelopes, approval, task healing. */
  private readonly tasks: TaskCoordinator;
  /** Project/specialist-session lifecycle (ADR-013): discovery, provisioning, bind, archive/restore. */
  private readonly provisioning: ProvisioningService;
  private readonly qaSpecialistId: string | null;

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store;
    this.adapter = deps.adapter;
    this.execPort = deps.execPort;
    this.agents = deps.agents;
    this.router = deps.router ?? new DeterministicRouter();
    this.now = deps.clock ?? systemClock;
    this.runEnv = deps.runEnv ?? {};
    this.tokenPrices = deps.tokenPrices ?? DEFAULT_TOKEN_PRICES;
    this.timeoutGraceMs = deps.timeoutGraceMs ?? DEFAULT_TIMEOUT_GRACE_MS;
    this.notify = deps.notify ?? NOOP_NOTIFIER;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.qaSpecialistId = deps.qaSpecialistId ?? null;
    this.tasks = new TaskCoordinator({
      store: this.store,
      agents: this.agents,
      workspaceManager: deps.workspaceManager ?? new FakeWorkspaceManager(),
      extractor: deps.reportExtractor ?? new DeterministicReportExtractor(),
      qaSpecialistId: this.qaSpecialistId,
      ...(deps.maxQaCycles !== undefined ? { maxQaCycles: deps.maxQaCycles } : {}),
      // the run machinery, injected (ADR-013): dispatch and the terminal choke point
      pump: (key) => this.pump(key),
      finalize: (run, from, to, opts) => this.finalize(run, from, to, opts),
      notify: this.notify,
      logger: this.logger,
    });
    this.provisioning = new ProvisioningService({
      store: this.store,
      adapter: this.adapter,
      execPort: this.execPort,
      agents: this.agents,
      notify: this.notify,
      logger: this.logger,
    });
  }

  // — project & specialist-session lifecycle (ADR-013): delegated to the
  // ProvisioningService; these stay on the facade for the api module —

  listSessions(): ReturnType<ProvisioningService['listSessions']> {
    return this.provisioning.listSessions();
  }

  createProject(input: Parameters<ProvisioningService['createProject']>[0]): Project {
    return this.provisioning.createProject(input);
  }

  bindSpecialistSession(
    specialistId: string,
    input: { sessionId?: string | null; sessionTemplateId?: string | null },
  ): Promise<SpecialistSessionBinding> {
    return this.provisioning.bindSpecialistSession(specialistId, input);
  }

  archiveProject(projectId: string): Promise<Project> {
    return this.provisioning.archiveProject(projectId);
  }

  restoreProject(projectId: string): Promise<Project> {
    return this.provisioning.restoreProject(projectId);
  }

  restoreConversation(conversationId: string): Conversation {
    return this.provisioning.restoreConversation(conversationId);
  }


  createConversation(input: {
    projectId: string;
    title?: string;
    agentId?: string;
    /**
     * `automatic` (default since N4b, ADR-008/012) routes each turn — the model
     * router proposes the specialist and the deterministic selector the session,
     * both recorded on the run. `direct` pins `agentId` and interposes no model
     * call. `agentId` is the routing prior/default either way.
     */
    mode?: ConversationMode;
  }): Conversation {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new OrchestratorError('not_found', `project ${input.projectId}`);
    const agentId = input.agentId ?? project.defaultAgentId;
    this.mustAgent(agentId);
    return this.store.createConversation({
      projectId: input.projectId,
      title: input.title ?? DEFAULT_CONVERSATION_TITLE,
      agentId,
      // N4b: automatic routing is the default for new project conversations.
      mode: input.mode ?? 'automatic',
    });
  }

  /**
   * A direct conversation with a specialist (N3b-2, ADR-008): no project, runs
   * in the specialist's personal session. Requires a bound session (N3b-1) —
   * there is nowhere to run otherwise.
   */
  createSpecialistConversation(specialistId: string, title?: string): Conversation {
    this.mustAgent(specialistId);
    if (!this.store.getSpecialistSession(specialistId)) {
      throw new OrchestratorError(
        'project_not_ready',
        `specialist ${specialistId} has no session bound — bind one first (N3b-1)`,
      );
    }
    return this.store.createConversation({
      projectId: null,
      title: title ?? 'New conversation',
      agentId: specialistId,
      mode: 'direct',
    });
  }

  // — UC-02/03: send → queue → dispatch —

  send(conversationId: string, content: string): { message: Message; run: Run } {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new OrchestratorError('not_found', `conversation ${conversationId}`);
    // Gate on the conversation's workspace being usable. A project
    // conversation needs its project ready (existing 08 §1 rule). A direct
    // specialist conversation (N3b-2) needs a bound session — whether it is
    // running (or must be started) is handled at execution, so an offline
    // session yields a failed run with a clear message, not a rejected send.
    if (conversation.projectId !== null) {
      const project = this.store.getProject(conversation.projectId);
      if (!project || project.status !== 'ready') {
        throw new OrchestratorError(
          'project_not_ready',
          `project is ${project?.status ?? 'missing'} (409 while provisioning/error, 08 §1)`,
        );
      }
    } else if (!this.store.getSpecialistSession(conversation.agentId)) {
      throw new OrchestratorError(
        'project_not_ready',
        `specialist ${conversation.agentId} has no session bound — bind one first (N3b-1)`,
      );
    }
    const agent = this.mustAgent(conversation.agentId);
    // A conversation earns its name from its first message, so the sidebar
    // reads as distinct threads instead of a wall of "New conversation"
    // (11 §9). Only when nothing has been said yet AND the title is still the
    // birth default — an explicit rename, or any later message, is never
    // overwritten.
    const isFirstMessage = this.store.listMessages(conversationId, { limit: 1 }).length === 0;
    const result = this.store.sendMessage({
      conversationId,
      content,
      caps: agent.defaultCaps,
      policy: agent.allowedTools,
      instructions: agent.instructions,
    });
    if (isFirstMessage && conversation.title === DEFAULT_CONVERSATION_TITLE) {
      const title = deriveConversationTitle(content);
      if (title !== '') this.store.updateConversation(conversationId, { title });
    }
    this.notify.runState(conversationId, { runId: result.run.id, state: 'queued' });
    this.pump(workspaceKeyFor(conversation));
    const run = this.store.getRun(result.run.id) ?? result.run;
    return { message: result.message, run };
  }

  /** Dispatch the workspace's queue (I-2 serialized per workspace, FIFO FR-04). */
  pump(workspaceKey: string): void {
    const run = this.store.dispatchNextRun(workspaceKey);
    if (!run) return;
    this.notify.runState(run.conversationId, { runId: run.id, state: 'starting' });
    const promise = this.executeRun(run)
      .catch(() => {
        // executeRun finalizes its own failures; a throw here is a bug guard
      })
      .finally(() => {
        this.inFlight.delete(run.id);
        this.pump(workspaceKey); // the queue survives every terminal outcome (FR-04)
      });
    this.inFlight.set(run.id, promise);
  }

  /** Awaits every in-flight run, task-supervision and provisioning — deterministic tests, clean shutdown. */
  async idle(): Promise<void> {
    while (
      this.inFlight.size > 0 ||
      this.tasks.driving().length > 0 ||
      this.provisioning.pending().length > 0
    ) {
      await Promise.all([
        ...this.inFlight.values(),
        ...this.tasks.driving(),
        ...this.provisioning.pending(),
      ]);
    }
  }

  // — N5b/N6 (ADR-009): task supervision + human approval — delegated to the
  // TaskCoordinator (ADR-013); these stay on the facade for the api module —

  startTask(input: {
    projectId: string;
    sourceConversationId: string;
    sourceMessageId: string;
    objective: string;
    devSpecialistId: string;
    qaSpecialistId: string;
  }): Task {
    return this.tasks.startTask(input);
  }

  approveTask(taskId: string): Promise<Task> {
    return this.tasks.approveTask(taskId);
  }

  rejectTask(taskId: string): Promise<Task> {
    return this.tasks.rejectTask(taskId);
  }

  requestTaskChanges(taskId: string, note: string): Task {
    return this.tasks.requestTaskChanges(taskId, note);
  }

  /**
   * Can this specialist take a task's IMPLEMENTATION step (#124)? Declared
   * capabilities must include `implementation`; a specialist that declares
   * none is unconstrained (backward-compatible — capabilities are optional in
   * AGENTS_CONFIG). This is what keeps a design-only role (the architect) out
   * of the dev seat, where the dev → QA loop can never converge.
   */
  private canImplement(agent: Agent): boolean {
    return agent.capabilities === undefined || agent.capabilities.includes('implementation');
  }

  /**
   * The developer for a task's implementation steps (ADR-015, #124): the
   * CONVERSATION'S OWN agent when it can implement — the entity that already
   * holds the context implements by default, no third-party fresh-context tax
   * — else the router's contextual pick when capable, else the first capable
   * specialist by stable id order. The QA specialist is never the developer
   * (the envelope's independence requirement). Null = nobody can implement;
   * the caller falls back to a normal turn rather than spawning a task doomed
   * to loop.
   */
  private resolveDevSpecialist(
    proposal: RouteProposal,
    conversation: Conversation,
  ): string | null {
    const eligible = (a: Agent | undefined): boolean =>
      a !== undefined && a.id !== this.qaSpecialistId && this.canImplement(a);
    const conversationOwn = this.agents.get(conversation.agentId);
    if (eligible(conversationOwn)) return conversationOwn!.id;
    const proposed = this.agents.get(proposal.specialistId);
    if (eligible(proposed)) return proposed!.id;
    const candidates = [...this.agents.values()]
      .filter((a) => eligible(a))
      .sort((a, b) => a.id.localeCompare(b.id));
    return candidates[0]?.id ?? null;
  }

  /**
   * The `--resume` handle for a task step (#123): the latest recorded handle
   * of a PRIOR step of the same task + specialist + kind, so an implementer's
   * attempt N continues attempt N-1 and a QA cycle continues its own previous
   * cycle — never another role's CLI context, and never the conversation's
   * handle. First step of a chain → null (fresh CLI conversation).
   */
  private stepResumeSessionId(step: TaskStep): string | null {
    const prior = this.store
      .listTaskSteps(step.taskId)
      .filter(
        (s) =>
          s.seq < step.seq &&
          s.specialistId === step.specialistId &&
          s.kind === step.kind &&
          s.runtimeSessionId !== null,
      );
    return prior.at(-1)?.runtimeSessionId ?? null;
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
      this.pump(workspaceKeyFor(conversation));
      return;
    }
    if (run.state === 'starting' || run.state === 'streaming') {
      this.cancelRequested.add(runId);
      if (run.execId) {
        const conversation = this.store.getConversation(run.conversationId)!;
        const pending = this.adapter.kill(
          this.sessionMetaForConversation(conversation).sessionId!,
          run.execId,
          KILL_GRACE_MS,
        );
        // registered BEFORE awaiting so terminal resolution can await it
        // even when the stream ends first (kill-outcome race, B3-01)
        this.pendingKills.set(
          runId,
          pending.then((r) => r.outcome).catch(() => undefined),
        );
        await pending; // kill API errors still surface to the caller
      }
      return;
    }
    throw new OrchestratorError('run_not_cancellable', `run is ${run.state} (409, 08 §1)`);
  }

  // — UC-06: boot reconciliation (two transactions per run) —

  async reconcile(): Promise<void> {
    // projects caught mid-provisioning by the crash (B3-02) — the
    // ProvisioningService owns the healing
    this.provisioning.reconcileProvisioning();
    // tx 1 per run: stage every in-flight run to interrupted
    for (const run of this.store.listRunsByState(['starting', 'streaming'])) {
      this.store.transitionRun(run.id, run.state, 'interrupted');
      this.notify.runState(run.conversationId, { runId: run.id, state: 'interrupted' });
    }
    // network probe between the two transactions; tx 2 resolves
    for (const run of this.store.listRunsByState(['interrupted'])) {
      const conversation = this.store.getConversation(run.conversationId)!;
      const message = this.store.getMessage(run.messageId)!;
      const sessionId = this.sessionMetaForConversation(conversation).sessionId;
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
        // no re-attach in v1 → kill, then cancelled; the pre-crash run may
        // have escaped Bash-tool children, so the FR-21 sweep applies here
        // exactly as it does to a live cancel (B3-02)
        const { outcome } = await this.adapter.kill(sessionId!, run.execId!, KILL_GRACE_MS);
        const warnings: string[] = [];
        const swept = await this.sweep(sessionId!, run.id);
        if (swept.warning) warnings.push(swept.warning);
        this.finalize(run, 'interrupted', 'cancelled', {
          usageSource: 'cancelled-unknown',
          killOutcome: outcome,
          ...(swept.result ? { sweepResult: swept.result } : {}),
          userMessageContent: message.content,
          warnings,
          runtimeSessionId: conversation.runtimeSessionId,
        });
      } else {
        // unknown = registry lost or never existed; if the session is still
        // bound, the marker sweep is the one orphan-mitigation available —
        // it kills whatever the crashed run left behind (B3-02)
        const warnings: string[] = [];
        let sweepResult: SweepResult | undefined;
        if (sessionId) {
          const swept = await this.sweep(sessionId, run.id);
          if (swept.warning) warnings.push(swept.warning);
          sweepResult = swept.result;
        }
        this.finalize(run, 'interrupted', 'failed', {
          usageSource: 'error-partial',
          errorCode: 'internal',
          errorDetail: 'exec state unknown after restart; orphan possible (UC-06)',
          ...(sweepResult ? { sweepResult } : {}),
          userMessageContent: message.content,
          warnings,
          runtimeSessionId: conversation.runtimeSessionId,
        });
      }
    }
    // in-flight tasks whose supervise() loop died with the crash (ADR-009
    // "Boot reconciliation of tasks") — the TaskCoordinator owns the healing
    await this.tasks.reconcileTasks();

    // queue rebuild: re-arm every WORKSPACE that still has queued runs
    // (projects and specialist workspaces alike, N3b-2)
    const keys = new Set<string>();
    for (const run of this.store.listRunsByState(['queued'])) {
      const conversation = this.store.getConversation(run.conversationId);
      if (conversation) keys.add(workspaceKeyFor(conversation));
    }
    for (const key of keys) this.pump(key);
  }

  // — the run loop —

  /**
   * The session a conversation's runs use, looked up (never started) plus its
   * cached state — for kill/reconcile/error-context. Project conversation →
   * the project's binding; direct specialist conversation → the specialist's
   * (N3b-2). See `resolveRunSession` for the execution path that also starts it.
   */
  private sessionMetaForConversation(c: Conversation): {
    sessionId: string | null;
    lastKnownState: string | null;
  } {
    if (c.projectId !== null) {
      const b = this.store.getProject(c.projectId)?.sessionBinding;
      return { sessionId: b?.sessionId ?? null, lastKnownState: b?.lastKnownState ?? null };
    }
    const b = this.store.getSpecialistSession(c.agentId);
    return { sessionId: b?.sessionId ?? null, lastKnownState: b?.lastKnownState ?? null };
  }

  private async resolveRunSession(
    run: Run,
    conversation: Conversation,
    userMessageContent: string,
  ): Promise<string | null> {
    const fail = (detail: string): null => {
      this.finalize(run, 'starting', 'failed', {
        usageSource: 'error-partial',
        errorCode: 'exec_refused',
        errorDetail: detail,
        userMessageContent,
        warnings: [],
        runtimeSessionId: conversation.runtimeSessionId,
      });
      return null;
    };

    // A task step run (N5b, ADR-009/010 A): the supervisor already chose the
    // specialist, and the step runs in its project's primary session — never
    // re-routed. Structural, so no selector and no recorded target decision.
    if (run.taskStepId !== null) {
      const sessionId =
        conversation.projectId !== null
          ? this.store.getProject(conversation.projectId)?.sessionBinding.sessionId ?? null
          : null;
      return sessionId ?? fail('task step run has no project session (ADR-010 A)');
    }

    // Automatic mode (N4a, ADR-008): the router proposes a specialist and the
    // deterministic selector chooses the session, recorded on the run. Direct
    // mode derives the session structurally, with no selector in the loop.
    if (conversation.mode === 'automatic') {
      return this.resolveAutomaticTarget(run, conversation, userMessageContent, fail);
    }

    if (conversation.projectId !== null) {
      const sessionId = this.store.getProject(conversation.projectId)?.sessionBinding.sessionId ?? null;
      return sessionId ?? fail('project has no substrate session (FR-33)');
    }

    // direct specialist conversation
    const binding = this.store.getSpecialistSession(conversation.agentId);
    if (!binding) return fail(`specialist ${conversation.agentId} has no session bound (N3b-1)`);
    return this.ensureSpecialistSessionRunnable(binding, fail);
  }

  /**
   * Automatic-mode session resolution (N4a, ADR-008 Option 3). The router only
   * PROPOSES a specialist; the deterministic selector chooses the session from
   * real bindings — never a model (01 §3, SEC-01). The decision persists on the
   * run before the turn executes, so the inspector shows who ran, where and why.
   * In N4a the router echoes the conversation's own specialist, so the choice is
   * structural; the message-aware router that can pick a different specialist is
   * N4b, behind the same port.
   */
  private async resolveAutomaticTarget(
    run: Run,
    conversation: Conversation,
    userMessageContent: string,
    fail: (detail: string) => null,
  ): Promise<string | null> {
    const proposal = await this.router.route({
      message: userMessageContent,
      specialists: [...this.agents.values()],
      conversation: {
        id: conversation.id,
        projectId: conversation.projectId,
        agentId: conversation.agentId,
        mode: conversation.mode,
      },
    });

    // Envelope (N5b, ADR-009): a routed `task` in a project conversation is not
    // a single turn — it spawns a supervised developer → QA task. This run is a
    // light kickoff (no substrate turn); the implementation and QA execute as
    // their own step runs the supervisor owns. Gated on a configured QA
    // specialist and an implementation-capable developer (#124) — a hub with
    // neither just runs a normal turn (the routed specialist answers).
    if (
      proposal.workType === 'task' &&
      conversation.projectId !== null &&
      this.qaSpecialistId !== null
    ) {
      // I-14 (ADR-014): a conversation has at most ONE active task. A
      // work-shaped message while one runs STEERS it — folded at the next
      // step boundary, or re-entering the loop from awaiting_human_approval —
      // never a sibling task. Questions fall through to a normal turn above
      // (workType 'question' never reaches this branch).
      const activeTask = this.store
        .listTasks({ sourceConversationId: conversation.id })
        .find((t) => !isTerminalTask(t.state));
      if (activeTask) {
        this.tasks.steerTask(run, conversation, activeTask, userMessageContent);
        return null; // the steer run executes no turn
      }
      const devSpecialistId = this.resolveDevSpecialist(proposal, conversation);
      if (devSpecialistId !== null) {
        if (devSpecialistId !== proposal.specialistId) {
          // the router's contextual pick could not implement (#124 — the
          // architect-as-implementer loop); the audit trail is the step row
          this.logger.info('task.dev_rerouted', {
            runId: run.id,
            proposed: proposal.specialistId,
            devSpecialistId,
          });
        }
        const task = this.tasks.startTask({
          projectId: conversation.projectId,
          sourceConversationId: conversation.id,
          sourceMessageId: run.messageId,
          objective: userMessageContent,
          devSpecialistId,
          qaSpecialistId: this.qaSpecialistId,
        });
        this.tasks.finalizeTaskKickoff(run, conversation, userMessageContent, task);
        return null; // the kickoff run executes no turn
      }
      // no implementation-capable specialist → fall through to a normal turn
    }

    const projectPrimarySessionId =
      conversation.projectId !== null
        ? this.store.getProject(conversation.projectId)?.sessionBinding.sessionId ?? null
        : null;
    const specialistBinding = this.store.getSpecialistSession(proposal.specialistId);

    let decision: ExecutionTargetDecision;
    try {
      decision = selectExecutionTarget({
        proposal,
        projectPrimarySessionId,
        specialistSessionId: specialistBinding?.sessionId ?? null,
      });
    } catch (err) {
      if (err instanceof NoExecutionTargetError) {
        return fail(
          `no execution target for specialist ${proposal.specialistId} (ADR-008): neither a project primary session nor a bound specialist session`,
        );
      }
      throw err;
    }

    this.store.recordRunTarget(run.id, decision.selectedSessionId, decision);

    // The selector chose the session; it must still be runnable. A project
    // primary session was already gated `ready` at send; a specialist session
    // may need starting on use — the same path a direct specialist run takes.
    if (decision.workspaceStrategy === 'specialist-session') {
      return this.ensureSpecialistSessionRunnable(specialistBinding!, fail);
    }
    return decision.selectedSessionId;
  }

  /**
   * Ensure a specialist's bound session is running, starting it on use (N3b-2,
   * owner decision — needs operate-tier start upstream, shared-terminal#429).
   * Returns the session id, or `fail`s (returning null) if it is gone upstream
   * (FR-44) or cannot be started. Shared by direct and automatic resolution.
   */
  private async ensureSpecialistSessionRunnable(
    binding: SpecialistSessionBinding,
    fail: (detail: string) => null,
  ): Promise<string | null> {
    const info = await this.execPort.getSession(binding.sessionId);
    if (info === null) {
      this.store.setSpecialistSession({ ...binding, status: 'error', lastKnownState: null });
      return fail(`specialist session ${binding.sessionId} no longer exists upstream (FR-44)`);
    }
    if (info.status !== 'running') {
      // Until #429 ships an owner session 403s on start: report it honestly
      // rather than silently. Auto-starts once #429 lands.
      try {
        await this.execPort.startSession(binding.sessionId);
        this.store.setSpecialistSession({ ...binding, status: 'available', lastKnownState: 'running' });
      } catch {
        this.store.setSpecialistSession({ ...binding, status: 'offline', lastKnownState: info.status });
        return fail(
          `specialist session is ${info.status} and could not be started from the Hub — start it in Shared Terminal (auto-start pending shared-terminal#429)`,
        );
      }
    }
    return binding.sessionId;
  }

  private async executeRun(run: Run): Promise<void> {
    const conversation = this.store.getConversation(run.conversationId)!;
    const message = this.store.getMessage(run.messageId)!;
    let sessionId: string | null;
    try {
      sessionId = await this.resolveRunSession(run, conversation, message.content);
    } catch (err) {
      // An UNEXPECTED throw from resolution (e.g. the seam's getSession call
      // hits a transient 500/timeout/ECONNRESET) is not one
      // of resolveRunSession's own fail() paths — those already finalize and
      // return null. Left uncaught, this would escape executeRun; pump()'s
      // `.catch(() => {})` would swallow it silently while the run stayed
      // `starting` forever, wedging the whole workspace queue behind it
      // (dispatchNextRun treats `starting` as the active run — I-2/FR-04).
      // Finalizing here — same pattern as resolveRunSession's own fail() —
      // keeps the queue moving no matter how resolution fails.
      //
      // Classify like the mid-turn seam catch (08 §6): a 409/429 (container
      // down / caps) is exec_refused with the FR-33 session-state context so a
      // client can retry; anything else unreachable is seam_unavailable. Duck-
      // typed on `status` so the orchestrator keeps no substrate import.
      const status =
        err && typeof err === 'object' && 'status' in err ? Number((err as { status: unknown }).status) : NaN;
      const refused = status === 409 || status === 429;
      const raw = err instanceof Error ? err.message : String(err);
      const lastKnownState = this.sessionMetaForConversation(conversation).lastKnownState ?? 'unknown';
      this.finalize(run, 'starting', 'failed', {
        usageSource: 'error-partial',
        errorCode: refused ? 'exec_refused' : 'seam_unavailable',
        errorDetail: refused ? `seam ${status}: ${raw} — session lastKnownState=${lastKnownState} (FR-33)` : raw,
        userMessageContent: message.content,
        warnings: [],
        runtimeSessionId: conversation.runtimeSessionId,
      });
      return;
    }
    if (sessionId === null) return; // resolveRunSession finalized the run

    // A task step runs inside its git worktree (ADR-010 B, N5b-2): the working
    // directory is the step's audited DelegatedWorkspaceAccess.path — the single
    // source of truth for where the step was granted to run. Null path (an
    // ordinary run, or the strategy-A fallback) → the session's default root.
    const step = run.taskStepId !== null ? (this.store.getTaskStep(run.taskStepId) ?? null) : null;
    const workingDir = step?.workspaceAccess?.path ?? null;

    // The continuation handle (#123). A step run resumes ITS OWN chain — the
    // latest handle of the same task + specialist + kind — never the
    // conversation's: a worktree step's CLI conversation is scoped to the
    // worktree cwd, so resuming (or, worse, overwriting) the conversation
    // handle poisons every post-task turn once the worktree is cleaned up,
    // and it bled CLI context across roles (QA resumed the implementer's
    // session). An ordinary run keeps the conversation handle (FR-24).
    const resumeSessionId = step ? this.stepResumeSessionId(step) : conversation.runtimeSessionId;

    const turn: TurnRequest = {
      prompt: message.content,
      policy: run.policySnapshot,
      caps: run.capsSnapshot,
      runtimeSessionId: resumeSessionId,
      env: { ...this.runEnv, HUB_RUN_ID: run.id },
      // Snapshotted at send like policy and caps (I-8), not read from live
      // config: a queued run survives a restart, and the restart re-reads
      // `agents.yaml` — so reading it here would run the turn under whatever
      // the role says NOW, not what it said when the turn was queued.
      instructions: run.instructionsSnapshot,
      ...(workingDir !== null ? { workingDir } : {}),
    };

    let seq = 0;
    let resultMeta: Extract<AdapterItem, { kind: 'result' }> | null = null;
    let exitMeta: Extract<AdapterItem, { kind: 'exit' }> | null = null;
    let runtimeSessionId = resumeSessionId;
    let execId: string | null = null;
    let estimatedCostUsd = 0;
    const stderr: string[] = [];

    // kill the exec once (timeout backstop or budget trip); reason is 'killed'
    // on the stream, and the timedOut/budgetTripped set disambiguates it from
    // a user cancel in resolveTerminal (B3-06)
    const killExec = (): void => {
      if (execId === null || this.pendingKills.has(run.id)) return;
      const pending = this.adapter.kill(sessionId, execId, KILL_GRACE_MS);
      this.pendingKills.set(
        run.id,
        pending.then((r) => r.outcome).catch(() => undefined),
      );
      void pending.catch(() => {});
    };

    // Hub wall-clock backstop (FR-25): the seam already caps the exec at
    // caps.timeoutMs, but if the stream hangs the Hub must still terminate.
    // Fires past the seam's own cap so the seam is primary, the Hub the net.
    const timeoutTimer = setTimeout(() => {
      this.timedOut.add(run.id);
      killExec();
    }, run.capsSnapshot.timeoutMs + this.timeoutGraceMs);
    timeoutTimer.unref?.();

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
            execId = item.execId;
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
            if (this.cancelRequested.has(run.id) && !this.pendingKills.has(run.id)) {
              const pending = this.adapter.kill(sessionId, item.execId, KILL_GRACE_MS);
              this.pendingKills.set(
                run.id,
                pending.then((r) => r.outcome).catch(() => undefined),
              );
              await pending.catch(() => {}); // stream teardown reports the state
            }
            break;
          case 'init':
            this.store.setRunInitMeta(run.id, {
              cliVersion: item.cliVersion,
              model: item.model,
            });
            if (item.runtimeSessionId) {
              runtimeSessionId = item.runtimeSessionId;
              // a step's handle lands on ITS row; only an ordinary run may
              // touch the conversation's (#123)
              if (step) this.store.setTaskStepRuntimeSessionId(step.id, item.runtimeSessionId);
              else this.store.setRuntimeSessionId(conversation.id, item.runtimeSessionId);
            }
            break;
          case 'event':
            ingest(item.type, item.payload);
            break;
          case 'usage':
            // lagging budget estimate (ADR-003, R-06): accumulate per-message
            // token cost; crossing the cap trips a kill → budget_exceeded. The
            // cap is opt-in — a null budgetUsd (the default) never trips; the
            // maxTurns + wall-clock bounds still guard a runaway run.
            estimatedCostUsd += estimateCostUsd(item, this.tokenPrices);
            if (
              run.capsSnapshot.budgetUsd !== null &&
              estimatedCostUsd > run.capsSnapshot.budgetUsd &&
              !this.budgetTripped.has(run.id)
            ) {
              this.budgetTripped.add(run.id);
              killExec();
            }
            break;
          case 'stderr':
            if (stderr.length < STDERR_EXCERPT_MAX) stderr.push(item.data);
            break;
          case 'result':
            resultMeta = item;
            if (item.runtimeSessionId && item.runtimeSessionId !== runtimeSessionId) {
              runtimeSessionId = item.runtimeSessionId; // drift is captured (FR-24)
              if (step) this.store.setTaskStepRuntimeSessionId(step.id, item.runtimeSessionId);
              else this.store.setRuntimeSessionId(conversation.id, item.runtimeSessionId);
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
        // seam 409/429 (container down / caps) is exec_refused and retryable
        // context; anything else unreachable is seam_unavailable (08 §6).
        // Duck-typed on `status` so the orchestrator keeps no substrate import.
        const status =
          err && typeof err === 'object' && 'status' in err ? Number((err as { status: unknown }).status) : NaN;
        const refused = status === 409 || status === 429;
        const raw = err instanceof Error ? err.message : String(err);
        // exec_refused: attach the session-state context FR-33 calls for, so a
        // client can retry provisioning without a second API call (matches the
        // no-session exec_refused path above; 08 §6)
        const lastKnownState =
          this.sessionMetaForConversation(conversation).lastKnownState ?? 'unknown';
        this.finalize(current, current.state, 'failed', {
          usageSource: 'error-partial',
          errorCode: refused ? 'exec_refused' : 'seam_unavailable',
          errorDetail: refused
            ? `seam ${status}: ${raw} — session lastKnownState=${lastKnownState} (FR-33)`
            : raw,
          // a mid-stream seam drop (container fell over after yielding text) is
          // still a run the user was reading — keep what streamed (this branch
          // is before the post-loop partialText, so assemble here too)
          assistantContent: assembleAssistantText(this.store.getEvents(run.id)) || null,
          userMessageContent: message.content,
          warnings: this.excerpts(stderr),
          runtimeSessionId,
        });
      }
      return;
    } finally {
      clearTimeout(timeoutTimer);
    }

    const current = this.store.getRun(run.id)!;
    const from = current.state;
    if (from !== 'streaming' && from !== 'starting') return; // already resolved elsewhere

    // Whatever the agent streamed before a NON-completed end — a budget/timeout
    // kill, a user cancel, a crash, a max-turns stop — is real work the user was
    // reading. Persist it as the assistant message so it survives the terminal
    // transition instead of vanishing with the live view (the live text is
    // cleared once the run settles, and a failed run used to save nothing, so
    // the partial answer was lost and only the error remained). Empty → no
    // message. The completed path keeps its own assembly (it also falls back to
    // the CLI's result text); this is for every other terminal outcome.
    const partialText = assembleAssistantText(this.store.getEvents(run.id)) || null;

    // a Hub timeout or budget trip also kills (exit reason 'killed'), so
    // these must be classified BEFORE the user-cancel branch (B3-06)
    const timedOut = this.timedOut.has(run.id) || exitMeta?.reason === 'timeout';
    const budgetTripped = this.budgetTripped.has(run.id);
    this.timedOut.delete(run.id);
    this.budgetTripped.delete(run.id);
    const cancelled =
      !timedOut &&
      !budgetTripped &&
      (this.cancelRequested.has(run.id) || exitMeta?.reason === 'killed');
    this.cancelRequested.delete(run.id);
    // the kill round-trip may still be in flight when the stream ends —
    // await it so the outcome is never lost (B3-01 race)
    const killOutcome = await this.pendingKills.get(run.id);
    this.pendingKills.delete(run.id);

    if (timedOut || budgetTripped) {
      // killed → possible escaped children (FR-21 sweep); usage unknown (FR-18)
      const warnings = this.excerpts(stderr);
      const swept = await this.sweep(sessionId, run.id);
      if (swept.warning) warnings.push(swept.warning);
      this.finalize(current, from, 'failed', {
        usageSource: 'cancelled-unknown',
        errorCode: timedOut ? 'run_timeout' : 'budget_exceeded',
        errorDetail: timedOut
          ? `wall-clock cap of ${run.capsSnapshot.timeoutMs} ms hit (FR-17)`
          : `budget cap of $${run.capsSnapshot.budgetUsd} crossed by the lagging estimate (ADR-003)`,
        assistantContent: partialText,
        ...(killOutcome ? { killOutcome } : {}),
        ...(swept.result ? { sweepResult: swept.result } : {}),
        userMessageContent: message.content,
        warnings,
        runtimeSessionId,
      });
      return;
    }

    if (cancelled) {
      // FR-21: sweep for Bash-tool children that escaped the process
      // group (S-01) before sealing the run, so sweepResult lands in the
      // same terminal transaction
      const warnings = this.excerpts(stderr);
      const swept = await this.sweep(sessionId, run.id);
      if (swept.warning) warnings.push(swept.warning);
      // killed runs emit no result event → usage unknown (FR-18, S-01)
      this.finalize(current, from, 'cancelled', {
        usageSource: 'cancelled-unknown',
        assistantContent: partialText,
        ...(killOutcome ? { killOutcome } : {}),
        ...(swept.result ? { sweepResult: swept.result } : {}),
        userMessageContent: message.content,
        warnings,
        runtimeSessionId,
      });
      return;
    }

    if (resultMeta && !resultMeta.isError) {
      const outcome: TerminalRunState =
        resultMeta.permissionDenialCount > 0 ? 'completed_with_denials' : 'completed'; // FR-15: never plain completed
      // The conversation gets everything the assistant SAID, in order — not
      // the CLI's closing summary.
      //
      // `result.result` is the CLI's final text only. Preferring it dropped
      // every earlier text block of a multi-step turn, and those blocks are
      // routinely where the answer lives: a `gh auth login` turn emitted the
      // device link and one-time code mid-turn, then closed with "I'll let
      // you know when it's done" — and only that closing line reached the
      // chat, so the code was unrecoverable from the UI (the events had it
      // all along). Assembling the blocks includes the final one, so this
      // adds the missing text rather than duplicating it; `resultText` stays
      // as the fallback for a turn that produced no text blocks at all.
      const text =
        assembleAssistantText(this.store.getEvents(run.id)) || resultMeta.resultText;
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

    // Running OUT OF TURNS is a soft stop, not a crash: the CLI reports it as
    // `error_max_turns` (verified against 2.1.212). It used to collapse into a
    // generic `runtime_error` with an "exit …" detail, indistinguishable from a
    // real failure. Give it its own code and keep the partial text the agent
    // produced before the limit — that work is usually the point of the turn.
    const maxTurns = resultMeta?.subtype === 'error_max_turns';
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
      errorCode: maxTurns ? 'max_turns' : 'runtime_error',
      errorDetail: maxTurns
        ? `reached the turn limit (${resultMeta?.numTurns ?? '?'} turns; cap ${
            current.capsSnapshot.maxTurns ?? '?'
          })`
        : `exit ${String(exitMeta?.exitCode ?? 'unknown')}${
            stderr.length > 0 ? `: ${this.excerpts(stderr)[0]}` : ''
          }`,
      assistantContent: partialText,
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
      sweepResult?: SweepResult;
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
      ...(opts.sweepResult ? { sweepResult: opts.sweepResult } : {}),
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

    // observability (B3-07): count the terminal transition + log ids/type
    // only — never the message, assistant text, or event payloads (13 §5)
    this.metrics.runTransition(finalRun.state);
    if (finalRun.errorCode === 'seam_unavailable' || finalRun.errorCode === 'exec_refused') {
      this.metrics.seamError();
    }
    const level = to === 'failed' ? 'error' : 'info';
    this.logger[level]('run.terminal', {
      runId: run.id,
      state: finalRun.state,
      errorCode: finalRun.errorCode ?? null,
      seamRequestId: finalRun.seamRequestId ?? null,
      costUsd: summary.costUsd,
      numTurns: summary.numTurns,
      durationMs: summary.durationMs,
    });

    // wake a task-step awaiter (N5b): the supervisor blocks on its step run's
    // terminal state, and `finalize` is the one choke point every outcome flows
    // through — success, failure, cancel, timeout alike.
    this.tasks.wakeRunTerminal(run.id);
  }

  /**
   * FR-21 / ADR-003: a short follow-up exec in the same session scans
   * every process's environ for the run's HUB_RUN_ID marker (inherited by
   * all descendants, including Bash-tool children that escaped the process
   * group), TERM→KILLs survivors, and reports pids. Uses the raw exec
   * port (this is plumbing, not a runtime turn) and carries NO env of its
   * own. Failure degrades to a warning — the cancel itself already stands.
   */
  private async sweep(
    sessionId: string,
    runId: string,
  ): Promise<{ result?: SweepResult; warning?: string }> {
    try {
      let stdout = '';
      const exec = this.execPort.exec(sessionId, {
        // runId rides as a positional parameter — never shell-interpreted
        argv: ['bash', '-c', SWEEP_SCRIPT, 'hub_sweep', runId],
        maxDurationMs: SWEEP_MAX_MS,
      });
      for await (const event of exec) {
        if (event.type === 'output' && event.stream === 'stdout') stdout += event.data;
        if (event.type === 'error') {
          return { warning: `post-cancel sweep failed: ${event.message}` };
        }
      }
      const report = stdout
        .split('\n')
        .reverse()
        .find((l) => l.startsWith('HUB_SWEEP|'));
      if (!report) return { warning: 'post-cancel sweep produced no report' };
      const [, foundRaw = '', , finalRaw = ''] = report.split('|');
      const found = foundRaw.split(' ').filter(Boolean);
      const survivors = finalRaw.split(' ').filter(Boolean);
      return {
        result: {
          matched: found.length,
          killed: found.filter((pid) => !survivors.includes(pid)),
          survivors,
        },
      };
    } catch (err) {
      return {
        warning: `post-cancel sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
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
    return mustAgent(this.agents, agentId);
  }
}
