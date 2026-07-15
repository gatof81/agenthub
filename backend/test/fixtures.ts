/** Loads the sanitized S-01 fixture streams (the canonical corpus, 08 §7). */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_ROOT = fileURLToPath(
  new URL('../../docs/spikes/S-01/fixtures/run-20260714T142930Z/', import.meta.url),
);

export function fixtureStreamLines(phase: string): string[] {
  return readFileSync(join(FIXTURE_ROOT, phase, 'stream.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

export const FIXTURES = {
  baseline: 'p2-baseline',
  resume1: 'p3-resume-1',
  cancel: 'p4-cancel',
  toolshape: 'p5-toolshape',
} as const;
