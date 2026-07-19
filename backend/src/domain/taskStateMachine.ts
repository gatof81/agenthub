/**
 * The Task state machine (ADR-009, N5) — the developer → QA → human-approval
 * lifecycle, exactly one hardcoded flow (not a workflow engine, 18 §6). Like
 * the run machine, the store's guarded updates call into this table so illegal
 * transitions are unrepresentable rather than merely discouraged.
 *
 *   planning → implementing → qa_pending → qa_running
 *     → (changes_requested_by_qa → implementing)*
 *     → awaiting_human_approval
 *       → approved | (changes_requested_by_user → implementing) | rejected
 *
 * Terminal SUCCESS is `approved` — never the implementer finishing, never QA
 * passing alone (ADR-009). `failed` is reachable from any non-terminal state
 * (an unrecoverable run). The two `changes_requested_*` states loop back to
 * `implementing` and are NOT terminal.
 */

import type { TaskState, TerminalTaskState } from './types.js';

const LEGAL_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  planning: ['implementing', 'failed'],
  implementing: ['qa_pending', 'failed'],
  qa_pending: ['qa_running', 'failed'],
  qa_running: ['awaiting_human_approval', 'changes_requested_by_qa', 'failed'],
  changes_requested_by_qa: ['implementing', 'failed'],
  awaiting_human_approval: ['approved', 'changes_requested_by_user', 'rejected', 'failed'],
  changes_requested_by_user: ['implementing', 'failed'],
  approved: [],
  rejected: [],
  failed: [],
};

export const TERMINAL_TASK_STATES: readonly TerminalTaskState[] = ['approved', 'rejected', 'failed'];

export function isTerminalTask(state: TaskState): state is TerminalTaskState {
  return (TERMINAL_TASK_STATES as readonly TaskState[]).includes(state);
}

export function isLegalTaskTransition(from: TaskState, to: TaskState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export class IllegalTaskTransitionError extends Error {
  constructor(
    readonly taskId: string,
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`illegal task transition ${from} -> ${to} (task ${taskId})`);
    this.name = 'IllegalTaskTransitionError';
  }
}

/** Guarded-update mismatch: the row was not in the expected `from` state (I-3). */
export class StaleTaskStateError extends Error {
  constructor(
    readonly taskId: string,
    readonly expected: TaskState,
  ) {
    super(`task ${taskId} was not in expected state ${expected}`);
    this.name = 'StaleTaskStateError';
  }
}

export function assertLegalTaskTransition(taskId: string, from: TaskState, to: TaskState): void {
  if (!isLegalTaskTransition(from, to)) throw new IllegalTaskTransitionError(taskId, from, to);
}
