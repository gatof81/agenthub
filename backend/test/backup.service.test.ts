/**
 * B3-04 backup service: snapshot → gzip → sink, retention, freshness gauge,
 * failure degradation. Offline via the local sink + an injected clock.
 */

import { gunzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupService, parseUtcStamp, utcStamp } from '../src/backup/service.js';
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
  initialDelayMs?: number;
  retention?: { recent: number; dailyDays: number };
  payload?: string;
  snapshot?: (p: string) => void;
  suffix?: () => string;
}) {
  const sink = new LocalSnapshotSink(join(dir, 'snap'));
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const svc = new BackupService({
    snapshot: opts.snapshot ?? fakeSnapshot(opts.payload ?? 'DBBYTES'),
    sink,
    tmpDir: tmp,
    intervalMs: opts.intervalMs ?? 6 * 3600_000,
    ...(opts.initialDelayMs !== undefined ? { initialDelayMs: opts.initialDelayMs } : {}),
    now: opts.now,
    ...(opts.retention ? { retention: opts.retention } : {}),
    // deterministic keys (#141): the de-collision suffix is injected
    suffix: opts.suffix ?? (() => 'aaaa'),
    log: () => {},
  });
  return { svc, sink };
}

describe('BackupService', () => {
  it('vacuums, gzips, and uploads a decompressible snapshot', async () => {
    const { svc, sink } = makeService({ now: () => new Date('2026-07-15T18:00:00Z'), payload: 'HELLO-DB' });
    const key = await svc.snapshotOnce();
    expect(key).toBe('snapshots/2026-07-15T180000Z-aaaa.sqlite.gz');
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
      '2026-07-14T060000Z-aaaa.sqlite.gz',
      '2026-07-15T120000Z-aaaa.sqlite.gz',
      '2026-07-15T180000Z-aaaa.sqlite.gz',
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
      suffix: () => 'aaaa',
      log: () => {},
    });
    const key = await svc.snapshotOnce();
    expect(key).toBe('snapshots/2026-07-15T000000Z-aaaa.sqlite.gz'); // snapshot stands
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

  it('two snapshots in the same second never overwrite each other (#141)', async () => {
    // the deploy race: a scheduled tick and the shutdown snapshot land together
    const suffixes = ['0001', '0002'];
    let s = 0;
    const { svc, sink } = makeService({
      now: () => new Date('2026-07-15T18:00:00Z'),
      suffix: () => suffixes[s++]!,
    });
    const first = await svc.snapshotOnce();
    const second = await svc.snapshotOnce();
    expect(first).not.toBe(second);
    const keys = (await sink.list('snapshots')).map((x) => x.key).sort();
    expect(keys).toEqual([
      'snapshots/2026-07-15T180000Z-0001.sqlite.gz',
      'snapshots/2026-07-15T180000Z-0002.sqlite.gz',
    ]);
    // the suffix is invisible to the freshness boot seed (fixed-prefix parse)
    await svc.seedFromSink();
    expect(svc.freshness().lastSnapshotAt).toBe('2026-07-15T18:00:00.000Z');
  });

  it('parseUtcStamp is the inverse of utcStamp (round-trip)', () => {
    const d = new Date('2026-07-15T18:30:45Z');
    expect(parseUtcStamp(utcStamp(d))).toEqual(d);
    expect(parseUtcStamp('2026-07-15T060000Z')).toEqual(new Date('2026-07-15T06:00:00Z'));
    // the stamp → date → stamp loop is stable
    expect(utcStamp(parseUtcStamp('2026-07-15T060000Z'))).toBe('2026-07-15T060000Z');
  });

  it('seeds freshness from the newest existing snapshot in the sink at boot (OPS-02)', async () => {
    const clock = new Date('2026-07-15T06:05:00Z');
    const { svc, sink } = makeService({ now: () => clock, intervalMs: 3600_000 });
    // two snapshots from a prior run land straight in the sink (no boot yet)
    await sink.put('snapshots/2026-07-15T000000Z.sqlite.gz', new Uint8Array([1]));
    await sink.put('snapshots/2026-07-15T060000Z.sqlite.gz', new Uint8Array([2]));

    // before seeding the gauge reads null/degraded, as it did from boot
    expect(svc.freshness()).toMatchObject({ lastSnapshotAt: null, degraded: true });

    await svc.seedFromSink();
    // adopts the NEWEST (06:00), 5 min old under a 1h interval → fresh, not null
    expect(svc.freshness()).toMatchObject({
      lastSnapshotAt: '2026-07-15T06:00:00.000Z',
      degraded: false,
    });
  });

  it('boot seed is best-effort: a list() failure leaves the gauge degraded, never throws', async () => {
    const clock = new Date('2026-07-15T06:05:00Z');
    const { svc, sink } = makeService({ now: () => clock, intervalMs: 3600_000 });
    sink.list = () => Promise.reject(new Error('sink offline'));
    await expect(svc.seedFromSink()).resolves.toBeUndefined();
    expect(svc.freshness()).toMatchObject({ lastSnapshotAt: null, degraded: true });
  });

  it('start() fires a prompt first snapshot without waiting a full interval (OPS-01)', async () => {
    const clock = new Date('2026-07-15T06:00:00Z');
    const { svc, sink } = makeService({
      now: () => clock,
      intervalMs: 6 * 3600_000,
      initialDelayMs: 1,
    });
    expect(await sink.list('snapshots')).toHaveLength(0);

    svc.start();
    try {
      // the scheduled prompt snapshot (delay 1ms) lands well before +intervalMs
      await vi.waitFor(async () => {
        expect(await sink.list('snapshots')).toHaveLength(1);
      });
      expect(svc.freshness()).toMatchObject({
        lastSnapshotAt: '2026-07-15T06:00:00.000Z',
        degraded: false,
      });
    } finally {
      svc.stop();
    }
  });
});

describe('deadline-bounded shutdown snapshot (B3-09)', () => {
  /**
   * The bug this pins: `snapshotOnce` swallows *failures*, but a sink whose
   * put never SETTLES is not a failure — it never returns. main.ts awaited it
   * unbounded on SIGTERM, so a wedged sink hung shutdown forever and logged
   * nothing (observed against R2 under `tsx`, where the shutdown snapshot's
   * first request never completes).
   */
  const sinkWith = (put: () => Promise<void>) => ({
    put,
    get: () => Promise.resolve(new Uint8Array()),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  });

  const serviceWithSink = (sink: ReturnType<typeof sinkWith>) => {
    const tmp = join(dir, 'tmp-b');
    mkdirSync(tmp, { recursive: true });
    return new BackupService({
      snapshot: fakeSnapshot('DBBYTES'),
      sink,
      tmpDir: tmp,
      intervalMs: 6 * 3600_000,
      suffix: () => 'aaaa', // deterministic keys (doc 13 par-6), like makeService
      log: () => {},
    });
  };

  it('a put that never settles resolves to timeout instead of hanging', async () => {
    const svc = serviceWithSink(sinkWith(() => new Promise<void>(() => {})));
    const r = await svc.snapshotOnceBounded(30);
    expect(r).toEqual({ outcome: 'timeout' });
  });

  it('a healthy snapshot returns its key, not a timeout', async () => {
    const svc = serviceWithSink(sinkWith(() => Promise.resolve()));
    const r = await svc.snapshotOnceBounded(5_000);
    expect(r.outcome).toBe('ok');
    expect(r.outcome === 'ok' && r.key).toMatch(/^snapshots\/.*\.sqlite\.gz$/);
  });

  it('a failing put is reported as failed, distinctly from a timeout', async () => {
    const svc = serviceWithSink(sinkWith(() => Promise.reject(new Error('R2 502'))));
    const r = await svc.snapshotOnceBounded(5_000);
    expect(r).toEqual({ outcome: 'failed' });
  });

  it('freshness stays degraded after a timeout — the operator sees it (OPS-02)', async () => {
    const svc = serviceWithSink(sinkWith(() => new Promise<void>(() => {})));
    await svc.snapshotOnceBounded(30);
    expect(svc.freshness().degraded).toBe(true);
    expect(svc.freshness().lastSnapshotAt).toBeNull();
  });
});
