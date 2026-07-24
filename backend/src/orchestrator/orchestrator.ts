/**
 * Orchestrator facade (07 §2, B1-04; decomposed per ADR-013): constructs the
 * four collaborators, wires their cross-callbacks, and delegates its public
 * surface — the `api` module sees one unchanged class. The zones:
 *
 * - `ProvisioningService` — project/specialist-session lifecycle (UC-01).
 * - `SessionResolver` — WHERE a run executes: routing, selector, the
 *   ADR-014/015 envelope signals. Decides, never acts.
 * - `RunLoop` — dispatch → execute → terminal; sole owner of `finalize`
 *   (09 §3, one transaction); cancellation (UC-04); run reconcile + queue
 *   rebuild (UC-06).
 * - `TaskCoordinator` — the Supervisor wrapper, envelopes, approval, task
 *   healing (ADR-009/014).
 *
 * The facade itself keeps only send/conversation creation, the boot
 * reconcile sequencing, and `resolveTarget` — the one place resolver signals
 * are routed to the coordinator and sealed through the run loop.
 */

import {
  type TokenPrices,
} from '../config/budget.js';
import type { Clock } from '../domain/ids.js';
import {
  NOOP_LOGGER,
  NOOP_METRICS,
  NOOP_NOTIFIER,
  type HubNotifier,
  type Logger,
  type Metrics,
  type ReportExtractorPort,
  type RouterPort,
  type RuntimeAdapter,
  type SubstrateExecPort,
  type WorkspaceManagerPort,
} from '../domain/ports.js';
import { mustAgent, OrchestratorError } from './errors.js';
import { ProvisioningService } from './provisioningService.js';
import { SessionResolver } from './sessionResolver.js';
import { RunLoop } from './runLoop.js';
import { DeterministicRouter } from './router.js';
import { DeterministicReportExtractor } from './reportExtractor.js';
import { FakeWorkspaceManager } from './workspaceManager.js';
import { TaskCoordinator } from './taskCoordinator.js';
import {
  deriveConversationTitle,
  DEFAULT_CONVERSATION_TITLE,
} from '../domain/projections.js';
import { workspaceKeyFor } from '../domain/types.js';
import type {
  Agent,
  Conversation,
  ConversationMode,
  Message,
  Project,
  Run,
  SpecialistSessionBinding,
  Task,
} from '../domain/types.js';
import type { HubStore } from '../store/types.js';

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


export class Orchestrator {
  private readonly store: HubStore;
  private readonly adapter: RuntimeAdapter;
  private readonly execPort: SubstrateExecPort;
  private readonly agents: ReadonlyMap<string, Agent>;
  private readonly notify: HubNotifier;
  private readonly logger: Logger;


  /** The dispatch → execute → terminal engine (ADR-013): sole owner of finalize. */
  private readonly runLoop: RunLoop;
  /** Everything task-shaped (ADR-013): the Supervisor wrapper, envelopes, approval, task healing. */
  private readonly tasks: TaskCoordinator;
  /** Decides WHERE a run executes (ADR-013): routing, selector, envelope signals. */
  private readonly resolver: SessionResolver;
  /** Project/specialist-session lifecycle (ADR-013): discovery, provisioning, bind, archive/restore. */
  private readonly provisioning: ProvisioningService;
  private readonly qaSpecialistId: string | null;

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store;
    this.adapter = deps.adapter;
    this.execPort = deps.execPort;
    this.agents = deps.agents;
    this.notify = deps.notify ?? NOOP_NOTIFIER;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.qaSpecialistId = deps.qaSpecialistId ?? null;
    this.tasks = new TaskCoordinator({
      store: this.store,
      agents: this.agents,
      workspaceManager: deps.workspaceManager ?? new FakeWorkspaceManager(),
      extractor: deps.reportExtractor ?? new DeterministicReportExtractor(),
      qaSpecialistId: this.qaSpecialistId,
      ...(deps.maxQaCycles !== undefined ? { maxQaCycles: deps.maxQaCycles } : {}),
      // the run machinery, injected (ADR-013): dispatch and the terminal choke point
      pump: (key) => this.runLoop.pump(key),
      finalize: (run, from, to, opts) => this.runLoop.finalize(run, from, to, opts),
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
    this.resolver = new SessionResolver({
      store: this.store,
      execPort: this.execPort,
      agents: this.agents,
      router: deps.router ?? new DeterministicRouter(),
      qaSpecialistId: this.qaSpecialistId,
      logger: this.logger,
    });
    this.runLoop = new RunLoop({
      store: this.store,
      adapter: this.adapter,
      execPort: this.execPort,
      // the cross-collaborator wiring (ADR-013): the resolver decides, the
      // facade routes, the run loop executes and seals
      resolveTarget: (run, conversation, content) => this.resolveTarget(run, conversation, content),
      sessionMeta: (c) => this.resolver.sessionMetaForConversation(c),
      onRunTerminal: (runId) => this.tasks.wakeRunTerminal(runId),
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      ...(deps.runEnv !== undefined ? { runEnv: deps.runEnv } : {}),
      ...(deps.tokenPrices !== undefined ? { tokenPrices: deps.tokenPrices } : {}),
      ...(deps.timeoutGraceMs !== undefined ? { timeoutGraceMs: deps.timeoutGraceMs } : {}),
      notify: this.notify,
      logger: this.logger,
      metrics: deps.metrics ?? NOOP_METRICS,
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
    this.runLoop.pump(workspaceKey);
  }

  /** Awaits every in-flight run, task-supervision and provisioning — deterministic tests, clean shutdown. */
  async idle(): Promise<void> {
    while (
      this.runLoop.pending().length > 0 ||
      this.tasks.driving().length > 0 ||
      this.provisioning.pending().length > 0
    ) {
      await Promise.all([
        ...this.runLoop.pending(),
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



  // — UC-04: cancellation — delegated to the RunLoop (ADR-013) —

  cancelRun(runId: string): Promise<void> {
    return this.runLoop.cancelRun(runId);
  }

  // — UC-06: boot reconciliation (two transactions per run) —

  async reconcile(): Promise<void> {
    // projects caught mid-provisioning by the crash (B3-02) — the
    // ProvisioningService owns the healing
    this.provisioning.reconcileProvisioning();
    // the run half, two transactions per run — the RunLoop owns it
    await this.runLoop.reconcileRuns();
    // in-flight tasks whose supervise() loop died with the crash (ADR-009
    // "Boot reconciliation of tasks") — the TaskCoordinator owns the healing
    await this.tasks.reconcileTasks();

    // queue rebuild (RunLoop.pump per workspace)
    this.runLoop.rebuildQueues();
  }

  // — the run loop —

  /**
   * Resolve where this run executes (SessionResolver, ADR-013) and route the
   * signal: a session executes a turn; a fail seals the run as exec_refused
   * (the resolver's own vocabulary); the task-shaped signals (ADR-014) go to
   * the TaskCoordinator and the run becomes a light envelope. Returns null
   * when the run was finalized here (no turn to execute).
   */
  private async resolveTarget(
    run: Run,
    conversation: Conversation,
    userMessageContent: string,
  ): Promise<string | null> {
    const target = await this.resolver.resolve(run, conversation, userMessageContent);
    switch (target.kind) {
      case 'session':
        return target.sessionId;
      case 'fail':
        this.runLoop.finalize(run, 'starting', 'failed', {
          usageSource: 'error-partial',
          errorCode: 'exec_refused',
          errorDetail: target.detail,
          userMessageContent,
          warnings: [],
          runtimeSessionId: conversation.runtimeSessionId,
        });
        return null;
      case 'steer-task':
        this.tasks.steerTask(run, conversation, target.task, userMessageContent);
        return null; // the steer run executes no turn
      case 'start-task': {
        const task = this.tasks.startTask({
          projectId: conversation.projectId!,
          sourceConversationId: conversation.id,
          sourceMessageId: run.messageId,
          objective: userMessageContent,
          devSpecialistId: target.devSpecialistId,
          qaSpecialistId: target.qaSpecialistId,
        });
        this.tasks.finalizeTaskKickoff(run, conversation, userMessageContent, task);
        return null; // the kickoff run executes no turn
      }
    }
  }


  private mustAgent(agentId: string): Agent {
    return mustAgent(this.agents, agentId);
  }
}
