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
  SessionGoneError,
  type AdapterItem,
  type HubNotifier,
  type Logger,
  type Metrics,
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
  SweepResult,
  TerminalRunState,
  UsageSource,
} from '../domain/types.js';
import type { HubStore, NewRunEvent } from '../store/types.js';

export class OrchestratorError extends Error {
  constructor(
    readonly code:
      | 'unknown_agent'
      | 'project_not_ready'
      | 'run_not_cancellable'
      | 'not_found'
      // restore (FR-44 / I-12): the API maps both to 409 with the code
      | 'session_gone'
      | 'project_archived',
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

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store;
    this.adapter = deps.adapter;
    this.execPort = deps.execPort;
    this.agents = deps.agents;
    this.now = deps.clock ?? systemClock;
    this.runEnv = deps.runEnv ?? {};
    this.tokenPrices = deps.tokenPrices ?? DEFAULT_TOKEN_PRICES;
    this.timeoutGraceMs = deps.timeoutGraceMs ?? DEFAULT_TIMEOUT_GRACE_MS;
    this.notify = deps.notify ?? NOOP_NOTIFIER;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.metrics = deps.metrics ?? NOOP_METRICS;
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
      // Bind BEFORE the readiness wait: from here on a session exists
      // upstream, and a project that fails the wait must still carry the id
      // so archiving can stop it (otherwise the container leaks — the seam
      // is the authority on session state, but only we know the id).
      this.store.setProjectSession(projectId, {
        sessionId,
        templateId: agent.sessionTemplateId,
        lastKnownState: 'provisioning',
      });
      // A provisioned session is not yet a runnable one (B3-08): ask the
      // runtime, not the seam, whether it can actually take a turn.
      await this.adapter.awaitReady(sessionId);
      this.store.setProjectSession(projectId, { lastKnownState: 'ready' });
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

  /**
   * Restore an archived project (FR-43) — the inverse of archiving: restart
   * the session archiving stopped. The workspace is a host directory, so it
   * survived, and the CLI transcripts under it with it: the next turn
   * `--resume`s where it left off (FR-24).
   *
   * Unlike `archiveProject`, a seam failure is NOT swallowed. Archiving can
   * shrug at a session it cannot stop — the intent is satisfied either way.
   * Restoring cannot: a project marked `ready` whose session never came back
   * would fail its next turn instead of here, where the user can see why. A
   * `SessionGoneError` (FR-44) propagates for the API to map to
   * `409 session_gone`, and the project stays archived.
   */
  async restoreProject(projectId: string): Promise<Project> {
    const project = this.store.getProject(projectId);
    if (!project) throw new OrchestratorError('not_found', `project ${projectId}`);
    if (project.status !== 'archived') return project; // idempotent
    const sessionId = project.sessionBinding.sessionId;
    if (!sessionId) {
      throw new OrchestratorError(
        'session_gone',
        `project ${projectId} has no session to restore (FR-44)`,
      );
    }
    // Translate the port's error into the orchestrator's own vocabulary: the
    // API depends on the orchestrator, not on the substrate (07 §2), so it
    // must not have to know SessionGoneError. A seam/transport failure is
    // deliberately NOT translated — it propagates as-is (500), because it is
    // transient and retryable, unlike a session that is gone for good.
    try {
      await this.execPort.startSession(sessionId);
    } catch (err) {
      if (err instanceof SessionGoneError) {
        throw new OrchestratorError('session_gone', err.message);
      }
      throw err;
    }
    this.store.setProjectSession(projectId, { lastKnownState: 'ready' });
    const updated = this.store.updateProject(projectId, { status: 'ready' });
    this.notify.projectState(projectId, 'ready');
    this.logger.info('project.restored', { projectId, sessionId });
    return updated;
  }

  /**
   * Restore an archived conversation (FR-43). Trivial next to a project's:
   * conversations own no session, they share the project's — which is
   * exactly why I-12 must be enforced here. An active conversation in an
   * archived project could not take a turn (the shared session is stopped),
   * so restoring it while the project is archived is rejected rather than
   * silently producing that dead state.
   */
  restoreConversation(conversationId: string): Conversation {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new OrchestratorError('not_found', `conversation ${conversationId}`);
    if (conversation.status !== 'archived') return conversation; // idempotent
    const project = this.store.getProject(conversation.projectId);
    if (project?.status === 'archived') {
      throw new OrchestratorError(
        'project_archived',
        `restore project ${conversation.projectId} first — its session is stopped (I-12)`,
      );
    }
    return this.store.updateConversation(conversationId, { status: 'active' });
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
        const pending = this.adapter.kill(
          project.sessionBinding.sessionId!,
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
    // projects caught mid-provisioning by the crash heal to `error` (B3-02):
    // the provision promise died with the process and nothing else can
    // resolve them; UC-01's failure path already defines the way forward
    // (retry recreates the session, FR-33/25)
    for (const project of this.store.listProjects()) {
      if (project.status === 'provisioning') {
        this.store.updateProject(project.id, { status: 'error' });
        this.notify.projectState(project.id, 'error');
      }
    }
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
              this.store.setRuntimeSessionId(conversation.id, item.runtimeSessionId);
            }
            break;
          case 'event':
            ingest(item.type, item.payload);
            break;
          case 'usage':
            // lagging budget estimate (ADR-003, R-06): accumulate per-message
            // token cost; crossing the cap trips a kill → budget_exceeded
            estimatedCostUsd += estimateCostUsd(item, this.tokenPrices);
            if (
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
        const lastKnownState = project.sessionBinding.lastKnownState ?? 'unknown';
        this.finalize(current, current.state, 'failed', {
          usageSource: 'error-partial',
          errorCode: refused ? 'exec_refused' : 'seam_unavailable',
          errorDetail: refused
            ? `seam ${status}: ${raw} — session lastKnownState=${lastKnownState} (FR-33)`
            : raw,
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
    const agent = this.agents.get(agentId);
    if (!agent) throw new OrchestratorError('unknown_agent', `agent ${agentId} not configured`);
    return agent;
  }
}
