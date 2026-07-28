/**
 * The N5b supervisor (ADR-009): drives one Task through the developer → QA loop
 * to `awaiting_human_approval`. It is deliberately ONE hardcoded flow, not a
 * workflow engine (18 §6). The model never decides authority here — a QA
 * `verdict` only routes the loop, which this deterministic coordinator enforces,
 * and human approval (N6) is a separate terminal step.
 *
 * Testable offline: the turn machinery is behind `StepRunner`, so the loop
 * logic (transitions, report production, the changes-required cycle, the
 * bounded retries) is unit-tested with a fake runner and a fake extractor — no
 * substrate, no model.
 */

import type { ReportExtractorPort, WorkspaceManagerPort } from '../domain/ports.js';
import { NOOP_LOGGER, type Logger } from '../domain/ports.js';
import type {
  DelegatedWorkspaceAccess,
  DesignBrief,
  ImplementationReport,
  RunSummary,
  Task,
  TaskStep,
  TaskWorkspace,
  WorkspaceAccessMode,
} from '../domain/types.js';
import { isTerminalTask } from '../domain/taskStateMachine.js';
import type { HubStore } from '../store/types.js';
import { workspaceFromSteps } from './workspaceManager.js';

/** One specialist turn, executed as a task step, run to a terminal state. */
export interface StepResult {
  /** the run's final assistant text (what the specialist said it did) */
  assistantOutput: string;
  summary: RunSummary | null;
  /** the run id, for work-product provenance */
  runId: string | null;
  /** true when the run ended non-`completed` (failed/cancelled/etc.) */
  failed: boolean;
}

/** Runs one specialist turn as a task step (the real one wraps the run loop). */
export interface StepRunner {
  runStep(input: {
    taskId: string;
    taskStepId: string;
    specialistId: string;
    prompt: string;
  }): Promise<StepResult>;
}

/** Bound the dev↔QA cycle so a never-satisfied QA cannot loop forever. */
const MAX_QA_CYCLES = 3;

export interface SupervisorDeps {
  store: HubStore;
  runner: StepRunner;
  extractor: ReportExtractorPort;
  /** Isolates each task in a git worktree (ADR-010 B, N5b-2). */
  workspace: WorkspaceManagerPort;
  logger?: Logger;
  maxQaCycles?: number;
  /**
   * The architecture-capable specialist for on-demand design consults
   * (ADR-015); null/absent = consults are a logged no-op — never a gate.
   */
  designSpecialistId?: string | null;
  /**
   * Owner-cancel probe (#140): the loop drains cancel REQUESTS cooperatively
   * at step boundaries (the coordinator owns the request set and also kills
   * the live step run, so a mid-turn cancel is prompt). Absent = never
   * cancelled.
   */
  isCancelled?: (taskId: string) => boolean;
}

/** The implementer's design request (ADR-015): a deterministic marker, like QA's CHANGES_REQUIRED. */
const NEEDS_DESIGN = /NEEDS_DESIGN:?\s*([^\n]*)/;

export class Supervisor {
  private readonly store: HubStore;
  private readonly runner: StepRunner;
  private readonly extractor: ReportExtractorPort;
  private readonly workspace: WorkspaceManagerPort;
  private readonly logger: Logger;
  private readonly maxCycles: number;
  private readonly designSpecialistId: string | null;
  private readonly isCancelled: (taskId: string) => boolean;

  constructor(deps: SupervisorDeps) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.extractor = deps.extractor;
    this.workspace = deps.workspace;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.maxCycles = deps.maxQaCycles ?? MAX_QA_CYCLES;
    this.designSpecialistId = deps.designSpecialistId ?? null;
    this.isCancelled = deps.isCancelled ?? (() => false);
  }

  /**
   * Drive `task` (in `planning`) through dev → QA to `awaiting_human_approval`,
   * or `failed`. `objective` is the task brief; the two specialists implement
   * and QA it. Never throws for a flow outcome — a failure lands the task in
   * `failed` and returns.
   *
   * `resume` (N6) re-enters the loop for owner-requested changes: the task is in
   * `changes_requested_by_user`, its worktree already exists (recovered, never
   * re-created), and the note is folded into the first developer prompt.
   */
  async supervise(
    task: Task,
    objective: string,
    devSpecialistId: string,
    qaSpecialistId: string,
    resume?: { feedback: string },
  ): Promise<void> {
    // seed the first developer turn: 'planning' fresh, or on a resume fold in
    // the owner's requested changes from `changes_requested_by_user`
    const fromState: Task['state'] = resume ? 'changes_requested_by_user' : task.state;
    const pendingFeedback: string | null = resume ? resume.feedback : null;

    // Isolate the task's code in a git worktree/branch owned by the project
    // session (ADR-010 B). All steps run inside it; it survives a `failed`
    // cleanup only as a branch (the commits), and survives an approval hand-off
    // whole (N6 makes the PR from it). On resume the worktree already exists —
    // recover its descriptor rather than creating it again. Acquired INSIDE the
    // try so a worktree-provisioning failure fails the task now, not only on the
    // next boot's reconcile (ADR-009 "Boot reconciliation of tasks") — `workspace`
    // stays null until it succeeds, so the catch knows there is nothing to clean up.
    let workspace: TaskWorkspace | null = null;
    try {
      workspace = resume
        ? workspaceFromSteps(this.store.listTaskSteps(task.id))
        : await this.workspace.createTaskWorkspace(task);
      await this.driveDevQaLoop({
        task,
        objective,
        devSpecialistId,
        qaSpecialistId,
        workspace,
        fromState,
        pendingFeedback,
      });
    } catch (err) {
      // An unexpected throw anywhere from workspace acquisition through the loop
      // — createTaskWorkspace, a store/extractor/commit or transition failure,
      // not a flow outcome that returns via failTask — would otherwise escape
      // supervise(). startTask's .catch only logs, so the task would stay
      // non-terminal forever and leak the worktree (ADR-009 "Boot reconciliation
      // of tasks"). Fail it from whatever state it is now in, cleaning up if a
      // worktree was created.
      await this.failFromCurrentState(task, workspace, err);
    }
  }

  /**
   * The dev → QA loop itself, extracted so supervise() wraps it in one
   * try/catch. `fromState`/`pendingFeedback` seed the first developer turn.
   */
  private async driveDevQaLoop(input: {
    task: Task;
    objective: string;
    devSpecialistId: string;
    qaSpecialistId: string;
    workspace: TaskWorkspace;
    fromState: Task['state'];
    pendingFeedback: string | null;
  }): Promise<void> {
    const { task, objective, devSpecialistId, qaSpecialistId, workspace } = input;
    let fromState = input.fromState;
    let pendingFeedback = input.pendingFeedback;
    let cycle = 0;
    // a QA-triggered design consult's brief, carried into the next cycle's
    // first developer prompt (ADR-015)
    let carryBrief: string | null = null;
    for (;;) {
      // owner cancel (#140), drained at the cycle boundary
      if (await this.cancelIfRequested(task, workspace, fromState)) return;
      // — implementation (with at most ONE design consult per cycle, ADR-015) —
      this.store.transitionTask(task.id, fromState, 'implementing');
      const basePrompt = pendingFeedback
        ? `${objective}\n\nThe owner requested changes — address them:\n${pendingFeedback}`
        : cycle === 0
          ? objective
          : `${objective}\n\nQA requested changes — address them:\n${JSON.stringify(this.lastQaReport(task.id))}`;
      pendingFeedback = null; // consumed by this (first) developer turn
      // a QA-triggered consult (below) carries its brief into THIS cycle's
      // first developer prompt — and, being set, bounds the cycle to it
      let designBrief: string | null = carryBrief;
      carryBrief = null;
      let dev!: StepResult;
      let devStep!: TaskStep;
      let implReport!: ImplementationReport;
      for (;;) {
        // Owner steering queued while the task ran (ADR-014, I-14): drained
        // read-and-clear at EVERY developer boundary — including the
        // post-consult re-run — so each note lands in exactly one prompt.
        // Steering that arrives after the LAST developer turn (e.g. mid-QA)
        // survives in the queue and folds into the next resume's first
        // developer prompt rather than being lost.
        const steering = this.store.drainTaskFeedback(task.id);
        // Owner-explicit consult trigger (ADR-015): a steering note carrying
        // the NEEDS_DESIGN marker pulls the architect BEFORE this developer
        // run, so the brief and the note land in the same prompt. Still one
        // consult per cycle (a set designBrief blocks it).
        if (designBrief === null) {
          const ownerAsk = steering
            .map((note) => NEEDS_DESIGN.exec(note))
            .find((m) => m !== null);
          if (ownerAsk) {
            const brief = await this.runDesignConsult(task, workspace, objective, ownerAsk[1]?.trim() ?? '');
            if (brief !== null) designBrief = JSON.stringify(brief);
          }
        }
        devStep = this.store.createTaskStep({
          taskId: task.id,
          kind: 'implementation',
          specialistId: devSpecialistId,
          workspaceAccess: accessFor(workspace, 'implementation'),
        });
        let devPrompt =
          designBrief === null
            ? basePrompt
            : `${basePrompt}\n\nThe architect's design brief — follow it:\n${designBrief}`;
        if (steering.length > 0) {
          devPrompt = `${devPrompt}\n\nThe owner added while the task was running — take it into account:\n- ${steering.join('\n- ')}`;
        }
        dev = await this.runner.runStep({
          taskId: task.id,
          taskStepId: devStep.id,
          specialistId: devSpecialistId,
          prompt: devPrompt,
        });
        // cancelled BEFORE failed (#140): a step run the coordinator killed on
        // the owner's cancel must land the task in `cancelled`, never read as
        // a developer failure
        if (await this.cancelIfRequested(task, workspace, 'implementing')) return;
        if (dev.failed) return this.failTask(task, workspace, 'implementing', 'dev step failed');

        implReport = await this.extractor.extractImplementation({
          objective,
          assistantOutput: dev.assistantOutput,
          summary: dev.summary,
        });
        this.store.addWorkProduct({
          taskId: task.id,
          taskStepId: devStep.id,
          producerSpecialistId: devSpecialistId,
          runId: dev.runId,
          kind: 'implementation_report',
          body: implReport,
        });

        // Design consult (ADR-015): the implementer discovered it needs design
        // help (NEEDS_DESIGN marker). Bounded to one consult per cycle; the
        // consult is advisory — unavailable or failed, the loop just proceeds.
        const ask = NEEDS_DESIGN.exec(dev.assistantOutput);
        if (ask === null || designBrief !== null) break;
        const brief = await this.runDesignConsult(task, workspace, objective, ask[1]?.trim() ?? '');
        if (brief === null) break;
        designBrief = JSON.stringify(brief);
        // re-run the developer with the brief folded — the "next developer
        // prompt" the ADR promises
      }
      // No-progress guard (#124): QA asked for changes and the developer's next
      // attempt changed no files — another QA round reviews the same tree and
      // must reach the same verdict, so the loop cannot converge. Cut now with
      // a distinct reason instead of burning the remaining cycles. (The report
      // is recorded first — the trail stays honest.)
      if (cycle > 0 && implReport.filesChanged.length === 0) {
        return this.failTask(
          task,
          workspace,
          'implementing',
          'no_progress: developer changed no files after QA requested changes',
        );
      }
      // commit before QA so QA reviews exactly the implementer's version as a
      // committed ref, and the work survives specialist failure (ADR-010)
      await this.workspace.commitWork(
        task,
        workspace,
        `task ${task.id}: implementation (attempt ${cycle + 1})`,
      );

      // owner cancel (#140), drained again before QA — covers the
      // extractor/commit window after the developer turn
      if (await this.cancelIfRequested(task, workspace, 'implementing')) return;
      // — QA —
      this.store.transitionTask(task.id, 'implementing', 'qa_pending');
      this.store.transitionTask(task.id, 'qa_pending', 'qa_running');
      const qaStep = this.store.createTaskStep({
        taskId: task.id,
        kind: 'qa',
        specialistId: qaSpecialistId,
        workspaceAccess: accessFor(workspace, 'qa'),
      });
      const qa = await this.runner.runStep({
        taskId: task.id,
        taskStepId: qaStep.id,
        specialistId: qaSpecialistId,
        prompt: this.qaBrief(objective, implReport),
      });
      // cancelled BEFORE failed (#140) — same reasoning as the developer step
      if (await this.cancelIfRequested(task, workspace, 'qa_running')) return;
      if (qa.failed) return this.failTask(task, workspace, 'qa_running', 'qa step failed');

      const qaReport = await this.extractor.extractQa({
        objective,
        assistantOutput: qa.assistantOutput,
        summary: qa.summary,
        implementationReport: implReport,
      });
      this.store.addWorkProduct({
        taskId: task.id,
        taskStepId: qaStep.id,
        producerSpecialistId: qaSpecialistId,
        runId: qa.runId,
        kind: 'qa_report',
        body: qaReport,
      });

      if (qaReport.verdict === 'passed') {
        // no cleanup: the worktree survives for human review + N6's PR (ADR-010
        // cleans up only on a TERMINAL task state; awaiting_human_approval isn't)
        this.store.transitionTask(task.id, 'qa_running', 'awaiting_human_approval');
        this.logger.info('task.awaiting_approval', { taskId: task.id, cycles: cycle + 1 });
        return;
      }

      // — changes required: loop, bounded —
      cycle += 1;
      if (cycle >= this.maxCycles) {
        return this.failTask(task, workspace, 'qa_running', 'QA still requesting changes after max cycles');
      }
      // QA-flagged architectural failure (ADR-015): QA's output carrying the
      // NEEDS_DESIGN marker pulls the consult NOW; the brief is carried into
      // the next cycle's first developer prompt (and bounds that cycle).
      const qaAsk = NEEDS_DESIGN.exec(qa.assistantOutput);
      if (qaAsk !== null) {
        const brief = await this.runDesignConsult(task, workspace, objective, qaAsk[1]?.trim() ?? '');
        if (brief !== null) carryBrief = JSON.stringify(brief);
      }
      this.store.transitionTask(task.id, 'qa_running', 'changes_requested_by_qa');
      fromState = 'changes_requested_by_qa';
    }
  }

  /**
   * One architect consult (ADR-015): a read-only `design` step whose product —
   * a DesignBrief — folds into the developer's next prompt. Null when no
   * design specialist is configured or the consult run fails: the consult is
   * an enhancer, never a gate, so the loop proceeds without it.
   */
  private async runDesignConsult(
    task: Task,
    workspace: TaskWorkspace,
    objective: string,
    question: string,
  ): Promise<DesignBrief | null> {
    if (this.designSpecialistId === null) {
      this.logger.info('task.design_unavailable', { taskId: task.id });
      return null;
    }
    const step = this.store.createTaskStep({
      taskId: task.id,
      kind: 'design',
      specialistId: this.designSpecialistId,
      workspaceAccess: accessFor(workspace, 'design'),
    });
    const consult = await this.runner.runStep({
      taskId: task.id,
      taskStepId: step.id,
      specialistId: this.designSpecialistId,
      prompt:
        `Design consult for a running task (read-only — advise, do not implement).\n\n` +
        `Objective:\n${objective}\n\n` +
        `The implementer asked:\n${question || '(no specific question — review the approach)'}`,
    });
    if (consult.failed) {
      this.logger.warn('task.design_failed', { taskId: task.id, stepId: step.id });
      return null;
    }
    const brief = await this.extractor.extractDesign({
      objective,
      question,
      assistantOutput: consult.assistantOutput,
      summary: consult.summary,
    });
    this.store.addWorkProduct({
      taskId: task.id,
      taskStepId: step.id,
      producerSpecialistId: this.designSpecialistId,
      runId: consult.runId,
      kind: 'design_brief',
      body: brief,
    });
    this.logger.info('task.design_consulted', { taskId: task.id, stepId: step.id });
    return brief;
  }

  /** A terminal failure: clean up the worktree (branch/commits survive) then fail. */
  private async failTask(
    task: Task,
    workspace: TaskWorkspace,
    from: Task['state'],
    why: string,
  ): Promise<void> {
    await this.workspace.cleanup(task, workspace);
    this.store.transitionTask(task.id, from, 'failed');
    this.logger.warn('task.failed', { taskId: task.id, from, why });
  }

  /**
   * Owner cancel, cooperative (#140): the request set is drained at step
   * boundaries — a running CLI turn is killed by the coordinator through the
   * run loop (its step then arrives here already dead), and between steps
   * this check lands it directly. Cleanup keeps the branch (commits survive),
   * like every terminal cleanup; a cleanup failure never blocks the cancel.
   */
  private async cancelIfRequested(
    task: Task,
    workspace: TaskWorkspace,
    from: Task['state'],
  ): Promise<boolean> {
    if (!this.isCancelled(task.id)) return false;
    try {
      await this.workspace.cleanup(task, workspace);
    } catch (err) {
      this.logger.warn('task.cancel_cleanup_failed', {
        taskId: task.id,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
    this.store.transitionTask(task.id, from, 'cancelled');
    this.logger.info('task.cancelled', { taskId: task.id, from });
    return true;
  }

  /**
   * Crash-path failure (an unexpected throw, not a flow outcome): read the
   * task's CURRENT state and fail it from there, cleaning up the worktree
   * best-effort. Every non-terminal task state can transition to `failed`.
   */
  private async failFromCurrentState(
    task: Task,
    workspace: TaskWorkspace | null,
    err: unknown,
  ): Promise<void> {
    const current = this.store.getTask(task.id);
    if (!current || isTerminalTask(current.state)) {
      this.logger.error('task.supervise_threw_after_terminal', {
        taskId: task.id,
        error: err instanceof Error ? err.name : 'unknown',
      });
      return;
    }
    if (workspace) {
      // only if a worktree was actually created — a failure during acquisition
      // itself leaves nothing to clean up
      try {
        await this.workspace.cleanup(task, workspace);
      } catch (cleanupErr) {
        this.logger.warn('task.cleanup_failed_on_crash', {
          taskId: task.id,
          error: cleanupErr instanceof Error ? cleanupErr.name : 'unknown',
        });
      }
    }
    this.store.transitionTask(current.id, current.state, 'failed');
    this.logger.error('task.supervise_crashed', {
      taskId: task.id,
      from: current.state,
      error: err instanceof Error ? err.name : 'unknown',
    });
  }

  private lastQaReport(taskId: string): unknown {
    const qas = this.store
      .listWorkProducts(taskId)
      .filter((w) => w.kind === 'qa_report');
    return qas.length ? qas[qas.length - 1]!.body : null;
  }

  private qaBrief(objective: string, impl: ImplementationReport): string {
    return (
      `Review this implementation against the objective and run QA.\n\n` +
      `Objective:\n${objective}\n\n` +
      `Implementation report:\n${JSON.stringify(impl)}`
    );
  }
}

/**
 * The audited workspace grant for a step (ADR-010 §71): implementation writes
 * the worktree (or the project workspace on the strategy-A fallback); QA runs
 * tests in it. The branch/path come from the task's workspace; `executeRun`
 * reads `path` back to run the step's turn in the worktree.
 */
function accessFor(workspace: TaskWorkspace, kind: TaskStep['kind']): DelegatedWorkspaceAccess {
  const accessMode: WorkspaceAccessMode =
    kind === 'qa'
      ? 'test-execution'
      : kind === 'design'
        ? 'read-only' // a consult advises, never writes (ADR-015, ADR-010 ladder)
        : workspace.strategy === 'worktree'
          ? 'worktree-write'
          : 'project-workspace-write';
  return {
    accessMode,
    branch: workspace.branch,
    path: workspace.path,
    pathBounds: [],
    expiresAt: null,
  };
}
