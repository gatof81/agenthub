/**
 * Copy non-TS runtime assets into the build output (B3-09).
 *
 * `tsc` emits JS and nothing else, but the migration runner reads its SQL
 * files from disk at boot, resolved relative to its own module URL
 * (`store/migrations.ts`: `new URL('./migrations/', import.meta.url)`). A
 * dist without them throws ENOENT on the first store construction — which is
 * exactly how the production build was found to have never run.
 *
 * Asserted, not assumed: this fails loudly if the source dir is missing or
 * empty, so a renamed/moved asset dir breaks the build instead of shipping a
 * dist that dies at boot.
 */

import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** [from, to] pairs, relative to the backend root. */
const ASSETS = [['src/store/migrations', 'dist/store/migrations']];

for (const [from, to] of ASSETS) {
  const src = join(backendRoot, from);
  if (!existsSync(src)) {
    throw new Error(`copy-assets: source ${from} does not exist — did it move?`);
  }
  const entries = readdirSync(src);
  if (entries.length === 0) {
    throw new Error(`copy-assets: source ${from} is empty — refusing to ship a dist without it`);
  }
  cpSync(src, join(backendRoot, to), { recursive: true });
  console.log(`copy-assets: ${from} -> ${to} (${entries.length} file(s))`);
}
