/**
 * Run-status reconciliation (UX-03, NFR-07). The thread's "Working…" indicator
 * is driven by `liveRun`, an in-memory accumulation of live SSE frames. The
 * terminal `run.state` frame carries no SSE replay id and is NOT replayable
 * (the broadcaster only ids replayable events; the frame still identifies its
 * run via `runId` in the payload — it just has no Last-Event-ID cursor), so a
 * socket drop around finalize — or simply
 * having no subscriber connected at that instant — loses it, and the UI would
 * sit on "Working…" forever for a run that has finished.
 *
 * The store is the source of truth (NFR-07): on every (re)connect and on an
 * idle watchdog the thread re-reads the authoritative run over REST and settles
 * the indicator with `reconcileLiveRun`. This is the documented recovery path
 * for the non-replayable state/summary events (08 §3), applied to the one place
 * that previously ignored it — the live-run indicator.
 */

import type { RunState } from './api.js';

export const TERMINAL_RUN_STATES: RunState[] = [
  'completed',
  'completed_with_denials',
  'cancelled',
  'failed',
];

export function isTerminalRun(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

export interface LiveRun {
  runId: string;
  state: RunState;
  deltaText: string;
  killOutcome?: string;
  error?: string;
}

/** The authoritative fields the reconcile needs from a REST `GET /api/runs/:id`. */
export interface AuthoritativeRun {
  id: string;
  state: RunState;
  errorCode?: string | null;
  killOutcome?: string | null;
}

/**
 * Settle the in-memory live run against the store's authoritative state for the
 * SAME run. Returns the next live-run value:
 *
 * - `null` once the run is terminal — the "Working…" indicator is retired even
 *   if its terminal SSE frame was missed (the core "stuck on working" fix).
 * - otherwise the live run with `state` (and the error/kill fields) synced to
 *   the store, so the badge is never staler than the truth (e.g. `starting →
 *   streaming`, or a genuinely still-running turn that has just gone quiet).
 *
 * A mismatched id — the store reports a different (newer) run than the one the
 * UI is tracking — leaves the live run untouched: reconciling a stale REST read
 * against a fresher live run must never clobber it.
 */
export function reconcileLiveRun(current: LiveRun | null, run: AuthoritativeRun): LiveRun | null {
  if (!current || current.runId !== run.id) return current;
  if (isTerminalRun(run.state)) return null;
  if (run.state === current.state) return current;
  return { ...current, state: run.state };
}

/**
 * Human labels for the error taxonomy (08 §6). A `failed` run carries its cause
 * as an `errorCode` — `budget_exceeded`, `run_timeout` are not run states, they
 * are codes on `failed` (orchestrator) — which the UI otherwise shows as the
 * raw slug. An unmapped code falls through to itself so a new backend code is
 * never swallowed, just unstyled.
 */
const ERROR_LABELS: Record<string, string> = {
  budget_exceeded: 'Budget exceeded',
  run_timeout: 'Timed out',
  max_turns: 'Reached the turn limit',
  exec_refused: 'Runtime refused the run',
  seam_unavailable: 'Runtime unavailable',
};

export interface RunOutcome {
  /** drives the `state-*` colour class, reused from the live badge palette */
  state: RunState;
  tone: 'ok' | 'warn' | 'error';
  label: string;
  /** secondary, muted: the error detail, the re-send affordance, a cost */
  hint?: string;
}

/**
 * The persistent terminal chip (UX-03, 11 §6). Today a terminal `run.state`
 * flashes in the live badge and then vanishes when the live run is retired, so
 * a `failed (budget_exceeded)` or a `cancelled` leaves the thread with no
 * durable trace of how the turn ended — the code survives only in the
 * closed-by-default inspector. This derives, from the authoritative run (+ its
 * summary for cost/denials), a labelled outcome the thread pins under the turn.
 *
 * Returns `null` for a non-terminal run: while a run is active the live badge
 * owns the display, and this must not compete with it.
 */
export function describeRunOutcome(
  run: {
    state: RunState;
    errorCode?: string | null;
    errorDetail?: string | null;
    killOutcome?: string | null;
  },
  summary?: { denialCount: number; costUsd: number | null } | null,
): RunOutcome | null {
  switch (run.state) {
    case 'completed':
      return {
        state: run.state,
        tone: 'ok',
        label: 'Completed',
        ...(summary && summary.costUsd !== null ? { hint: `$${summary.costUsd.toFixed(4)}` } : {}),
      };
    case 'completed_with_denials': {
      const n = summary?.denialCount ?? 0;
      return {
        state: run.state,
        tone: 'warn',
        label: n > 0 ? `Completed — ${n} tool call${n === 1 ? '' : 's'} blocked` : 'Completed with denials',
        hint: 'see activity',
      };
    }
    case 'cancelled':
      return {
        state: run.state,
        tone: 'warn',
        label: `Cancelled${run.killOutcome ? ` (${run.killOutcome})` : ''}`,
        hint: 'cost unknown',
      };
    case 'failed': {
      // errorCode is nullable (Run.errorCode): with no code, the label is a
      // bare "Failed", never "Failed — Failed".
      const friendly = run.errorCode ? (ERROR_LABELS[run.errorCode] ?? run.errorCode) : null;
      return {
        state: run.state,
        tone: 'error',
        label: friendly ? `Failed — ${friendly}` : 'Failed',
        hint: run.errorDetail ?? 'you can re-send',
      };
    }
    default:
      return null;
  }
}
