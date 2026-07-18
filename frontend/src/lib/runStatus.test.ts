/**
 * Run-status reconciliation: the pure decision behind "never stuck on
 * Working…". The thread orchestration (refetch + watchdog) is glue over this;
 * the logic that matters — settle a missed terminal frame from the store, but
 * never clobber a fresher live run — is tested here, no DOM.
 */

import { describe, expect, it } from 'vitest';
import {
  describeRunOutcome,
  isTerminalRun,
  reconcileLiveRun,
  TERMINAL_RUN_STATES,
  type LiveRun,
} from './runStatus.js';

const live = (over: Partial<LiveRun> = {}): LiveRun => ({
  runId: 'run_1',
  state: 'streaming',
  deltaText: 'partial answer',
  ...over,
});

describe('isTerminalRun', () => {
  it('classifies exactly the four terminal states', () => {
    expect(TERMINAL_RUN_STATES).toEqual([
      'completed',
      'completed_with_denials',
      'cancelled',
      'failed',
    ]);
    for (const s of TERMINAL_RUN_STATES) expect(isTerminalRun(s)).toBe(true);
    for (const s of ['queued', 'starting', 'streaming', 'interrupted'] as const) {
      expect(isTerminalRun(s)).toBe(false);
    }
  });
});

describe('reconcileLiveRun', () => {
  it('retires the indicator when the store says the run is terminal (the missed-frame fix)', () => {
    for (const s of TERMINAL_RUN_STATES) {
      expect(reconcileLiveRun(live(), { id: 'run_1', state: s })).toBeNull();
    }
  });

  it('syncs a stale non-terminal state (starting → streaming) without dropping accumulated text', () => {
    const next = reconcileLiveRun(live({ state: 'starting', deltaText: 'so far' }), {
      id: 'run_1',
      state: 'streaming',
    });
    expect(next).toEqual({ runId: 'run_1', state: 'streaming', deltaText: 'so far' });
  });

  it('leaves a genuinely still-running (quiet) turn untouched', () => {
    const current = live({ state: 'streaming' });
    // same state → identity, so React bails out of a re-render
    expect(reconcileLiveRun(current, { id: 'run_1', state: 'streaming' })).toBe(current);
  });

  it('keeps interrupted active (non-terminal) so the watchdog keeps polling to its real end', () => {
    const current = live({ state: 'streaming' });
    const next = reconcileLiveRun(current, { id: 'run_1', state: 'interrupted' });
    expect(next).toEqual({ runId: 'run_1', state: 'interrupted', deltaText: 'partial answer' });
  });

  it('never clobbers a fresher live run when the store read is for a different run', () => {
    const current = live({ runId: 'run_2', state: 'streaming' });
    // a stale REST read for run_1 (already finished) must not touch run_2
    expect(reconcileLiveRun(current, { id: 'run_1', state: 'completed' })).toBe(current);
  });

  it('is a no-op when there is no live run', () => {
    expect(reconcileLiveRun(null, { id: 'run_1', state: 'completed' })).toBeNull();
  });
});

describe('describeRunOutcome', () => {
  it('returns null for non-terminal runs (the live badge owns the display)', () => {
    for (const s of ['queued', 'starting', 'streaming', 'interrupted'] as const) {
      expect(describeRunOutcome({ state: s })).toBeNull();
    }
  });

  it('translates the failed error taxonomy to human labels, keeping the detail as a hint', () => {
    expect(describeRunOutcome({ state: 'failed', errorCode: 'budget_exceeded', errorDetail: '$2 cap crossed' })).toEqual(
      { state: 'failed', tone: 'error', label: 'Failed — Budget exceeded', hint: '$2 cap crossed' },
    );
    expect(describeRunOutcome({ state: 'failed', errorCode: 'run_timeout' })).toMatchObject({
      label: 'Failed — Timed out',
      hint: 'you can re-send',
    });
  });

  it('passes an unmapped error code through instead of swallowing it', () => {
    expect(describeRunOutcome({ state: 'failed', errorCode: 'some_new_code' })).toMatchObject({
      tone: 'error',
      label: 'Failed — some_new_code',
    });
  });

  it('names what a cancel killed and marks cost unknown', () => {
    expect(describeRunOutcome({ state: 'cancelled', killOutcome: 'killed' })).toEqual({
      state: 'cancelled',
      tone: 'warn',
      label: 'Cancelled (killed)',
      hint: 'cost unknown',
    });
  });

  it('counts blocked tool calls on a completed-with-denials run', () => {
    expect(describeRunOutcome({ state: 'completed_with_denials' }, { denialCount: 1, costUsd: null })).toMatchObject({
      tone: 'warn',
      label: 'Completed — 1 tool call blocked',
    });
    expect(describeRunOutcome({ state: 'completed_with_denials' }, { denialCount: 3, costUsd: null })).toMatchObject({
      label: 'Completed — 3 tool calls blocked',
    });
  });

  it('shows cost on a plain completed run when the summary has it', () => {
    expect(describeRunOutcome({ state: 'completed' }, { denialCount: 0, costUsd: 0.0321 })).toEqual({
      state: 'completed',
      tone: 'ok',
      label: 'Completed',
      hint: '$0.0321',
    });
    // no summary → no cost hint, still a clear terminal chip
    expect(describeRunOutcome({ state: 'completed' })).toEqual({
      state: 'completed',
      tone: 'ok',
      label: 'Completed',
    });
  });
});
