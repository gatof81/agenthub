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

import type { ReportExtractorPort } from '../domain/ports.js';
import { NOOP_LOGGER, type Logger } from '../domain/ports.js';
import type { ImplementationReport, RunSummary, Task } from '../domain/types.js';
import type { HubStore } from '../store/types.js';

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
  logger?: Logger;
  maxQaCycles?: number;
}

export class Supervisor {
  private readonly store: HubStore;
  private readonly runner: StepRunner;
  private readonly extractor: ReportExtractorPort;
  private readonly logger: Logger;
  private readonly maxCycles: number;

  constructor(deps: SupervisorDeps) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.extractor = deps.extractor;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.maxCycles = deps.maxQaCycles ?? MAX_QA_CYCLES;
  }

  /**
   * Drive `task` (in `planning`) through dev → QA to `awaiting_human_approval`,
   * or `failed`. `objective` is the task brief; the two specialists implement
   * and QA it. Never throws for a flow outcome — a failure lands the task in
   * `failed` and returns.
   */
  async supervise(
    task: Task,
    objective: string,
    devSpecialistId: string,
    qaSpecialistId: string,
  ): Promise<void> {
    let fromState = task.state; // 'planning' on entry
    let cycle = 0;

    for (;;) {
      // — implementation —
      this.store.transitionTask(task.id, fromState, 'implementing');
      const devStep = this.store.createTaskStep({
        taskId: task.id,
        kind: 'implementation',
        specialistId: devSpecialistId,
      });
      const lastQa = this.lastQaReport(task.id);
      const devPrompt =
        cycle === 0
          ? objective
          : `${objective}\n\nQA requested changes — address them:\n${JSON.stringify(lastQa)}`;
      const dev = await this.runner.runStep({
        taskId: task.id,
        taskStepId: devStep.id,
        specialistId: devSpecialistId,
        prompt: devPrompt,
      });
      if (dev.failed) return this.fail(task.id, 'implementing', 'dev step failed');

      const implReport = await this.extractor.extractImplementation({
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

      // — QA —
      this.store.transitionTask(task.id, 'implementing', 'qa_pending');
      this.store.transitionTask(task.id, 'qa_pending', 'qa_running');
      const qaStep = this.store.createTaskStep({
        taskId: task.id,
        kind: 'qa',
        specialistId: qaSpecialistId,
      });
      const qa = await this.runner.runStep({
        taskId: task.id,
        taskStepId: qaStep.id,
        specialistId: qaSpecialistId,
        prompt: this.qaBrief(objective, implReport),
      });
      if (qa.failed) return this.fail(task.id, 'qa_running', 'qa step failed');

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
        this.store.transitionTask(task.id, 'qa_running', 'awaiting_human_approval');
        this.logger.info('task.awaiting_approval', { taskId: task.id, cycles: cycle + 1 });
        return;
      }

      // — changes required: loop, bounded —
      cycle += 1;
      if (cycle >= this.maxCycles) {
        return this.fail(task.id, 'qa_running', 'QA still requesting changes after max cycles');
      }
      this.store.transitionTask(task.id, 'qa_running', 'changes_requested_by_qa');
      fromState = 'changes_requested_by_qa';
    }
  }

  private fail(taskId: string, from: Task['state'], why: string): void {
    this.store.transitionTask(taskId, from, 'failed');
    this.logger.warn('task.failed', { taskId, from, why });
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
