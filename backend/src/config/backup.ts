/**
 * Backup config resolution (B3-04): `BACKUP_SINK=none|local|r2`. `r2`
 * requires the endpoint/bucket/credentials up front (fail fast, naming
 * missing VARIABLES, never echoing values — SEC-04). `none` (default)
 * disables backups so a bare dev boot needs no storage.
 */

export class BackupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupConfigError';
  }
}

export interface NoBackupConfig {
  kind: 'none';
}
export interface LocalBackupConfig {
  kind: 'local';
  dir: string;
  intervalMs: number;
}
export interface R2BackupConfig {
  kind: 'r2';
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  intervalMs: number;
}
export type BackupConfig = NoBackupConfig | LocalBackupConfig | R2BackupConfig;

const R2_REQUIRED = [
  'R2_ENDPOINT',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

const DEFAULT_INTERVAL_MS = 6 * 3600_000; // 09 §5

export function resolveBackupConfig(env: Record<string, string | undefined>): BackupConfig {
  const kind = env.BACKUP_SINK ?? 'none';
  const intervalMs = env.BACKUP_INTERVAL_MS ? Number(env.BACKUP_INTERVAL_MS) : DEFAULT_INTERVAL_MS;
  if (!(intervalMs > 0)) {
    throw new BackupConfigError('BACKUP_INTERVAL_MS must be a positive number of milliseconds');
  }
  if (kind === 'none') return { kind: 'none' };
  if (kind === 'local') {
    if (!env.BACKUP_LOCAL_DIR) {
      throw new BackupConfigError('BACKUP_SINK=local requires: BACKUP_LOCAL_DIR');
    }
    return { kind: 'local', dir: env.BACKUP_LOCAL_DIR, intervalMs };
  }
  if (kind === 'r2') {
    const missing = R2_REQUIRED.filter((k) => !env[k]);
    if (missing.length > 0) {
      throw new BackupConfigError(`BACKUP_SINK=r2 requires: ${missing.join(', ')}`);
    }
    return {
      kind: 'r2',
      endpoint: env.R2_ENDPOINT!.replace(/\/+$/, ''),
      bucket: env.R2_BUCKET!,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      intervalMs,
    };
  }
  throw new BackupConfigError(`BACKUP_SINK must be "none", "local", or "r2", got ${JSON.stringify(kind)}`);
}
