/**
 * ADR-003 mapping pinned against the sanitized S-01 corpus (08 §7): these
 * assertions are what the real claude-cli adapter must reproduce in
 * Increment 2 (R-12 contract gate).
 */

import { describe, expect, it } from 'vitest';
import type { AdapterItem } from '../src/domain/ports.js';
import { LineBuffer, mapStreamJsonLine } from '../src/runtime/streamJsonMapping.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

function mapAll(lines: string[]): AdapterItem[] {
  return lines.flatMap((l) => mapStreamJsonLine(l));
}

describe('stream-json mapping (ADR-003) against S-01 fixtures', () => {
  it('p2-baseline: init → unknown(rate_limit) → usage → output(text) → result', () => {
    const items = mapAll(fixtureStreamLines(FIXTURES.baseline));
    // the assistant message emits a usage item (B3-06) before its content
    expect(items.map((i) => i.kind)).toEqual(['init', 'event', 'usage', 'event', 'result']);

    const init = items[0] as Extract<AdapterItem, { kind: 'init' }>;
    expect(init.model).toBe('claude-sonnet-5');
    expect(init.runtimeSessionId).toBe('S01-SESSION-C');
    expect(init.cliVersion).not.toBe('unknown');

    const rateLimit = items[1] as Extract<AdapterItem, { kind: 'event' }>;
    expect(rateLimit.type).toBe('unknown'); // FR-16: preserved, not dropped
    expect((rateLimit.payload as { originalType: string }).originalType).toBe('rate_limit_event');

    const usage = items[2] as Extract<AdapterItem, { kind: 'usage' }>;
    expect(usage.kind).toBe('usage'); // per-message tokens for the budget estimate
    expect(usage.outputTokens).toBeGreaterThanOrEqual(0);
    expect(usage.cacheReadTokens).toBeGreaterThan(0); // baseline read a large cache

    const text = items[3] as Extract<AdapterItem, { kind: 'event' }>;
    expect(text.type).toBe('output');
    expect((text.payload as { blockType: string }).blockType).toBe('text');

    const result = items[4] as Extract<AdapterItem, { kind: 'result' }>;
    expect(result.totalCostUsd).toBeCloseTo(0.0101426, 6);
    expect(result.numTurns).toBe(1);
    expect(result.permissionDenialCount).toBe(0);
    expect(result.isError).toBe(false);
    expect(result.runtimeSessionId).toBe('S01-SESSION-C');
  });

  it('p5-toolshape: tool_use blocks map to tool_use events with name+input (FR-14)', () => {
    const items = mapAll(fixtureStreamLines(FIXTURES.toolshape));
    const toolUses = items.filter(
      (i): i is Extract<AdapterItem, { kind: 'event' }> => i.kind === 'event' && i.type === 'tool_use',
    );
    expect(toolUses.length).toBeGreaterThanOrEqual(3);
    for (const tu of toolUses) {
      const p = tu.payload as { name?: string; input?: unknown };
      expect(typeof p.name).toBe('string');
      expect(p.input).toBeDefined();
    }
    // thinking blocks persist as output but never carry answer text
    const thinking = items.filter(
      (i) =>
        i.kind === 'event' &&
        i.type === 'output' &&
        (i.payload as { blockType?: string }).blockType === 'thinking',
    );
    expect(thinking.length).toBeGreaterThanOrEqual(1);
    for (const t of thinking) {
      expect((t as Extract<AdapterItem, { kind: 'event' }>).payload).not.toHaveProperty('text');
    }
  });

  it('p4-cancel: the killed stream has no result item (S-01 finding)', () => {
    const items = mapAll(fixtureStreamLines(FIXTURES.cancel));
    expect(items.some((i) => i.kind === 'result')).toBe(false);
  });

  it('unparseable and unrecognized lines become unknown events, capped (FR-16)', () => {
    const [garbage] = mapStreamJsonLine('not json at all');
    expect(garbage).toMatchObject({ kind: 'event', type: 'unknown' });
    const [future] = mapStreamJsonLine('{"type":"holo_deck_event","x":1}');
    expect(future).toMatchObject({ kind: 'event', type: 'unknown' });
    expect(((future as Extract<AdapterItem, { kind: 'event' }>).payload as { originalType: string }).originalType).toBe(
      'holo_deck_event',
    );
  });

  it('result permission_denials become one permission_denial event per entry (FR-15)', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'partial work',
      session_id: 'S',
      total_cost_usd: 0.01,
      num_turns: 2,
      usage: {},
      permission_denials: [
        { tool_name: 'WebFetch', tool_use_id: 'toolu_X' },
        { tool_name: 'Task', tool_use_id: 'toolu_Y' },
      ],
    });
    const items = mapStreamJsonLine(line);
    const denials = items.filter((i) => i.kind === 'event' && i.type === 'permission_denial');
    expect(denials).toHaveLength(2);
    const result = items.at(-1) as Extract<AdapterItem, { kind: 'result' }>;
    expect(result.permissionDenialCount).toBe(2);
  });

  it('LineBuffer reassembles lines across arbitrary chunk splits', () => {
    const lines = fixtureStreamLines(FIXTURES.baseline);
    const whole = lines.map((l) => `${l}\n`).join('');
    const buf = new LineBuffer();
    const out: string[] = [];
    for (let i = 0; i < whole.length; i += 7) {
      out.push(...buf.push(whole.slice(i, i + 7)));
    }
    out.push(...buf.flush());
    expect(out).toEqual(lines);
  });
});
