/**
 * Smoke-test the production build (B3-09): boot `dist/main.js` and require it
 * to actually serve.
 *
 * A `tsc` exit code proves the build COMPILES, which is not the property that
 * matters. The production build was found to have never run: it compiled
 * fine, then died at boot because `tsc` does not copy the migration SQL the
 * store reads from disk. Only booting the artifact catches that class of bug,
 * so CI boots it.
 *
 * Deliberately minimal: fake runtime, no backup sink, scratch db — this asks
 * "does the shipped artifact come up and answer?", nothing more. The
 * behaviour of the code inside is the test suite's job.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8123;
const BOOT_TIMEOUT_MS = 30_000;
const dir = mkdtempSync(join(tmpdir(), 'hub-smoke-'));

const child = spawn(process.execPath, ['dist/main.js'], {
  env: {
    ...process.env,
    HUB_PORT: String(PORT),
    HUB_API_TOKEN: 'smoke',
    HUB_DB_PATH: join(dir, 'smoke.sqlite'),
    HUB_RUNTIME: 'fake',
    BACKUP_SINK: 'none',
  },
  stdio: 'inherit',
});

let exited = null;
child.on('exit', (code, signal) => {
  exited = signal ?? `code ${code}`;
});

const cleanup = () => {
  if (exited === null) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
};

const fail = (msg) => {
  console.error(`smoke-dist: FAIL — ${msg}`);
  cleanup();
  process.exit(1);
};

const deadline = Date.now() + BOOT_TIMEOUT_MS;
for (;;) {
  if (exited !== null) fail(`the build exited during boot (${exited})`);
  if (Date.now() > deadline) fail(`no response on :${PORT} within ${BOOT_TIMEOUT_MS} ms`);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    if (res.ok) break;
  } catch {
    // not listening yet
  }
  await new Promise((r) => setTimeout(r, 250));
}

console.log('smoke-dist: OK — the production build boots and serves /api/health');
cleanup();
process.exit(0);
