/**
 * Backup service (B3-04, OPS-01/02, R-16): takes a consistent SQLite
 * snapshot via `VACUUM INTO` (never a raw copy of a live WAL db, 09 §5),
 * gzips it, uploads it through the sink, prunes by retention, and tracks
 * freshness. A failure logs loudly and NEVER crashes the process — the
 * Hub keeps serving; the freshness gauge goes degraded so the operator
 * sees it (OPS-02).
 */

import { gzipSync } from 'node:zlib';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SnapshotFreshness, SnapshotSink } from './types.js';

const SNAPSHOT_PREFIX = 'snapshots';

/** Verdict of a deadline-bounded snapshot (B3-09) — always loggable. */
export type ShutdownSnapshotOutcome =
  | { outcome: 'ok'; key: string }
  | { outcome: 'failed' }
  | { outcome: 'timeout' };

export interface BackupServiceDeps {
  /** Runs `VACUUM INTO destPath` against the live db (wired from SqliteHubStore). */
  snapshot: (destPath: string) => void;
  sink: SnapshotSink;
  /** Scratch dir for the pre-upload vacuum file. */
  tmpDir: string;
  /** Snapshot cadence; freshness degrades past 2× this. */
  intervalMs: number;
  now?: () => Date;
  /** Retention: keep the most-recent N snapshots + one per day for M days. */
  retention?: { recent: number; dailyDays: number };
  log?: (msg: string) => void;
}

/** `2026-07-15T18:30:00.000Z` → `2026-07-15T183000Z` (sortable, path-safe). */
export function utcStamp(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace(/[:]/g, '')}Z`;
}

/** Day bucket of a snapshot key, e.g. `snapshots/2026-07-15T183000Z...` → `2026-07-15`. */
function dayOf(key: string): string {
  const base = key.slice(key.lastIndexOf('/') + 1);
  return base.slice(0, 10);
}

export class BackupService {
  private readonly now: () => Date;
  private readonly retention: { recent: number; dailyDays: number };
  private readonly log: (msg: string) => void;
  private lastSnapshotAt: Date | null = null;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: BackupServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.retention = deps.retention ?? { recent: 8, dailyDays: 14 };
    // eslint-disable-next-line no-console -- operator-visible backup warnings (never payload data, SEC-05)
    this.log = deps.log ?? ((m) => console.warn(`[backup] ${m}`));
  }

  /** Take one snapshot end-to-end. Resolves to the key, or null on failure. */
  async snapshotOnce(): Promise<string | null> {
    const stamp = utcStamp(this.now());
    const tmpPath = join(this.deps.tmpDir, `hub-${stamp}.sqlite`);
    const key = `${SNAPSHOT_PREFIX}/${stamp}.sqlite.gz`;
    try {
      this.deps.snapshot(tmpPath);
      const gz = gzipSync(readFileSync(tmpPath));
      await this.deps.sink.put(key, new Uint8Array(gz));
      // the snapshot is durable once put returns — a later prune failure
      // must NOT report the snapshot itself as failed (freshness stays green)
      this.lastSnapshotAt = this.now();
      this.lastError = null;
      try {
        await this.prune();
      } catch (err) {
        this.log(
          `retention prune failed (snapshot uploaded): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return key;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log(`snapshot failed: ${this.lastError}`); // loud, never throws upward
      return null;
    } finally {
      rmSync(tmpPath, { force: true });
    }
  }

  /**
   * `snapshotOnce` bounded by a deadline (B3-09): a sink that wedges must
   * not hang the process forever. `snapshotOnce` already swallows failures,
   * but a put that never settles is not a failure it can catch — it simply
   * never returns, and an unbounded await of it left shutdown hung with an
   * empty log (observed against R2 under `tsx`). The caller gets a verdict
   * either way, so the outcome is always loggable.
   *
   * The snapshot is abandoned, not cancelled: if the put later succeeds the
   * object still lands in the sink. That is harmless (retention prunes it)
   * and is the honest trade — the alternative is holding shutdown open.
   */
  async snapshotOnceBounded(timeoutMs: number): Promise<ShutdownSnapshotOutcome> {
    const timedOut = Symbol('timeout');
    const deadline = new Promise<typeof timedOut>((resolve) => {
      setTimeout(() => resolve(timedOut), timeoutMs).unref();
    });
    const result = await Promise.race([this.snapshotOnce(), deadline]);
    if (result === timedOut) return { outcome: 'timeout' };
    if (result === null) return { outcome: 'failed' };
    return { outcome: 'ok', key: result };
  }

  /** Retention: keep the newest `recent`, plus the newest per day for `dailyDays`. */
  private async prune(): Promise<void> {
    const all = (await this.deps.sink.list(SNAPSHOT_PREFIX))
      .map((s) => s.key)
      .sort()
      .reverse(); // newest first (keys are lexicographically time-sortable)
    const keep = new Set<string>(all.slice(0, this.retention.recent));
    const seenDays = new Set<string>();
    for (const key of all) {
      const day = dayOf(key);
      if (!seenDays.has(day) && seenDays.size < this.retention.dailyDays) {
        seenDays.add(day);
        keep.add(key); // newest snapshot of this day
      }
    }
    for (const key of all) {
      if (!keep.has(key)) {
        try {
          await this.deps.sink.delete(key);
        } catch (err) {
          this.log(`retention delete of ${key} failed: ${(err as Error).message}`);
        }
      }
    }
  }

  freshness(): SnapshotFreshness {
    const last = this.lastSnapshotAt;
    const degraded =
      last === null || this.now().getTime() - last.getTime() > 2 * this.deps.intervalMs;
    return {
      lastSnapshotAt: last ? last.toISOString() : null,
      degraded,
      lastError: this.lastError,
    };
  }

  /** Periodic snapshots; the first fires one interval in (boot already has the db). */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.snapshotOnce(), this.deps.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
