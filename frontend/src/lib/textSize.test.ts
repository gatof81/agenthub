import { afterEach, describe, expect, it } from 'vitest';
import {
  loadTextSize,
  nextTextSize,
  saveTextSize,
  TEXT_SIZES,
  type TextSize,
} from './textSize.js';

// The default vitest env is node, which has no localStorage — provide a minimal
// in-memory shim so the persistence helpers can be exercised.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

afterEach(() => localStorage.clear());

describe('nextTextSize', () => {
  it('cycles sm → md → lg → sm', () => {
    expect(nextTextSize('sm')).toBe('md');
    expect(nextTextSize('md')).toBe('lg');
    expect(nextTextSize('lg')).toBe('sm');
  });
});

describe('load/saveTextSize', () => {
  it('defaults to sm (the historical size) with nothing stored', () => {
    expect(loadTextSize()).toBe('sm');
  });

  it('round-trips a saved size', () => {
    saveTextSize('lg');
    expect(loadTextSize()).toBe('lg');
  });

  it('falls back to sm on a garbage stored value', () => {
    localStorage.setItem('agenthub.textSize', 'huge');
    expect(loadTextSize()).toBe('sm');
  });
});

describe('TEXT_SIZES', () => {
  it('maps every level to a CSS length, sm being 14px', () => {
    const levels: TextSize[] = ['sm', 'md', 'lg'];
    for (const l of levels) expect(TEXT_SIZES[l]).toMatch(/^\d+px$/);
    expect(TEXT_SIZES.sm).toBe('14px');
  });
});
