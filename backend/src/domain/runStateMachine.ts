/**
 * The Phase-1 run state machine — exactly the diagram in docs/05 §"Run state
 * machine". Every transition is one HubStore transaction (NFR-01, I-3); the
 * store's guarded updates call into this table so illegal transitions are
 * unrepresentable rather than merely discouraged.
 *
 * `awaiting_approval` is reserved for Phase 2+ (05) and deliberately absent.
 */

import type { RunState, TerminalRunState } from './types.js';

const LEGAL_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ['starting', 'cancelled'],
  starting: ['streaming', 'interrupted', 'failed'],
  streaming: ['completed', 'completed_with_denials', 'cancelled', 'failed', 'interrupted'],
  interrupted: ['completed', 'cancelled', 'failed'],
  completed: [],
  completed_with_denials: [],
  cancelled: [],
  failed: [],
};

export const TERMINAL_STATES: readonly TerminalRunState[] = [
  'completed',
  'completed_with_denials',
  'cancelled',
  'failed',
];

export const ACTIVE_STATES: readonly RunState[] = ['starting', 'streaming'];

export function isTerminal(state: RunState): state is TerminalRunState {
  return (TERMINAL_STATES as readonly RunState[]).includes(state);
}

export function isLegalTransition(from: RunState, to: RunState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly runId: string,
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super(`illegal run transition ${from} -> ${to} (run ${runId})`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Guarded-update mismatch: the row was not in the expected `from` state when
 * the transition ran (I-3 enforcement made loud, 09 §2).
 */
export class StaleStateError extends Error {
  constructor(
    readonly runId: string,
    readonly expected: RunState,
  ) {
    super(`run ${runId} was not in expected state ${expected}`);
    this.name = 'StaleStateError';
  }
}

export function assertLegalTransition(runId: string, from: RunState, to: RunState): void {
  if (!isLegalTransition(from, to)) throw new IllegalTransitionError(runId, from, to);
}
