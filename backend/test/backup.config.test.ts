/** B3-04 backup config matrix (config/backup.ts). */

import { describe, expect, it } from 'vitest';
import { BackupConfigError, resolveBackupConfig } from '../src/config/backup.js';

const R2 = {
  BACKUP_SINK: 'r2',
  R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/',
  R2_BUCKET: 'test-bucket',
  R2_ACCESS_KEY_ID: 'AK-value',
  R2_SECRET_ACCESS_KEY: 'SK-value',
};

describe('resolveBackupConfig', () => {
  it('defaults to none (a bare boot needs no storage)', () => {
    expect(resolveBackupConfig({})).toEqual({ kind: 'none' });
  });

  it('local requires a dir; carries the interval', () => {
    expect(resolveBackupConfig({ BACKUP_SINK: 'local', BACKUP_LOCAL_DIR: '/snap' })).toEqual({
      kind: 'local',
      dir: '/snap',
      intervalMs: 6 * 3600_000,
    });
    expect(() => resolveBackupConfig({ BACKUP_SINK: 'local' })).toThrow(/BACKUP_LOCAL_DIR/);
  });

  it('r2 resolves and trims the endpoint trailing slash', () => {
    expect(resolveBackupConfig(R2)).toEqual({
      kind: 'r2',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'test-bucket',
      accessKeyId: 'AK-value',
      secretAccessKey: 'SK-value',
      intervalMs: 6 * 3600_000,
    });
  });

  it('r2 fails fast naming missing variables — never echoing values', () => {
    const err = (() => {
      try {
        resolveBackupConfig({ BACKUP_SINK: 'r2', R2_BUCKET: 'test-bucket' });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(BackupConfigError);
    expect(err!.message).toContain('R2_ENDPOINT');
    expect(err!.message).toContain('R2_ACCESS_KEY_ID');
    expect(err!.message).not.toContain('test-bucket'); // present value not echoed
  });

  it('honors a custom interval and rejects a non-positive one', () => {
    const cfg = resolveBackupConfig({ ...R2, BACKUP_INTERVAL_MS: '3600000' });
    expect(cfg.kind === 'r2' && cfg.intervalMs).toBe(3600_000);
    expect(() => resolveBackupConfig({ ...R2, BACKUP_INTERVAL_MS: '0' })).toThrow(BackupConfigError);
  });

  it('rejects an unknown sink', () => {
    expect(() => resolveBackupConfig({ BACKUP_SINK: 'gcs' })).toThrow(BackupConfigError);
  });
});
