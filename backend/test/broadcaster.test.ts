/**
 * Broadcaster subscriber bookkeeping (#117): the in-process pub/sub keyed by
 * conversation (ADR-004, 08 §3) must not grow unbounded — an empty subscriber
 * Set is dropped from the index on the last unsubscribe, so a churn of
 * conversations does not leak a Map entry per conversation for the life of the
 * process.
 */

import { describe, expect, it } from 'vitest';
import { Broadcaster } from '../src/api/broadcaster.js';
import type { RunStateNotification } from '../src/domain/ports.js';

// The maps are private; a test may inspect them to assert the leak is closed.
type Maps = {
  byConversation: Map<string, Set<unknown>>;
  byProject: Map<string, Set<unknown>>;
};
const maps = (b: Broadcaster): Maps => b as unknown as Maps;

describe('Broadcaster (#117)', () => {
  it('drops the conversation and project Set once the last subscriber unsubscribes', () => {
    const b = new Broadcaster();
    const un = b.subscribe('conv-1', 'proj-1', () => {});
    expect(maps(b).byConversation.has('conv-1')).toBe(true);
    expect(maps(b).byProject.has('proj-1')).toBe(true);

    un();
    // no empty Set left behind under either key
    expect(maps(b).byConversation.has('conv-1')).toBe(false);
    expect(maps(b).byProject.has('proj-1')).toBe(false);
  });

  it('keeps the Set while other subscribers on the same conversation remain', () => {
    const b = new Broadcaster();
    const first = b.subscribe('conv-1', null, () => {});
    const second = b.subscribe('conv-1', null, () => {});

    first();
    expect(maps(b).byConversation.has('conv-1')).toBe(true);
    expect(maps(b).byConversation.get('conv-1')!.size).toBe(1);

    second();
    expect(maps(b).byConversation.has('conv-1')).toBe(false);
  });

  it('never touches the project index for a projectless (direct specialist) conversation', () => {
    const b = new Broadcaster();
    const un = b.subscribe('conv-1', null, () => {});
    expect(maps(b).byProject.size).toBe(0);
    un();
    expect(maps(b).byProject.size).toBe(0);
  });

  it('still delivers to a fresh subscriber after the Set was dropped and recreated', () => {
    const b = new Broadcaster();
    // subscribe + immediate unsubscribe drops the conversation Set
    b.subscribe('conv-1', null, () => {})();
    expect(maps(b).byConversation.has('conv-1')).toBe(false);

    const got: unknown[] = [];
    b.subscribe('conv-1', null, (e) => got.push(e));
    const note: RunStateNotification = { runId: 'r1', state: 'completed' };
    b.runState('conv-1', note);
    expect(got).toHaveLength(1);
  });
});
