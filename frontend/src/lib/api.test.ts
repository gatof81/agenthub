import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setUnauthorizedHandler } from './api.js';

// node test env has no localStorage — getToken() reads it for the auth header
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

function stubFetch(status: number, body: unknown = {}): void {
  globalThis.fetch = vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

afterEach(() => setUnauthorizedHandler(null));

describe('call() 401 handling — token recovery', () => {
  it('fires the unauthorized handler on 401 and still throws ApiError', async () => {
    stubFetch(401, { code: 'unauthorized' });
    let fired = 0;
    setUnauthorizedHandler(() => {
      fired++;
    });
    await expect(api.agents()).rejects.toBeInstanceOf(ApiError);
    expect(fired).toBe(1);
  });

  it('does NOT fire on a non-401 error', async () => {
    stubFetch(404, { code: 'not_found' });
    let fired = 0;
    setUnauthorizedHandler(() => {
      fired++;
    });
    await expect(api.agents()).rejects.toBeInstanceOf(ApiError);
    expect(fired).toBe(0);
  });

  it('does NOT fire on success', async () => {
    stubFetch(200, { agents: [] });
    let fired = 0;
    setUnauthorizedHandler(() => {
      fired++;
    });
    await expect(api.agents()).resolves.toEqual({ agents: [] });
    expect(fired).toBe(0);
  });

  it('a cleared handler is not called', async () => {
    stubFetch(401);
    let fired = 0;
    setUnauthorizedHandler(() => {
      fired++;
    });
    setUnauthorizedHandler(null);
    await expect(api.agents()).rejects.toBeInstanceOf(ApiError);
    expect(fired).toBe(0);
  });
});
