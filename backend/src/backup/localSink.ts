/**
 * Local-file snapshot sink (B3-04): a directory backend for offline tests
 * and for deployments that keep snapshots on-host only. Keys map to paths
 * under `root`; nested key segments become directories.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SnapshotSink, StoredSnapshot } from './types.js';

export class LocalSnapshotSink implements SnapshotSink {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  private path(key: string): string {
    return join(this.root, key);
  }

  put(key: string, body: Uint8Array): Promise<void> {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    return Promise.resolve();
  }

  list(prefix: string): Promise<StoredSnapshot[]> {
    const dir = join(this.root, prefix);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return Promise.resolve([]); // no snapshots yet
    }
    const out = names
      .filter((n) => n.endsWith('.gz'))
      .map((n) => ({ key: join(prefix, n), size: statSync(join(dir, n)).size }));
    return Promise.resolve(out);
  }

  get(key: string): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(readFileSync(this.path(key))));
  }

  delete(key: string): Promise<void> {
    rmSync(this.path(key), { force: true });
    return Promise.resolve();
  }
}
