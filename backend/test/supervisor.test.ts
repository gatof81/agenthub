/**
 * The dev → QA supervisor (N5b, ADR-009) — offline. A fake StepRunner scripts
 * each specialist turn's output; the real DeterministicReportExtractor turns
 * that output into reports (QA verdict = `changes_required` when the output
 * carries the CHANGES_REQUIRED marker). The MemoryHubStore holds real task
 * state, so this exercises the full loop: transitions, work-product recording,
 * the bounded changes-required cycle, and both failure paths.
 */

import { describe, expect, it } from 'vitest';
import type { WorkspaceManagerPort } from '../src/domain/ports.js';
import type { Task, TaskWorkspace } from '../src/domain/types.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { DeterministicReportExtractor } from '../src/orchestrator/reportExtractor.js';
import { Supervisor, type StepResult, type StepRunner } from '../src/orchestrator/supervisor.js';

/** A StepRunner that returns scripted outputs in order (one per step run). */
class ScriptedRunner implements StepRunner {
  calls: Array<{ specialistId: string; prompt: string }> = [];
  constructor(private readonly script: StepResult[]) {}
  runStep(input: { specialistId: string; prompt: string }): Promise<StepResult> {
    this.calls.push({ specialistId: input.specialistId, prompt: input.prompt });
    const r = this.script.shift();
    if (!r) throw new Error('scripted runner exhausted');
    return Promise.resolve(r);
  }
}

/** Records the worktree lifecycle so the supervisor's ordering can be asserted offline. */
class RecordingWorkspace implements WorkspaceManagerPort {
  calls: string[] = [];
  createTaskWorkspace(task: Task): Promise<TaskWorkspace> {
    this.calls.push('create');
    return Promise.resolve({
      strategy: 'worktree',
      branch: `hub/task/${task.id}`,
      path: `.hub-task-worktrees/${task.id}`,
    });
  }
  commitWork(): Promise<void> {
    this.calls.push('commit');
    return Promise.resolve();
  }
  cleanup(): Promise<void> {
    this.calls.push('cleanup');
    return Promise.resolve();
  }
}

const okStep = (text: string): StepResult => ({ assistantOutput: text, summary: null, runId: 'run_x', failed: false });
const failStep = (): StepResult => ({ assistantOutput: '', summary: null, runId: 'run_x', failed: true });

function setup(script: StepResult[], maxQaCycles?: number) {
  const store = new MemoryHubStore();
  const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
  const task = store.createTask({ projectId: p.id });
  const runner = new ScriptedRunner(script);
  const workspace = new RecordingWorkspace();
  const sup = new Supervisor({
    store,
    runner,
    extractor: new DeterministicReportExtractor(),
    workspace,
    ...(maxQaCycles !== undefined ? { maxQaCycles } : {}),
  });
  return { store, task, runner, workspace, sup };
}

describe('Supervisor dev → QA loop (ADR-009)', () => {
  it('happy path: dev → QA passed → awaiting_human_approval, with both work products', async () => {
    const { store, task, runner, workspace, sup } = setup([okStep('implemented it'), okStep('QA: all good')]);
    await sup.supervise(task, 'add feature X', 'dev', 'qa');

    expect(store.getTask(task.id)!.state).toBe('awaiting_human_approval');
    const steps = store.listTaskSteps(task.id);
    expect(steps.map((s) => s.kind)).toEqual(['implementation', 'qa']);
    const wps = store.listWorkProducts(task.id);
    expect(wps.map((w) => w.kind).sort()).toEqual(['implementation_report', 'qa_report']);
    // dev ran first with the raw objective; QA ran with the impl report brief
    expect(runner.calls[0]!.specialistId).toBe('dev');
    expect(runner.calls[0]!.prompt).toBe('add feature X');
    expect(runner.calls[1]!.specialistId).toBe('qa');

    // worktree (ADR-010 B): created once, committed after dev, NOT cleaned up —
    // it survives for human review + N6's PR
    expect(workspace.calls).toEqual(['create', 'commit']);
    // each step records its audited workspace grant, on the task branch
    expect(steps[0]!.workspaceAccess).toMatchObject({ accessMode: 'worktree-write', branch: `hub/task/${task.id}` });
    expect(steps[1]!.workspaceAccess).toMatchObject({ accessMode: 'test-execution', branch: `hub/task/${task.id}` });
  });

  it('changes_required loops back to dev, then passes', async () => {
    const { store, task, runner, workspace, sup } = setup([
      okStep('first attempt'),
      okStep('QA found a bug: CHANGES_REQUIRED'),
      okStep('fixed the bug'),
      okStep('QA: looks good now'),
    ]);
    await sup.supervise(task, 'add feature X', 'dev', 'qa');

    expect(store.getTask(task.id)!.state).toBe('awaiting_human_approval');
    // two dev + two qa steps
    expect(store.listTaskSteps(task.id).map((s) => s.kind)).toEqual(['implementation', 'qa', 'implementation', 'qa']);
    // the second dev turn carries the QA changes as context
    expect(runner.calls[2]!.specialistId).toBe('dev');
    expect(runner.calls[2]!.prompt).toContain('QA requested changes');
    expect(store.listWorkProducts(task.id)).toHaveLength(4);
    // one worktree for the whole task, a commit after each dev attempt, no cleanup
    expect(workspace.calls).toEqual(['create', 'commit', 'commit']);
  });

  it('a failed dev step fails the task and cleans up the worktree', async () => {
    const { store, task, workspace, sup } = setup([failStep()]);
    await sup.supervise(task, 'X', 'dev', 'qa');
    expect(store.getTask(task.id)!.state).toBe('failed');
    // dev failed before any commit; the worktree is cleaned up on the terminal state
    expect(workspace.calls).toEqual(['create', 'cleanup']);
  });

  it('a failed QA step fails the task and cleans up the worktree', async () => {
    const { store, task, workspace, sup } = setup([okStep('impl'), failStep()]);
    await sup.supervise(task, 'X', 'dev', 'qa');
    expect(store.getTask(task.id)!.state).toBe('failed');
    expect(workspace.calls).toEqual(['create', 'commit', 'cleanup']);
  });

  it('fails after max QA cycles of persistent changes_required (no infinite loop)', async () => {
    // QA always wants changes; with maxQaCycles=2, the task fails on the 2nd cycle
    const { store, task, workspace, sup } = setup(
      [
        okStep('a'), okStep('CHANGES_REQUIRED'),
        okStep('b'), okStep('CHANGES_REQUIRED'),
      ],
      2,
    );
    await sup.supervise(task, 'X', 'dev', 'qa');
    expect(store.getTask(task.id)!.state).toBe('failed');
    // one worktree, a commit per dev attempt, cleaned up on the terminal failure
    expect(workspace.calls).toEqual(['create', 'commit', 'commit', 'cleanup']);
  });
});
