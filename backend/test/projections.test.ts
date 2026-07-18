import { describe, expect, it } from 'vitest';
import {
  assembleAssistantText,
  deriveActivity,
  deriveRunSummary,
  deriveSegments,
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
    // every item now names the tool that produced it (L4 inline steps)
    expect(activity.items.map((i) => i.tool)).toEqual(['Bash', 'Write', 'Edit', 'WebFetch']);
  });

  it('surfaces every other tool as a generic step with its name and a best-effort hint', () => {
    const events = [
      ev(1, 'tool_use', { name: 'Grep', input: { pattern: 'TODO' } }),
      ev(2, 'tool_use', { name: 'Read', input: { file_path: '/w/a.ts' } }), // still a file step
      ev(3, 'tool_use', { name: 'WebFetch', input: { url: 'https://example/y' } }),
      ev(4, 'tool_use', { name: 'TodoWrite', input: {} }), // no hintable field
    ];
    const activity = deriveActivity(events);
    expect(activity.items.map((i) => ({ kind: i.kind, tool: i.tool, detail: i.detail }))).toEqual([
      { kind: 'tool', tool: 'Grep', detail: 'TODO' },
      { kind: 'file', tool: 'Read', detail: '/w/a.ts' },
      { kind: 'tool', tool: 'WebFetch', detail: 'https://example/y' },
      { kind: 'tool', tool: 'TodoWrite', detail: '' },
    ]);
    // generic tools stay out of the command/file/denial arrays (RunSummary is unchanged)
    expect(activity.commands).toEqual([]);
    expect(activity.files).toEqual(['/w/a.ts']);
    expect(activity.denials).toEqual([]);
  });
});

describe('assistant text assembly (06 §Message)', () => {
  it('concatenates only text blocks — thinking and tool results excluded', () => {
    expect(assembleAssistantText(EVENTS)).toBe('I will fix it.');
  });
});

describe('turn segments (A: text → tool → text bubbles)', () => {
  it('interleaves text runs and tool steps in order', () => {
    expect(deriveSegments(EVENTS)).toEqual([
      { kind: 'text', text: 'I will ' },
      { kind: 'command', detail: 'npm test', tool: 'Bash' },
      { kind: 'file', detail: '/w/a.ts', tool: 'Write' },
      { kind: 'file', detail: '/w/a.ts', tool: 'Edit' },
      { kind: 'denial', detail: 'WebFetch', tool: 'WebFetch' },
      { kind: 'text', text: 'fix it.' },
    ]);
    // the concatenated text segments equal the single-blob assembly (consistent
    // with `content`, which stays the fallback for a client that ignores segments)
    const text = deriveSegments(EVENTS)
      .filter((s): s is { kind: 'text'; text: string } => s.kind === 'text')
      .map((s) => s.text)
      .join('');
    expect(text).toBe(assembleAssistantText(EVENTS));
  });

  it('is empty for a run that produced neither text nor tools', () => {
    expect(deriveSegments([ev(1, 'started', {}), ev(2, 'exit', { exitCode: 0 })])).toEqual([]);
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
