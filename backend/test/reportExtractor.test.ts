/**
 * ReportExtractor (N5b, ADR-009) — offline. The deterministic extractor grounds
 * every field in the run summary; the model extractor uses a forced tool call
 * (injected fake client, no network) and, crucially, on any failure NEVER
 * auto-passes QA — it falls back to verdict `changes_required` so a broken
 * extraction loops the task back instead of falsely advancing toward approval.
 */

import { describe, expect, it, vi } from 'vitest';
import type { QaReportInput, ReportInput } from '../src/domain/ports.js';
import type { ImplementationReport, RunSummary } from '../src/domain/types.js';
import {
  DeterministicReportExtractor,
  ModelReportExtractor,
} from '../src/orchestrator/reportExtractor.js';

const SUMMARY: RunSummary = {
  runId: 'run_1',
  objective: 'add feature X',
  outcome: 'completed',
  filesTouched: ['src/x.ts', 'test/x.test.ts'],
  commandsRun: ['npm test'],
  denialCount: 0,
  warnings: [],
  costUsd: null,
  numTurns: null,
  durationMs: null,
  runtimeSessionId: null,
};

const IMPL: ImplementationReport = {
  objective: 'add feature X',
  summary: 'added X',
  filesChanged: ['src/x.ts'],
  commandsRun: ['npm test'],
  testsRun: ['unit'],
  knownRisks: [],
  commitOrPatch: null,
};

const implInput: ReportInput = { objective: 'add feature X', assistantOutput: 'I added X and tested it.', summary: SUMMARY };
const qaInput: QaReportInput = {
  objective: 'add feature X',
  assistantOutput: 'Ran the tests, all pass.',
  summary: SUMMARY,
  implementationReport: IMPL,
};

function fakeClient(reply: unknown | (() => never)) {
  const create = vi.fn(async () => {
    if (typeof reply === 'function') (reply as () => never)();
    return { content: [{ type: 'tool_use', id: 't1', name: 'submit', input: reply }] };
  });
  return { client: { messages: { create } } as never, create };
}

describe('DeterministicReportExtractor (offline / fallback base)', () => {
  const ex = new DeterministicReportExtractor();

  it('grounds the implementation report in the run summary', async () => {
    const r = await ex.extractImplementation(implInput);
    expect(r.filesChanged).toEqual(['src/x.ts', 'test/x.test.ts']);
    expect(r.commandsRun).toEqual(['npm test']);
    expect(r.objective).toBe('add feature X');
  });

  it('QA verdict is passed by default, changes_required on the marker', async () => {
    expect((await ex.extractQa(qaInput)).verdict).toBe('passed');
    const failing = { ...qaInput, assistantOutput: 'A test broke: CHANGES_REQUIRED' };
    expect((await ex.extractQa(failing)).verdict).toBe('changes_required');
  });
});

describe('ModelReportExtractor (forced tool call, injected fake)', () => {
  it('returns the model-produced implementation report', async () => {
    const { client, create } = fakeClient({
      objective: 'X', summary: 'did X', filesChanged: ['a.ts'], commandsRun: [], testsRun: ['unit'], knownRisks: [],
    });
    const ex = new ModelReportExtractor({ oauthToken: 't', client });
    const r = await ex.extractImplementation(implInput);
    expect(create).toHaveBeenCalledOnce();
    expect(r.filesChanged).toEqual(['a.ts']);
    expect(r.testsRun).toEqual(['unit']);
  });

  it('returns the model QA verdict', async () => {
    const { client } = fakeClient({
      requirementsReviewed: ['R1'], testsRun: ['unit'], passed: ['unit'], failed: [], regressions: [], verdict: 'passed',
    });
    const ex = new ModelReportExtractor({ oauthToken: 't', client });
    expect((await ex.extractQa(qaInput)).verdict).toBe('passed');
  });

  it('impl-report extraction failure falls back to the mechanical report', async () => {
    const { client } = fakeClient(() => { throw new Error('boom'); });
    const ex = new ModelReportExtractor({ oauthToken: 't', client });
    const r = await ex.extractImplementation(implInput);
    expect(r.filesChanged).toEqual(['src/x.ts', 'test/x.test.ts']); // mechanical fallback
  });

  it('QA extraction failure NEVER auto-passes — verdict is changes_required', async () => {
    const { client } = fakeClient(() => { throw new Error('boom'); });
    const ex = new ModelReportExtractor({ oauthToken: 't', client });
    const r = await ex.extractQa(qaInput);
    expect(r.verdict).toBe('changes_required');
    expect(r.failed[0]).toMatch(/extraction failed/);
  });

  it('a model verdict other than "passed" is coerced to changes_required (fail-safe)', async () => {
    const { client } = fakeClient({
      requirementsReviewed: [], testsRun: [], passed: [], failed: [], regressions: [], verdict: 'nonsense',
    });
    const ex = new ModelReportExtractor({ oauthToken: 't', client });
    expect((await ex.extractQa(qaInput)).verdict).toBe('changes_required');
  });
});
