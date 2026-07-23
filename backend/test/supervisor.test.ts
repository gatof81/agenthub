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
  openPullRequest(): Promise<{ url: string | null }> {
    this.calls.push('openPullRequest');
    return Promise.resolve({ url: null });
  }
}

const okStep = (text: string): StepResult => ({ assistantOutput: text, summary: null, runId: 'run_x', failed: false });
const failStep = (): StepResult => ({ assistantOutput: '', summary: null, runId: 'run_x', failed: true });
/** A dev step whose summary shows real file changes — post-QA attempts need
 *  this to clear the no-progress guard (#124). */
const progressStep = (text: string): StepResult => ({
  assistantOutput: text,
  summary: {
    runId: 'run_x',
    objective: 'x',
    outcome: 'completed',
    filesTouched: ['src/a.ts'],
    commandsRun: [],
    denialCount: 0,
    warnings: [],
    costUsd: null,
    numTurns: null,
    durationMs: null,
    runtimeSessionId: null,
  },
  runId: 'run_x',
  failed: false,
});

function setup(
  script: StepResult[],
  maxQaCycles?: number,
  opts: { designSpecialistId?: string | null } = {},
) {
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
    ...(opts.designSpecialistId !== undefined ? { designSpecialistId: opts.designSpecialistId } : {}),
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
      progressStep('fixed the bug'),
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

  it('resume (owner-requested changes) reuses the worktree and folds the note into the first dev prompt', async () => {
    const { store, task, runner, workspace, sup } = setup([
      okStep('first impl'),
      okStep('QA: ok'), // round 1 → awaiting_human_approval
      okStep('addressed the rename'),
      okStep('QA: ok now'), // resume round → awaiting_human_approval again
    ]);
    await sup.supervise(task, 'add feature X', 'dev', 'qa');
    expect(store.getTask(task.id)!.state).toBe('awaiting_human_approval');

    // the owner requests changes → the orchestrator moves the state, then resumes
    store.transitionTask(task.id, 'awaiting_human_approval', 'changes_requested_by_user');
    await sup.supervise(store.getTask(task.id)!, 'add feature X', 'dev', 'qa', {
      feedback: 'please rename foo to bar',
    });

    expect(store.getTask(task.id)!.state).toBe('awaiting_human_approval');
    // the resume's developer turn (call #3) carried the owner's note, not a bare objective
    expect(runner.calls[2]!.prompt).toContain('owner requested changes');
    expect(runner.calls[2]!.prompt).toContain('please rename foo to bar');
    // the worktree was created ONCE (round 1); the resume recovered it — no second create
    expect(workspace.calls.filter((c) => c === 'create')).toHaveLength(1);
    // four steps total: two developer + two QA across the two rounds
    expect(store.listTaskSteps(task.id)).toHaveLength(4);
  });

  it('NEEDS_DESIGN triggers one architect consult; the brief folds into the re-run dev prompt (ADR-015)', async () => {
    const { store, task, runner, sup } = setup(
      [
        okStep('NEEDS_DESIGN: how should the cache invalidate?'), // dev asks
        okStep('Use a write-through cache keyed by conversation id.'), // architect
        okStep('implemented per the brief'), // dev re-runs with the brief
        okStep('QA: looks good'),
      ],
      undefined,
      { designSpecialistId: 'arch' },
    );
    await sup.supervise(task, 'add caching', 'dev', 'qa');

    expect(store.getTask(task.id)!.state).toBe('awaiting_human_approval');
    const steps = store.listTaskSteps(task.id);
    expect(steps.map((s) => [s.kind, s.specialistId])).toEqual([
      ['implementation', 'dev'],
      ['design', 'arch'],
      ['implementation', 'dev'],
      ['qa', 'qa'],
    ]);
    // the consult never writes: read-only grant on the task's branch
    expect(steps[1]!.workspaceAccess).toMatchObject({ accessMode: 'read-only', branch: `hub/task/${task.id}` });
    // the architect got the question; the re-run dev got the brief
    expect(runner.calls[1]!.specialistId).toBe('arch');
    expect(runner.calls[1]!.prompt).toContain('how should the cache invalidate?');
    expect(runner.calls[1]!.prompt).toContain('advise, do not implement');
    expect(runner.calls[2]!.prompt).toContain("The architect's design brief");
    expect(runner.calls[2]!.prompt).toContain('write-through cache');
    // work products: impl (the asking attempt), design brief, impl, qa
    expect(store.listWorkProducts(task.id).map((w) => w.kind)).toEqual([
      'implementation_report',
      'design_brief',
      'implementation_report',
      'qa_report',
    ]);
  });

  it('the consult is bounded to one per cycle — a second NEEDS_DESIGN proceeds to QA (ADR-015)', async () => {
    const { store, task, runner, sup } = setup(
      [
        okStep('NEEDS_DESIGN: first question'),
        okStep('brief one'),
        okStep('NEEDS_DESIGN: still unsure'), // second ask, same cycle → ignored
        okStep('QA: acceptable'),
      ],
      undefined,
      { designSpecialistId: 'arch' },
    );
    await sup.supervise(task, 'X', 'dev', 'qa');

    expect(store.getTask(task.id)!.state).toBe('awaiting_human_approval');
    expect(store.listTaskSteps(task.id).map((s) => s.kind)).toEqual([
      'implementation',
      'design',
      'implementation',
      'qa', // ← not a second design step
    ]);
    expect(runner.calls[3]!.specialistId).toBe('qa');
  });

  it('QA flagging an architectural failure pulls the consult; the brief lands in the next cycle (ADR-015)', async () => {
    const { store, task, runner, sup } = setup(
      [
        okStep('first attempt'),
        okStep('CHANGES_REQUIRED — NEEDS_DESIGN: the layering is wrong, where should this live?'),
        okStep('Move it behind the port; keep the domain pure.'), // architect
        progressStep('moved it per the brief'), // next cycle's dev (real progress)
        okStep('QA: correct now'),
      ],
      undefined,
      { designSpecialistId: 'arch' },
    );
    await sup.supervise(task, 'refactor X', 'dev', 'qa');

    expect(store.getTask(task.id)!.state).toBe('awaiting_human_approval');
    expect(store.listTaskSteps(task.id).map((s) => s.kind)).toEqual([
      'implementation',
      'qa',
      'design', // consult pulled by QA's marker, before the next cycle
      'implementation',
      'qa',
    ]);
    // the architect got QA's question; the next dev prompt carries the brief
    expect(runner.calls[2]!.specialistId).toBe('arch');
    expect(runner.calls[2]!.prompt).toContain('where should this live?');
    expect(runner.calls[3]!.prompt).toContain("The architect's design brief");
    expect(runner.calls[3]!.prompt).toContain('behind the port');
  });

  it('an owner steering note with NEEDS_DESIGN pulls the consult before the next dev run (ADR-015)', async () => {
    const { store, task, runner, sup } = setup(
      [
        okStep('Use the existing broadcaster; do not add a socket.'), // architect first
        okStep('implemented on the broadcaster'), // dev, brief + note in prompt
        okStep('QA: good'),
      ],
      undefined,
      { designSpecialistId: 'arch' },
    );
    store.appendTaskFeedback(task.id, 'NEEDS_DESIGN: should this be a new socket or reuse SSE?');
    await sup.supervise(task, 'add live updates', 'dev', 'qa');

    expect(store.getTask(task.id)!.state).toBe('awaiting_human_approval');
    // the consult ran BEFORE the developer — same boundary, same prompt
    expect(store.listTaskSteps(task.id).map((s) => s.kind)).toEqual(['design', 'implementation', 'qa']);
    expect(runner.calls[0]!.specialistId).toBe('arch');
    expect(runner.calls[0]!.prompt).toContain('new socket or reuse SSE');
    expect(runner.calls[1]!.prompt).toContain("The architect's design brief");
    expect(runner.calls[1]!.prompt).toContain('existing broadcaster');
    // the note itself still rides as steering (it is owner input)
    expect(runner.calls[1]!.prompt).toContain('take it into account');
    expect(store.getTask(task.id)!.pendingFeedback).toEqual([]);
  });

  it('with no design specialist configured, NEEDS_DESIGN is a no-op and the loop proceeds (ADR-015)', async () => {
    const { store, task, runner, sup } = setup([
      okStep('NEEDS_DESIGN: help'),
      okStep('QA: fine as is'),
    ]);
    await sup.supervise(task, 'X', 'dev', 'qa');

    expect(store.getTask(task.id)!.state).toBe('awaiting_human_approval');
    expect(store.listTaskSteps(task.id).map((s) => s.kind)).toEqual(['implementation', 'qa']);
    expect(runner.calls).toHaveLength(2);
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
        progressStep('b'), okStep('CHANGES_REQUIRED'),
      ],
      2,
    );
    await sup.supervise(task, 'X', 'dev', 'qa');
    expect(store.getTask(task.id)!.state).toBe('failed');
    // one worktree, a commit per dev attempt, cleaned up on the terminal failure
    expect(workspace.calls).toEqual(['create', 'commit', 'commit', 'cleanup']);
  });

  it('folds queued owner steering into the developer prompt and drains it (ADR-014)', async () => {
    const { store, task, runner, sup } = setup([okStep('implemented'), okStep('QA: ok')]);
    store.appendTaskFeedback(task.id, 'also rename the button');
    store.appendTaskFeedback(task.id, 'and use the accent color');
    await sup.supervise(task, 'add feature X', 'dev', 'qa');

    expect(store.getTask(task.id)!.state).toBe('awaiting_human_approval');
    // both notes landed in the DEVELOPER prompt, in order — and only there
    expect(runner.calls[0]!.prompt).toContain('take it into account');
    expect(runner.calls[0]!.prompt).toContain('- also rename the button\n- and use the accent color');
    expect(runner.calls[1]!.prompt).not.toContain('rename the button');
    // drained: each note folds into exactly one prompt
    expect(store.getTask(task.id)!.pendingFeedback).toEqual([]);
  });

  it('steering that arrives after the last developer turn survives for the resume (ADR-014)', async () => {
    const { store, task, runner, sup } = setup([
      okStep('impl'),
      okStep('QA: ok'), // → awaiting_human_approval, steering still queued
      okStep('addressed both'),
      okStep('QA: ok again'),
    ]);
    await sup.supervise(task, 'add feature X', 'dev', 'qa');
    // the owner steered mid-QA — too late for any dev boundary of round 1
    store.appendTaskFeedback(task.id, 'late note: tighten the copy');
    expect(store.getTask(task.id)!.pendingFeedback).toEqual(['late note: tighten the copy']);

    store.transitionTask(task.id, 'awaiting_human_approval', 'changes_requested_by_user');
    await sup.supervise(store.getTask(task.id)!, 'add feature X', 'dev', 'qa', {
      feedback: 'please split the component',
    });

    // the resume's first developer prompt carries BOTH the formal note and the
    // late steering — nothing queued is ever lost
    expect(runner.calls[2]!.prompt).toContain('please split the component');
    expect(runner.calls[2]!.prompt).toContain('late note: tighten the copy');
    expect(store.getTask(task.id)!.pendingFeedback).toEqual([]);
  });

  it('no progress after changes_required fails fast — no second QA round on an unchanged tree (#124)', async () => {
    const { store, task, workspace, sup } = setup([
      okStep('first attempt'),
      okStep('CHANGES_REQUIRED: missing test'),
      okStep('nothing further I can do'), // summary null → filesChanged [] = no progress
      okStep('QA would run again'), // must never be reached
    ]);
    await sup.supervise(task, 'X', 'dev', 'qa');

    expect(store.getTask(task.id)!.state).toBe('failed');
    // the stalled attempt is recorded (honest trail), but QA never re-ran
    expect(store.listTaskSteps(task.id).map((s) => s.kind)).toEqual([
      'implementation',
      'qa',
      'implementation',
    ]);
    expect(store.listWorkProducts(task.id)).toHaveLength(3);
    // cut BEFORE committing the empty attempt: one commit (attempt 1), then cleanup
    expect(workspace.calls).toEqual(['create', 'commit', 'cleanup']);
  });

  it('an unexpected throw mid-loop fails the task from its current state and cleans up (ADR-009 boot reconciliation)', async () => {
    const { store, task, workspace, sup } = setup([okStep('implemented it')]);
    // commitWork throws — an UNEXPECTED failure after the dev step, NOT one of the
    // flow outcomes that return via failTask. Without supervise()'s try/catch this
    // would escape, leaving the task stuck non-terminal forever and leaking the
    // worktree; instead it is failed from its current state and cleaned up.
    workspace.commitWork = (): Promise<void> => {
      workspace.calls.push('commit');
      return Promise.reject(new Error('git worktree add exploded'));
    };
    await sup.supervise(task, 'X', 'dev', 'qa'); // must not throw

    // the throw happened in `implementing`; the task is failed from there, not left hanging
    expect(store.getTask(task.id)!.state).toBe('failed');
    expect(workspace.calls).toEqual(['create', 'commit', 'cleanup']);
  });

  it('a worktree-provisioning failure fails the task with nothing to clean up (ADR-009 boot reconciliation)', async () => {
    const { store, task, workspace, sup } = setup([]);
    // createTaskWorkspace throws — acquisition itself fails, BEFORE any worktree
    // exists. The task must still be failed (from `planning`), and cleanup must
    // NOT run (there is nothing created to remove).
    workspace.createTaskWorkspace = (): Promise<TaskWorkspace> => {
      workspace.calls.push('create');
      return Promise.reject(new Error('git worktree add failed'));
    };
    await sup.supervise(task, 'X', 'dev', 'qa'); // must not throw

    expect(store.getTask(task.id)!.state).toBe('failed');
    expect(workspace.calls).toEqual(['create']); // no 'cleanup' — nothing was created
  });
});
