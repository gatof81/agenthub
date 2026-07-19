import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './time.js';

const now = Date.parse('2026-07-19T12:00:00.000Z');
const ago = (ms: number): string => new Date(now - ms).toISOString();
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

describe('formatRelativeTime', () => {
  it('says "now" under 45s', () => {
    expect(formatRelativeTime(ago(10 * S), now)).toBe('now');
    expect(formatRelativeTime(ago(44 * S), now)).toBe('now');
  });

  it('rounds to minutes, hours, days', () => {
    expect(formatRelativeTime(ago(3 * M), now)).toBe('3m');
    expect(formatRelativeTime(ago(2 * H), now)).toBe('2h');
    expect(formatRelativeTime(ago(5 * D), now)).toBe('5d');
  });

  it('falls back to an absolute date past a week', () => {
    const out = formatRelativeTime(ago(10 * D), now);
    expect(out).not.toMatch(/now|\dm$|\dh$|\dd$/);
    expect(out.length).toBeGreaterThan(0);
  });

  it('never returns a negative time (clock skew)', () => {
    expect(formatRelativeTime(new Date(now + 5 * S).toISOString(), now)).toBe('now');
  });

  it('returns empty string for an unparseable timestamp', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('');
  });
});
