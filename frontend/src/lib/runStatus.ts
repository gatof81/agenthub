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
