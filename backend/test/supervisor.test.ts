/**
 * The dev → QA supervisor (N5b, ADR-009) — offline. A fake StepRunner scripts
 * each specialist turn's output; the real DeterministicReportExtractor turns
 * that output into reports (QA verdict = `changes_required` when the output
 * carries the CHANGES_REQUIRED marker). The MemoryHubStore holds real task
 * state, so this exercises the full loop: transitions, work-product recording,
 * the bounded changes-required cycle, and both failure paths.
 */

import { describe, expect, it } from 'vitest';
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

const okStep = (text: string): StepResult => ({ assistantOutput: text, summary: null, runId: 'run_x', failed: false });
const failStep = (): StepResult => ({ assistantOutput: '', summary: null, runId: 'run_x', failed: true });

function setup(script: StepResult[], maxQaCycles?: number) {
  const store = new MemoryHubStore();
  const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
  const task = store.createTask({ projectId: p.id });
  const runner = new ScriptedRunner(script);
  const sup = new Supervisor({
    store,
    runner,
    extractor: new DeterministicReportExtractor(),
    ...(maxQaCycles !== undefined ? { maxQaCycles } : {}),
  });
  return { store, task, runner, sup };
}

describe('Supervisor dev → QA loop (ADR-009)', () => {
  it('happy path: dev → QA passed → awaiting_human_approval, with both work products', async () => {
    const { store, task, runner, sup } = setup([okStep('implemented it'), okStep('QA: all good')]);
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
  });

  it('changes_required loops back to dev, then passes', async () => {
    const { store, task, runner, sup } = setup([
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
  });

  it('a failed dev step fails the task', async () => {
    const { store, task, sup } = setup([failStep()]);
    await sup.supervise(task, 'X', 'dev', 'qa');
    expect(store.getTask(task.id)!.state).toBe('failed');
  });

  it('a failed QA step fails the task', async () => {
    const { store, task, sup } = setup([okStep('impl'), failStep()]);
    await sup.supervise(task, 'X', 'dev', 'qa');
    expect(store.getTask(task.id)!.state).toBe('failed');
  });

  it('fails after max QA cycles of persistent changes_required (no infinite loop)', async () => {
    // QA always wants changes; with maxQaCycles=2, the task fails on the 2nd cycle
    const { store, task, sup } = setup(
      [
        okStep('a'), okStep('CHANGES_REQUIRED'),
        okStep('b'), okStep('CHANGES_REQUIRED'),
      ],
      2,
    );
    await sup.supervise(task, 'X', 'dev', 'qa');
    expect(store.getTask(task.id)!.state).toBe('failed');
  });
});
