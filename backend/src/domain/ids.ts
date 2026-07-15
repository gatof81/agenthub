/**
 * Opaque prefixed ids (08 conventions: `run_…`, `ev_…`). Injectable so tests
 * can be deterministic (13 §1: total determinism at unit level).
 */

import { randomUUID } from 'node:crypto';

export type IdPrefix = 'proj' | 'conv' | 'msg' | 'run' | 'ev';

export type IdGen = (prefix: IdPrefix) => string;

export const randomIds: IdGen = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;

/** UTC ISO-8601 clock (07 §6), injectable for deterministic tests. */
export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();
