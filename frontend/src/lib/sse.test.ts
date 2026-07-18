/**
 * B3-03 SSE client resilience: the stall watchdog and proactive wake — the
 * behaviors that turn a frozen background socket into a normal reconnect.
 * Pure test: injected fetch + fake timers + a stub wake target, no DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeConversation } from './sse.js';
import { notifyUnauthorized } from './api.js';

vi.mock('./api.js', () => ({ getToken: () => 'test-token', notifyUnauthorized: vi.fn() }));

/**
 * A body stream a test can feed bytes into or leave silent (a frozen socket).
 * `signal` mirrors real fetch: aborting it errors the body so the reader
 * rejects (a manual ReadableStream is otherwise unaffected by fetch abort).
 */
function controllableStream(signal?: AbortSignal) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
      signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('aborted', 'AbortError'));
        } catch {
          /* already closed */
        }
      });
    },
  });
  const enc = new TextEncoder();
  return {
    body: stream,
    push: (s: string) => controller.enqueue(enc.encode(s)),
    heartbeat: () => controller.enqueue(enc.encode(': hb\n\n')),
  };
}

class StubWakeTarget implements Pick<EventTarget, 'addEventListener' | 'removeEventListener'> {
  private readonly handlers = new Map<string, Set<EventListenerOrEventListenerObject>>();
  addEventListener(type: string, h: EventListenerOrEventListenerObject): void {
    (this.handlers.get(type) ?? this.handlers.set(type, new Set()).get(type)!).add(h);
  }
  removeEventListener(type: string, h: EventListenerOrEventListenerObject): void {
    this.handlers.get(type)?.delete(h);
  }
  fire(type: string): void {
    for (const h of this.handlers.get(type) ?? []) (h as EventListener)(new Event(type));
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('SSE client resilience (B3-03)', () => {
  it('reconnects after a stall — a frozen socket that never errors nor closes', async () => {
    const connections: Array<{ signal: AbortSignal; stream: ReturnType<typeof controllableStream> }> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const stream = controllableStream(init!.signal!);
      connections.push({ signal: init!.signal!, stream });
      return new Response(stream.body, { status: 200 });
    }) as unknown as typeof fetch;

    const onRecover = vi.fn();
    const handle = subscribeConversation('c1', () => {}, onRecover, {
      stallTimeoutMs: 30_000,
      fetchImpl,
      wakeTarget: null,
    });

    await flush();
    expect(connections).toHaveLength(1);
    expect(onRecover).toHaveBeenCalledTimes(1);

    // a heartbeat arrives, then the socket freezes (no bytes, no error)
    connections[0]!.stream.heartbeat();
    await flush();
    await vi.advanceTimersByTimeAsync(20_000); // still under the stall window
    expect(connections[0]!.signal.aborted).toBe(false);

    // past the stall window with no byte → abort + reconnect
    await vi.advanceTimersByTimeAsync(31_000);
    expect(connections[0]!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(600); // backoff
    await flush();
    expect(connections.length).toBeGreaterThanOrEqual(2);
    expect(onRecover).toHaveBeenCalledTimes(2); // REST recovery on reconnect

    handle.close();
  });

  it('a heartbeat resets the watchdog — a quiet-but-alive stream is not dropped', async () => {
    const connections: Array<{ signal: AbortSignal; stream: ReturnType<typeof controllableStream> }> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const stream = controllableStream(init!.signal!);
      connections.push({ signal: init!.signal!, stream });
      return new Response(stream.body, { status: 200 });
    }) as unknown as typeof fetch;

    const handle = subscribeConversation('c1', () => {}, () => {}, {
      stallTimeoutMs: 30_000,
      fetchImpl,
      wakeTarget: null,
    });
    await flush();

    // heartbeat every 25 s keeps the 30 s watchdog from ever firing
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      connections[0]!.stream.heartbeat();
      await flush();
    }
    expect(connections[0]!.signal.aborted).toBe(false);
    expect(connections).toHaveLength(1); // never reconnected

    handle.close();
  });

  it('routes a 401 to the unauthorized handler instead of retrying silently', async () => {
    vi.mocked(notifyUnauthorized).mockClear();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    const handle = subscribeConversation('c1', () => {}, () => {}, {
      stallTimeoutMs: 30_000,
      fetchImpl,
      wakeTarget: null,
    });
    await flush();
    expect(vi.mocked(notifyUnauthorized)).toHaveBeenCalled();
    handle.close();
  });

  it('a foreground/online wake aborts the current attempt for an immediate reconnect', async () => {
    const connections: Array<{ signal: AbortSignal }> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      connections.push({ signal: init!.signal! });
      return new Response(controllableStream(init!.signal!).body, { status: 200 });
    }) as unknown as typeof fetch;

    const wake = new StubWakeTarget();
    const handle = subscribeConversation('c1', () => {}, () => {}, {
      stallTimeoutMs: 30_000,
      fetchImpl,
      wakeTarget: wake,
    });
    await flush();
    expect(connections).toHaveLength(1);

    wake.fire('visibilitychange'); // tab foregrounded
    expect(connections[0]!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    await flush();
    expect(connections.length).toBeGreaterThanOrEqual(2);

    handle.close();
  });

  it('close() unbinds wake listeners and aborts — no reconnect after close', async () => {
    const connections: Array<{ signal: AbortSignal }> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      connections.push({ signal: init!.signal! });
      return new Response(controllableStream(init!.signal!).body, { status: 200 });
    }) as unknown as typeof fetch;

    const wake = new StubWakeTarget();
    const handle = subscribeConversation('c1', () => {}, () => {}, { fetchImpl, wakeTarget: wake });
    await flush();
    handle.close();
    expect(connections[0]!.signal.aborted).toBe(true);

    wake.fire('online'); // must be a no-op after close
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(connections).toHaveLength(1);
  });
});
