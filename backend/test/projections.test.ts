import { describe, expect, it } from 'vitest';
import {
  assembleAssistantText,
  deriveActivity,
  deriveRunSummary,
} from '../src/domain/projections.js';
import type { Run, RunEvent } from '../src/domain/types.js';

function ev(seq: number, type: RunEvent['type'], payload: unknown): RunEvent {
  return { id: `ev_${seq}`, runId: 'run_1', seq, type, payload, ts: '2026-07-15T00:00:00.000Z' };
}

const EVENTS: RunEvent[] = [
  ev(1, 'started', { execId: 'x' }),
  ev(2, 'output', { blockType: 'text', text: 'I will ' }),
  ev(3, 'tool_use', { name: 'Bash', input: { command: 'npm test' } }),
  ev(4, 'tool_use', { name: 'Write', input: { file_path: '/w/a.ts' } }),
  ev(5, 'tool_use', { name: 'Edit', input: { file_path: '/w/a.ts' } }),
  ev(6, 'output', { blockType: 'thinking' }),
  ev(7, 'permission_denial', { tool_name: 'WebFetch' }),
  ev(8, 'output', { blockType: 'text', text: 'fix it.' }),
  ev(9, 'exit', { exitCode: 0 }),
];

describe('activity projection (A2, FR-14/15)', () => {
  it('derives commands, deduped files, and denials from events on read', () => {
    const activity = deriveActivity(EVENTS);
    expect(activity.commands).toEqual(['npm test']);
    expect(activity.files).toEqual(['/w/a.ts']); // deduped
    expect(activity.denials).toEqual(['WebFetch']);
    expect(activity.items.map((i) => i.kind)).toEqual(['command', 'file', 'file', 'denial']);
  });
});

describe('assistant text assembly (06 §Message)', () => {
  it('concatenates only text blocks — thinking and tool results excluded', () => {
    expect(assembleAssistantText(EVENTS)).toBe('I will fix it.');
  });
});

describe('RunSummary mechanical derivation (FR-42)', () => {
  const run = {
    id: 'run_1',
    startedAt: '2026-07-15T00:00:00.000Z',
  } as Run;

  it('derives every field deterministically from persisted data', () => {
    const summary = deriveRunSummary({
      run,
      outcome: 'completed',
      events: EVENTS,
      usage: { totalCostUsd: 0.05, numTurns: 3 },
      userMessageContent: 'fix the tests',
      warnings: ['warn A'],
      runtimeSessionId: 'S01-SESSION-C',
      endedAt: '2026-07-15T00:00:04.500Z',
    });
    expect(summary).toEqual({
      runId: 'run_1',
      objective: 'fix the tests',
      outcome: 'completed',
      filesTouched: ['/w/a.ts'],
      commandsRun: ['npm test'],
      denialCount: 1,
      warnings: ['warn A'],
      costUsd: 0.05,
      numTurns: 3,
      durationMs: 4500,
      runtimeSessionId: 'S01-SESSION-C',
    });
  });

  it('is available for cancelled runs with unknown cost (UX-06)', () => {
    const summary = deriveRunSummary({
      run: { ...run, startedAt: null } as Run,
      outcome: 'cancelled',
      events: [],
      usage: { totalCostUsd: null, numTurns: null },
      userMessageContent: 'x'.repeat(400),
      warnings: [],
      runtimeSessionId: null,
      endedAt: '2026-07-15T00:00:01.000Z',
    });
    expect(summary.outcome).toBe('cancelled');
    expect(summary.costUsd).toBeNull();
    expect(summary.durationMs).toBeNull(); // never started
    expect(summary.objective.length).toBeLessThanOrEqual(281); // excerpted
    expect(summary.objective.endsWith('…')).toBe(true);
  });
});
