/**
 * Process-local metrics (B3-07, 14 §2). Counters accumulate over process
 * lifetime; gauges are computed on read (active runs / queue depth from the
 * store, DB/WAL size from the filesystem) so there is no drift between the
 * gauge and the source of truth. Single-replica — no external TSDB (ADR-002).
 */

import { statSync } from 'node:fs';
import type { Metrics } from '../domain/ports.js';
import type { RunState } from '../domain/types.js';

export interface MetricsSnapshot {
  runTransitions: Record<string, number>;
  seamErrors: number;
  activeRuns: number;
  queuedRuns: number;
  dbBytes: number | null;
  walBytes: number | null;
}

export interface CountingMetricsDeps {
  /** counts of non-terminal runs, read live from the store (14 §2 gauges). */
  activeRuns: () => number;
  queuedRuns: () => number;
  /** SQLite file path, for the size gauges (OPS-05); null when `:memory:`. */
  dbPath: string | null;
}

export class CountingMetrics implements Metrics {
  private readonly transitions = new Map<RunState, number>();
  private seamErrors = 0;

  constructor(private readonly deps: CountingMetricsDeps) {}

  runTransition(to: RunState): void {
    this.transitions.set(to, (this.transitions.get(to) ?? 0) + 1);
  }

  seamError(): void {
    this.seamErrors += 1;
  }

  private sizeOf(path: string): number | null {
    try {
      return statSync(path).size;
    } catch {
      return null; // not created yet, or absent (WAL between checkpoints)
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      runTransitions: Object.fromEntries(this.transitions),
      seamErrors: this.seamErrors,
      activeRuns: this.deps.activeRuns(),
      queuedRuns: this.deps.queuedRuns(),
      dbBytes: this.deps.dbPath ? this.sizeOf(this.deps.dbPath) : null,
      walBytes: this.deps.dbPath ? this.sizeOf(`${this.deps.dbPath}-wal`) : null,
    };
  }
}
