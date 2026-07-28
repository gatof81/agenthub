/**
 * TaskCoordinator (ADR-013): everything task-shaped, extracted from the
 * Orchestrator facade. Wraps the N5b Supervisor and owns the task plumbing
 * around it — kickoff/steer envelopes (ADR-014), human approval (N6), the
 * StepRunner that turns one specialist step into a run, and boot healing of
 * in-flight tasks. Owns `runCompletions` (step awaiters the run loop's
 * `finalize` wakes through `wakeRunTerminal`) and `taskDriving` (in-flight
 * `supervise()` loops, so `idle()` settles whole tasks).
 *
 * The run machinery stays outside: `pump` (dispatch) and `finalize` (the 09 §3
 * terminal choke point) are injected — the coordinator never seals a run
 * except through them (ADR-013's one shared seam).
 */

import {
  NOOP_LOGGER,
  NOOP_NOTIFIER,
  type HubNotifier,
  type Logger,
  type PullRequestContent,
  type ReportExtractorPort,
  type WorkspaceManagerPort,
} from '../domain/ports.js';
import { isTerminal } from '../domain/runStateMachine.js';
import { isTerminalTask } from '../domain/taskStateMachine.js';
import { assembleAssistantText } from '../domain/projections.js';
import { workspaceKeyFor } from '../domain/types.js';
import type {
  Agent,
  Conversation,
  ImplementationReport,
  QaReport,
  Run,
  Task,
  TaskState,
  TerminalRunState,
  UsageSource,
} from '../domain/types.js';
import type { HubStore } from '../store/types.js';
import { OrchestratorError } from './errors.js';
import { Supervisor, type StepResult } from './supervisor.js';
import { workspaceFromSteps } from './workspaceManager.js';

/**
 * The terminal choke point (09 §3), injected: `finalize` is owned by the run
 * loop (ADR-013 — the single most important seam), and the coordinator only
 * seals light envelope runs through it. The options are the envelope subset of
 * the run loop's full finalize options.
 */
export type FinalizeRun = (
  run: Run,
  from: Run['state'],
  to: TerminalRunState,
  opts: {
    usageSource: UsageSource;
    assistantContent: string;
    userMessageContent: string;
    warnings: string[];
    runtimeSessionId: string | null;
  },
) => void;

export interface TaskCoordinatorDeps {
  store: HubStore;
  agents: ReadonlyMap<string, Agent>;
  workspaceManager: WorkspaceManagerPort;
  /** Turns a specialist step's output into a typed work product (N5b, ADR-009). */
  extractor: ReportExtractorPort;
  /** The task envelope's QA reviewer; the coordinator never seats it as the developer. */
  qaSpecialistId: string | null;
  /** Bound on the dev↔QA cycle before a task fails (N5b); supervisor default otherwise. */
  maxQaCycles?: number;
  /** Dispatch the workspace queue — the run loop's `pump`, injected (ADR-013). */
  pump: (workspaceKey: string) => void;
  /** Seal a run — the run loop's `finalize`, injected (ADR-013). */
  finalize: FinalizeRun;
  /** Kill a live run — the run loop's `cancelRun`, injected (#140 task cancel). */
  cancelRun: (runId: string) => Promise<void>;
  notify?: HubNotifier;
  logger?: Logger;
}

export class TaskCoordinator {
  private readonly store: HubStore;
  private readonly agents: ReadonlyMap<string, Agent>;
  private readonly workspaceManager: WorkspaceManagerPort;
  private readonly qaSpecialistId: string | null;
  private readonly pump: (workspaceKey: string) => void;
  private readonly finalize: FinalizeRun;
  private readonly cancelRun: (runId: string) => Promise<void>;
  private readonly notify: HubNotifier;
  private readonly logger: Logger;

  /**
   * The N5b task supervisor and the plumbing it needs: `runCompletions` wakes a
   * step run's awaiter when the run loop's `finalize` seals it (through
   * `wakeRunTerminal`), and `taskDriving` holds each in-flight `supervise()` so
   * `idle()` settles a whole task, not just its runs.
   */
  private readonly supervisor: Supervisor;
  private readonly runCompletions = new Map<string, () => void>();
  private readonly taskDriving = new Set<Promise<void>>();
  /**
   * Owner cancel requests (#140), drained by the supervisor at step
   * boundaries. In-memory on purpose: a restart kills the loop anyway and
   * boot reconciliation lands the task in `failed` with its own note — a
   * persisted request would have nothing left to cancel.
   */
  private readonly cancelRequests = new Set<string>();

  constructor(deps: TaskCoordinatorDeps) {
    this.store = deps.store;
    this.agents = deps.agents;
    this.workspaceManager = deps.workspaceManager;
    this.qaSpecialistId = deps.qaSpecialistId;
    this.pump = deps.pump;
    this.finalize = deps.finalize;
    this.cancelRun = deps.cancelRun;
    this.notify = deps.notify ?? NOOP_NOTIFIER;
    this.logger = deps.logger ?? NOOP_LOGGER;
    // The design-consult specialist (ADR-015): the first agent by stable id
    // order whose DECLARED capabilities include architecture/design — the
    // opposite default from the implementation gate: a consult is claimed by
    // declaring the craft, never assigned to an unconstrained agent. QA is
    // never the consultant. None configured → consults are a logged no-op.
    const designCapable = [...this.agents.values()]
      .filter(
        (a) =>
          a.id !== this.qaSpecialistId &&
          (a.capabilities?.includes('architecture') === true ||
            a.capabilities?.includes('design') === true),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    this.supervisor = new Supervisor({
      store: this.store,
      // the step machinery is the run loop itself, wrapped behind the seam the
      // supervisor is unit-tested against (N5b)
      runner: { runStep: (i) => this.runTaskStep(i) },
      extractor: deps.extractor,
      workspace: this.workspaceManager,
      logger: this.logger,
      ...(deps.maxQaCycles !== undefined ? { maxQaCycles: deps.maxQaCycles } : {}),
      designSpecialistId: designCapable[0]?.id ?? null,
      isCancelled: (taskId) => this.cancelRequests.has(taskId),
    });
  }

  /** The in-flight `supervise()` loops, for the facade's `idle()` (deterministic tests, clean shutdown). */
  driving(): Promise<void>[] {
    return [...this.taskDriving];
  }

  /**
   * Wake a task-step awaiter (N5b): the supervisor blocks on its step run's
   * terminal state, and the run loop's `finalize` — the one choke point every
   * outcome flows through — calls this for every sealed run.
   */
  wakeRunTerminal(runId: string): void {
    const wake = this.runCompletions.get(runId);
    if (wake) {
      this.runCompletions.delete(runId);
      wake();
    }
  }

  // — N5b (ADR-009): task supervision (developer → QA → human approval) —

  /**
   * Start a task from a routed `task` message: create the Task row and drive it
   * through the dev → QA loop to `awaiting_human_approval` (or `failed`) on the
   * project's primary session. The supervisor owns every step run; this returns
   * as soon as the task exists, the loop running in the background (tracked so
   * `idle()` settles the whole task, not just its runs). Step runs are hosted by
   * the originating conversation.
   */
  startTask(input: {
    projectId: string;
    sourceConversationId: string;
    sourceMessageId: string;
    objective: string;
    devSpecialistId: string;
    qaSpecialistId: string;
  }): Task {
    const task = this.store.createTask({
      projectId: input.projectId,
      sourceConversationId: input.sourceConversationId,
      sourceMessageId: input.sourceMessageId,
    });
    const driving = this.supervisor
      .supervise(task, input.objective, input.devSpecialistId, input.qaSpecialistId)
      // two-argument then: the rejection handler is EXCLUSIVELY supervise()'s
      // bug guard — an announce failure surfaces as task.announce_failed (its
      // own catch), never misattributed as a supervise crash
      .then(
        () => this.announceTaskOutcome(task.id),
        (err: unknown) => {
          // supervise() lands flow outcomes in `failed` itself; a throw here is a
          // bug guard so a background rejection is never swallowed silently
          this.logger.error('task.supervise_crashed', {
            taskId: task.id,
            error: err instanceof Error ? err.name : 'unknown',
          });
        },
      )
      .finally(() => {
        this.taskDriving.delete(driving);
        this.cancelRequests.delete(task.id); // the loop is gone; nothing left to cancel
      });
    this.taskDriving.add(driving);
    return task;
  }

  // — N6 (ADR-009): human approval of a task awaiting_human_approval —

  /**
   * The owner approves the work: terminal success. The project session pushes
   * the task branch and opens a PR (N6b, ADR-010) — best-effort, so a PR failure
   * never un-approves the task — then the worktree is cleaned up (its branch, on
   * the remote via the push, survives).
   */
  async approveTask(taskId: string): Promise<Task> {
    const task = this.approvableTask(taskId);
    const workspace = workspaceFromSteps(this.store.listTaskSteps(taskId));
    this.store.transitionTask(taskId, 'awaiting_human_approval', 'approved');
    const pr = await this.workspaceManager.openPullRequest(task, workspace, this.prContent(task));
    if (pr.url) this.store.setTaskPullRequestUrl(taskId, pr.url);
    await this.workspaceManager.cleanup(task, workspace);
    return this.store.getTask(taskId)!;
  }

  /**
   * The owner cancels a RUNNING task (#140): a cooperative request the
   * supervisor drains at the next step boundary, made prompt by killing the
   * live step run (best-effort — the boundary check still lands it if the
   * run settled first). Async by nature, like a run cancel: the response may
   * still show a transient state; the `cancelled` transition follows at the
   * boundary. Not for `awaiting_human_approval` (reject/request-changes are
   * the verbs there) nor terminal states — 409 `task_not_cancellable`.
   */
  async cancelTask(taskId: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new OrchestratorError('not_found', `task ${taskId}`);
    if (isTerminalTask(task.state) || task.state === 'awaiting_human_approval') {
      throw new OrchestratorError(
        'task_not_cancellable',
        task.state === 'awaiting_human_approval'
          ? 'task is awaiting your verdict — reject or request changes instead'
          : `task is already ${task.state}`,
      );
    }
    this.cancelRequests.add(taskId);
    const liveStepRun = this.store
      .listRunsByState(['starting', 'streaming'])
      .find(
        (r) => r.taskStepId !== null && this.store.getTaskStep(r.taskStepId)?.taskId === taskId,
      );
    if (liveStepRun) {
      try {
        await this.cancelRun(liveStepRun.id);
      } catch (err) {
        // the run settled between listing and killing — the boundary check
        // still lands the cancel; nothing to surface
        this.logger.info('task.cancel_run_race', {
          taskId,
          runId: liveStepRun.id,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
    this.logger.info('task.cancel_requested', { taskId, taskState: task.state });
    return this.store.getTask(taskId)!;
  }

  /** The owner rejects the work: terminal. The worktree is cleaned up; the branch survives. */
  async rejectTask(taskId: string): Promise<Task> {
    const task = this.approvableTask(taskId);
    await this.workspaceManager.cleanup(task, workspaceFromSteps(this.store.listTaskSteps(taskId)));
    return this.store.transitionTask(taskId, 'awaiting_human_approval', 'rejected');
  }

  /** Title + body for the approval PR (N6b): the objective, plus the reports' gist. */
  private prContent(task: Task): PullRequestContent {
    const objective = this.taskObjective(task);
    const products = this.store.listWorkProducts(task.id);
    const impl = products.find((w) => w.kind === 'implementation_report')?.body as
      | ImplementationReport
      | undefined;
    const qa = products.findLast((w) => w.kind === 'qa_report')?.body as QaReport | undefined;
    const title = `[Agent Hub] ${(objective.split('\n')[0] ?? '').slice(0, 72) || `task ${task.id}`}`;
    const body = [
      objective ? `## Objective\n\n${objective}` : '',
      impl?.summary ? `## Implementation\n\n${impl.summary}` : '',
      impl?.filesChanged.length ? `Files changed: ${impl.filesChanged.join(', ')}` : '',
      qa ? `## QA\n\nVerdict: **${qa.verdict}**` : '',
      `_Opened by Agent Hub after QA passed and owner approval (task ${task.id})._`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return { title, body };
  }

  /**
   * The owner requests changes (N6): the task re-enters the developer → QA loop
   * with `note` as the first developer prompt's feedback, back to
   * `awaiting_human_approval` (or `failed`). Returns once the task has moved to
   * `changes_requested_by_user`; the loop runs in the background (tracked so
   * `idle()` settles it). Reuses the existing worktree — the work continues on
   * the same branch.
   */
  requestTaskChanges(taskId: string, note: string): Task {
    const task = this.approvableTask(taskId);
    const objective = this.taskObjective(task);
    const { devSpecialistId, qaSpecialistId } = this.taskSpecialists(taskId);
    const updated = this.store.transitionTask(
      taskId,
      'awaiting_human_approval',
      'changes_requested_by_user',
    );
    const driving = this.supervisor
      .supervise(updated, objective, devSpecialistId, qaSpecialistId, { feedback: note })
      // two-argument then — same reasoning as startTask's chain
      .then(
        () => this.announceTaskOutcome(taskId),
        (err: unknown) => {
          this.logger.error('task.resume_crashed', {
            taskId,
            error: err instanceof Error ? err.name : 'unknown',
          });
        },
      )
      .finally(() => {
        this.taskDriving.delete(driving);
        this.cancelRequests.delete(taskId); // the loop is gone; nothing left to cancel
      });
    this.taskDriving.add(driving);
    return updated;
  }

  private approvableTask(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task) throw new OrchestratorError('not_found', `task ${taskId}`);
    if (task.state !== 'awaiting_human_approval') {
      throw new OrchestratorError(
        'task_not_approvable',
        `task is ${task.state}, not awaiting_human_approval`,
      );
    }
    return task;
  }

  /** The task brief, recovered from its source message (the resume prompt's base). */
  private taskObjective(task: Task): string {
    if (task.sourceMessageId) {
      const msg = this.store.getMessage(task.sourceMessageId);
      if (msg) return msg.content;
    }
    return ''; // source message pruned — the loop still runs on the note alone
  }

  /** The developer/QA specialists that ran this task, recovered from its steps. */
  private taskSpecialists(taskId: string): { devSpecialistId: string; qaSpecialistId: string } {
    const steps = this.store.listTaskSteps(taskId);
    const dev = steps.find((s) => s.kind === 'implementation')?.specialistId;
    const qa = steps.find((s) => s.kind === 'qa')?.specialistId ?? this.qaSpecialistId;
    return { devSpecialistId: dev ?? '', qaSpecialistId: qa ?? '' };
  }

  /**
   * Run one specialist turn as a task step (the N5b StepRunner impl): create a
   * step run in the task's conversation carrying the specialist's snapshot and
   * the step link, pump it, await its terminal state, and report what it said
   * plus whether it failed. A step run skips routing (see the run loop's
   * `resolveRunSession`).
   */
  private async runTaskStep(input: {
    taskId: string;
    taskStepId: string;
    specialistId: string;
    prompt: string;
  }): Promise<StepResult> {
    const failed = (): StepResult => ({ assistantOutput: '', summary: null, runId: null, failed: true });
    const conversationId = this.store.getTask(input.taskId)?.sourceConversationId ?? null;
    if (!conversationId) return failed();
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) return failed();
    const agent = this.agents.get(input.specialistId);
    if (!agent) {
      this.logger.warn('task.step_unknown_specialist', {
        taskId: input.taskId,
        specialistId: input.specialistId,
      });
      return failed();
    }
    const { run } = this.store.sendMessage({
      conversationId,
      content: input.prompt,
      caps: agent.defaultCaps,
      policy: agent.allowedTools,
      instructions: agent.instructions,
      taskStepId: input.taskStepId,
    });
    // register the awaiter BEFORE dispatch so a fast finalize is never missed
    const done = this.awaitRunTerminal(run.id);
    this.pump(workspaceKeyFor(conversation));
    await done;
    const final = this.store.getRun(run.id);
    return {
      assistantOutput: assembleAssistantText(this.store.getEvents(run.id)) || '',
      summary: this.store.getSummary(run.id) ?? null,
      runId: run.id,
      failed: !final || (final.state !== 'completed' && final.state !== 'completed_with_denials'),
    };
  }

  /** Resolve when `runId` reaches a terminal state (woken by `wakeRunTerminal`), or now if already there. */
  private awaitRunTerminal(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run || isTerminal(run.state)) return Promise.resolve();
    return new Promise<void>((resolve) => this.runCompletions.set(runId, resolve));
  }

  // — the envelope runs (N5b kickoff, ADR-014 steer) —

  /**
   * Seal the light kickoff run for a task (N5b envelope): it runs no turn, so it
   * goes starting → streaming → completed carrying a short note that a task was
   * started. The developer/QA work happens in separate step runs the supervisor
   * owns — the kickoff never touches the substrate.
   */
  finalizeTaskKickoff(
    run: Run,
    conversation: Conversation,
    userMessageContent: string,
    task: Task,
  ): void {
    this.finalizeEnvelopeRun(
      run,
      conversation,
      userMessageContent,
      `Started task ${task.id}. Routing to the developer, then QA; you'll be asked to approve the result.`,
    );
  }

  /**
   * Steer the conversation's active task with a work-shaped message (ADR-014):
   * from `awaiting_human_approval` the message is the owner's change request —
   * re-enter the loop through the existing N6 path; from any other live state
   * it queues as pending feedback, drained into the next developer prompt (a
   * running step is one CLI turn and is never interrupted — cancel is the
   * explicit interrupt).
   */
  steerTask(run: Run, conversation: Conversation, task: Task, note: string): void {
    if (task.state === 'awaiting_human_approval') {
      this.requestTaskChanges(task.id, note);
      this.finalizeEnvelopeRun(
        run,
        conversation,
        note,
        `Changes requested on task ${task.id} — re-entering the developer → QA loop.`,
      );
    } else {
      this.store.appendTaskFeedback(task.id, note);
      this.finalizeEnvelopeRun(
        run,
        conversation,
        note,
        `Noted — task ${task.id} is running; your message will be folded into its next developer step.`,
      );
    }
    this.logger.info('task.steered', { taskId: task.id, runId: run.id, taskState: task.state });
  }

  /**
   * Seal a message that meant to steer a task which ended before dispatch
   * (#150): nothing is applied and nothing new spawns — the note says so and
   * the owner resends if they still want it as fresh work.
   */
  sealStaleSteer(run: Run, conversation: Conversation, task: Task, note: string): void {
    this.finalizeEnvelopeRun(
      run,
      conversation,
      note,
      `Task ${task.id} ended (${task.state}) before this message was processed — nothing was applied. Send it again if you still want it as new work.`,
    );
    this.logger.info('task.stale_steer', { taskId: task.id, runId: run.id, taskState: task.state });
  }

  /** Seal a light envelope run (kickoff or steer): no substrate turn, a short note as the answer. */
  private finalizeEnvelopeRun(
    run: Run,
    conversation: Conversation,
    userMessageContent: string,
    note: string,
  ): void {
    this.store.transitionRun(run.id, 'starting', 'streaming');
    this.notify.runState(conversation.id, { runId: run.id, state: 'streaming' });
    this.finalize(run, 'streaming', 'completed', {
      usageSource: 'result-event',
      assistantContent: note,
      userMessageContent,
      warnings: [],
      runtimeSessionId: conversation.runtimeSessionId,
    });
  }

  /**
   * Tell the owner how the task ended, in the conversation itself (the same
   * channel the kickoff spoke through): a task waiting on approval or one
   * that failed should not be discoverable only by opening the task view.
   * The note is a standalone assistant message (no run); re-announcing the
   * kickoff run's terminal state nudges connected clients to refetch — a
   * repeated state frame is an idempotent projection (NFR-07), not a new
   * transition. Best-effort: an announce failure never fails the task flow.
   */
  private announceTaskOutcome(taskId: string): void {
    try {
      const task = this.store.getTask(taskId);
      if (!task || task.sourceConversationId === null) return;
      const note =
        task.state === 'awaiting_human_approval'
          ? `Task ${task.id} passed QA and is awaiting your review — approve, reject, or request changes from the task view.`
          : task.state === 'failed'
            ? `Task ${task.id} failed — open the task view for the step-by-step trail.`
            : task.state === 'cancelled'
              ? `Task ${task.id} was cancelled — its branch survives for inspection.`
              : null;
      if (note === null) return; // nothing announceable (e.g. already human-terminal)
      this.store.appendAssistantMessage(task.sourceConversationId, note);
      const kickoffRun = task.sourceMessageId
        ? this.store.getRunByMessage(task.sourceMessageId)
        : undefined;
      if (kickoffRun) {
        this.notify.runState(task.sourceConversationId, {
          runId: kickoffRun.id,
          state: kickoffRun.state,
        });
      }
      this.logger.info('task.outcome_announced', { taskId: task.id, taskState: task.state });
    } catch (err) {
      this.logger.warn('task.announce_failed', {
        taskId,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  // — UC-06: boot reconciliation of tasks —

  /**
   * Heal in-flight tasks whose supervise() loop died with the crash: their step
   * runs are healed by the run reconciler, but the Task row would otherwise stay
   * non-terminal FOREVER (ADR-009 "Boot reconciliation of tasks"; UC-06 covers
   * runs) — the source kickoff already told the user to expect an approval, so
   * nothing would ever advance it. Heal every TRANSIENT state to `failed` and
   * clean up the worktree (best-effort — the session may be down). RESTING
   * states (awaiting_human_approval, waiting on the owner) are not crash
   * artifacts and are left alone. A new non-terminal state must be classified
   * here (ADR-009).
   */
  async reconcileTasks(): Promise<void> {
    const CRASH_HEALABLE_TASK_STATES: TaskState[] = [
      'planning',
      'implementing',
      'qa_pending',
      'qa_running',
      'changes_requested_by_qa',
      'changes_requested_by_user',
    ];
    for (const task of this.store.listTasksByState(CRASH_HEALABLE_TASK_STATES)) {
      const steps = this.store.listTaskSteps(task.id);
      if (steps.length > 0) {
        try {
          await this.workspaceManager.cleanup(task, workspaceFromSteps(steps));
        } catch (err) {
          this.logger.warn('task.reconcile_cleanup_failed', {
            taskId: task.id,
            error: err instanceof Error ? err.name : 'unknown',
          });
        }
      }
      this.store.transitionTask(task.id, task.state, 'failed');
      this.logger.warn('task.reconciled_failed', { taskId: task.id, from: task.state });
      // The restart killed the loop mid-flight — say so where the owner reads.
      // Deliberately NOT announceTaskOutcome: reconciliation runs before the
      // server accepts connections, so there is no client to nudge — the
      // run-state re-emit would be a per-restart no-op frame (ADR-009
      // "Outcome announcement").
      try {
        if (task.sourceConversationId !== null) {
          this.store.appendAssistantMessage(
            task.sourceConversationId,
            `Task ${task.id} was interrupted by a Hub restart and marked failed — send the request again when ready.`,
          );
        }
      } catch (err) {
        this.logger.warn('task.announce_failed', {
          taskId: task.id,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
  }
}
