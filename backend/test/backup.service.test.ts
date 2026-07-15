/**
 * B3-04 backup service: snapshot → gzip → sink, retention, freshness gauge,
 * failure degradation. Offline via the local sink + an injected clock.
 */

import { gunzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupService, utcStamp } from '../src/backup/service.js';
import { LocalSnapshotSink } from '../src/backup/localSink.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-bk-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A snapshot fn that writes deterministic bytes (stands in for VACUUM INTO). */
const fakeSnapshot =
  (payload: string) =>
  (destPath: string): void =>
    writeFileSync(destPath, payload);

function makeService(opts: {
  now: () => Date;
  intervalMs?: number;
  retention?: { recent: number; dailyDays: number };
  payload?: string;
  snapshot?: (p: string) => void;
}) {
  const sink = new LocalSnapshotSink(join(dir, 'snap'));
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const svc = new BackupService({
    snapshot: opts.snapshot ?? fakeSnapshot(opts.payload ?? 'DBBYTES'),
    sink,
    tmpDir: tmp,
    intervalMs: opts.intervalMs ?? 6 * 3600_000,
    now: opts.now,
    ...(opts.retention ? { retention: opts.retention } : {}),
    log: () => {},
  });
  return { svc, sink };
}

describe('BackupService', () => {
  it('vacuums, gzips, and uploads a decompressible snapshot', async () => {
    const { svc, sink } = makeService({ now: () => new Date('2026-07-15T18:00:00Z'), payload: 'HELLO-DB' });
    const key = await svc.snapshotOnce();
    expect(key).toBe('snapshots/2026-07-15T180000Z.sqlite.gz');
    const stored = await sink.get(key!);
    expect(gunzipSync(stored).toString()).toBe('HELLO-DB');
  });

  it('freshness: null before first snapshot, fresh right after, degraded past 2x interval', async () => {
    let clock = new Date('2026-07-15T00:00:00Z');
    const { svc } = makeService({ now: () => clock, intervalMs: 3600_000 });
    expect(svc.freshness()).toMatchObject({ lastSnapshotAt: null, degraded: true });

    await svc.snapshotOnce();
    expect(svc.freshness()).toMatchObject({
      lastSnapshotAt: '2026-07-15T00:00:00.000Z',
      degraded: false,
    });

    clock = new Date('2026-07-15T01:30:00Z'); // 1.5x interval — still fresh
    expect(svc.freshness().degraded).toBe(false);
    clock = new Date('2026-07-15T02:30:00Z'); // 2.5x interval — degraded
    expect(svc.freshness().degraded).toBe(true);
  });

  it('a snapshot failure degrades the gauge and never throws', async () => {
    const clock = new Date('2026-07-15T00:00:00Z');
    const { svc } = makeService({
      now: () => clock,
      intervalMs: 3600_000,
      snapshot: () => {
        throw new Error('disk full');
      },
    });
    const key = await svc.snapshotOnce();
    expect(key).toBeNull();
    expect(svc.freshness()).toMatchObject({ lastSnapshotAt: null, lastError: 'disk full' });
  });

  it('retention keeps the newest N plus one-per-day for M days, deletes the rest', async () => {
    // 3 snapshots today (six-hourly) + one each on 3 prior days
    const stamps = [
      '2026-07-15T18:00:00Z',
      '2026-07-15T12:00:00Z',
      '2026-07-15T06:00:00Z',
      '2026-07-14T06:00:00Z',
      '2026-07-13T06:00:00Z',
      '2026-07-12T06:00:00Z',
    ];
    let i = 0;
    const clock = () => new Date(stamps[i]!);
    const { svc, sink } = makeService({ now: clock, retention: { recent: 2, dailyDays: 2 } });
    for (i = 0; i < stamps.length; i++) await svc.snapshotOnce();

    const kept = (await sink.list('snapshots')).map((s) => s.key.split('/')[1]).sort();
    // recent 2 = the two newest (18:00 and 12:00 on the 15th); daily-2 = newest
    // of the two most-recent days: 15th (already the 18:00) and 14th.
    expect(kept).toEqual([
      '2026-07-14T060000Z.sqlite.gz',
      '2026-07-15T120000Z.sqlite.gz',
      '2026-07-15T180000Z.sqlite.gz',
    ]);
  });

  it('a prune failure after a successful upload keeps the snapshot green', async () => {
    const clock = new Date('2026-07-15T00:00:00Z');
    const sink = new LocalSnapshotSink(join(dir, 'snap'));
    const tmp = join(dir, 'tmp');
    mkdirSync(tmp, { recursive: true });
    // list() throws → prune() throws; the put already succeeded
    sink.list = () => Promise.reject(new Error('list transient'));
    const svc = new BackupService({
      snapshot: fakeSnapshot('OK'),
      sink,
      tmpDir: tmp,
      intervalMs: 3600_000,
      now: () => clock,
      log: () => {},
    });
    const key = await svc.snapshotOnce();
    expect(key).toBe('snapshots/2026-07-15T000000Z.sqlite.gz'); // snapshot stands
    expect(svc.freshness()).toMatchObject({
      lastSnapshotAt: '2026-07-15T00:00:00.000Z',
      degraded: false,
      lastError: null,
    });
  });

  it('utcStamp is path-safe and lexicographically time-sortable', () => {
    const a = utcStamp(new Date('2026-07-15T06:00:00Z'));
    const b = utcStamp(new Date('2026-07-15T18:00:00Z'));
    expect(a).toBe('2026-07-15T060000Z');
    expect(a < b).toBe(true);
    expect(a).not.toContain(':');
  });
});
