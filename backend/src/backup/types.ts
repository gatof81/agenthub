/**
 * Snapshot sink port (B3-04, ADR-002 R2 durability role, 09 §5). The backup
 * service depends only on this; implementations are the local-file sink
 * (offline/tests) and the R2 S3 sink (real durability). Keys are opaque
 * strings (`snapshots/<utc-stamp>.sqlite.gz`).
 */

export interface StoredSnapshot {
  key: string;
  size: number;
}

export interface SnapshotSink {
  put(key: string, body: Uint8Array): Promise<void>;
  list(prefix: string): Promise<StoredSnapshot[]>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

/** Operator-visible freshness (OPS-02); surfaced on GET /api/health. */
export interface SnapshotFreshness {
  lastSnapshotAt: string | null;
  /** true once the newest snapshot is older than 2× the interval. */
  degraded: boolean;
  lastError: string | null;
}
