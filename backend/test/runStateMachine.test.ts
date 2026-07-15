import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATES,
  assertLegalTransition,
  IllegalTransitionError,
  isLegalTransition,
  isTerminal,
  TERMINAL_STATES,
} from '../src/domain/runStateMachine.js';
import type { RunState } from '../src/domain/types.js';

const ALL: RunState[] = [
  'queued',
  'starting',
  'streaming',
  'completed',
  'completed_with_denials',
  'cancelled',
  'interrupted',
  'failed',
];

describe('run state machine (05)', () => {
  it('encodes exactly the 05 diagram', () => {
    const legal: Array<[RunState, RunState]> = [
      ['queued', 'starting'],
      ['queued', 'cancelled'],
      ['starting', 'streaming'],
      ['starting', 'interrupted'],
      ['starting', 'failed'],
      ['streaming', 'completed'],
      ['streaming', 'completed_with_denials'],
      ['streaming', 'cancelled'],
      ['streaming', 'failed'],
      ['streaming', 'interrupted'],
      ['interrupted', 'completed'],
      ['interrupted', 'cancelled'],
      ['interrupted', 'failed'],
    ];
    const legalSet = new Set(legal.map(([f, t]) => `${f}->${t}`));
    for (const from of ALL) {
      for (const to of ALL) {
        expect(isLegalTransition(from, to), `${from} -> ${to}`).toBe(
          legalSet.has(`${from}->${to}`),
        );
      }
    }
  });

  it('terminal states admit no transitions', () => {
    for (const from of TERMINAL_STATES) {
      for (const to of ALL) {
        expect(isLegalTransition(from, to)).toBe(false);
      }
      expect(isTerminal(from)).toBe(true);
    }
  });

  it('non-terminal states are not terminal', () => {
    for (const s of ['queued', 'starting', 'streaming', 'interrupted'] as RunState[]) {
      expect(isTerminal(s)).toBe(false);
    }
    expect(ACTIVE_STATES).toEqual(['starting', 'streaming']);
  });

  it('assertLegalTransition throws a typed error', () => {
    expect(() => assertLegalTransition('run_x', 'queued', 'streaming')).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertLegalTransition('run_x', 'queued', 'starting')).not.toThrow();
  });
});
