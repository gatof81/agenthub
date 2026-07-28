/**
 * The Task state machine (N5, ADR-009) — the dev → QA → human-approval flow.
 * Terminal success is `approved`; the two changes-requested states loop back to
 * implementing and are NOT terminal; `failed` is reachable from any live state.
 */

import { describe, expect, it } from 'vitest';
import type { TaskState } from '../src/domain/types.js';
import {
  isLegalTaskTransition,
  isTerminalTask,
  TERMINAL_TASK_STATES,
} from '../src/domain/taskStateMachine.js';

describe('task state machine (ADR-009)', () => {
  it('walks the happy path planning → … → approved', () => {
    const happy: TaskState[] = [
      'planning',
      'implementing',
      'qa_pending',
      'qa_running',
      'awaiting_human_approval',
      'approved',
    ];
    for (let i = 0; i < happy.length - 1; i++) {
      expect(isLegalTaskTransition(happy[i]!, happy[i + 1]!)).toBe(true);
    }
  });

  it('loops QA rejection back to implementing', () => {
    expect(isLegalTaskTransition('qa_running', 'changes_requested_by_qa')).toBe(true);
    expect(isLegalTaskTransition('changes_requested_by_qa', 'implementing')).toBe(true);
    // and a human requesting changes loops back too
    expect(isLegalTaskTransition('awaiting_human_approval', 'changes_requested_by_user')).toBe(true);
    expect(isLegalTaskTransition('changes_requested_by_user', 'implementing')).toBe(true);
  });

  it('only approved / rejected / failed / cancelled are terminal', () => {
    expect([...TERMINAL_TASK_STATES].sort()).toEqual(['approved', 'cancelled', 'failed', 'rejected']);
    expect(isTerminalTask('approved')).toBe(true);
    expect(isTerminalTask('rejected')).toBe(true);
    expect(isTerminalTask('failed')).toBe(true);
    expect(isTerminalTask('cancelled')).toBe(true); // owner cancel (#140)
    // the loop-back states are NOT terminal
    expect(isTerminalTask('changes_requested_by_qa')).toBe(false);
    expect(isTerminalTask('changes_requested_by_user')).toBe(false);
    expect(isTerminalTask('awaiting_human_approval')).toBe(false);
  });

  it('rejects illegal jumps (no skipping QA; no exit from a terminal state)', () => {
    expect(isLegalTaskTransition('implementing', 'approved')).toBe(false); // never skip QA + approval
    expect(isLegalTaskTransition('planning', 'qa_running')).toBe(false);
    expect(isLegalTaskTransition('approved', 'implementing')).toBe(false); // terminal is terminal
    expect(isLegalTaskTransition('rejected', 'planning')).toBe(false);
    expect(isLegalTaskTransition('qa_running', 'approved')).toBe(false); // approval is the owner's, not QA's
  });

  it('failed is reachable from every live state', () => {
    const live: TaskState[] = [
      'planning',
      'implementing',
      'qa_pending',
      'qa_running',
      'changes_requested_by_qa',
      'awaiting_human_approval',
      'changes_requested_by_user',
    ];
    for (const s of live) expect(isLegalTaskTransition(s, 'failed')).toBe(true);
  });
});
