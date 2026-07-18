/**
 * SSE client (11 §5, ADR-004; hardened in B3-03). Native EventSource cannot
 * send the Authorization header, so this is a fetch-stream implementation
 * with the same semantics: auto-reconnect with Last-Event-ID (replayable
 * events only); on every (re)connect the caller's `onRecover` re-reads
 * current state over REST — the store is the source of truth (NFR-07).
 *
 * B3-03 resilience — "backgrounding reconnect is normal, not an error":
 * - **Stall watchdog.** A phone that suspends the tab freezes the TCP
 *   socket WITHOUT a clean close, so the read never errors and the stream
 *   would hang forever. The server sends a heartbeat comment every ~25 s
 *   (08 §3); any byte (data or heartbeat) resets a watchdog, and if no
 *   byte arrives within `stallTimeoutMs` the connection is aborted and
 *   reconnected. This is what turns a frozen background socket into a
 *   normal reconnect.
 * - **Proactive wake.** On tab foreground (`visibilitychange`) or network
 *   `online`, the current attempt is aborted so a fresh connect + REST
 *   recovery happens immediately instead of waiting out the watchdog.
 */

import { getToken, notifyUnauthorized } from './api.js';

export interface SseEvent {
  id?: number;
  event: string;
  data: unknown;
}

export interface SseHandle {
  close: () => void;
}

export interface SseOptions {
  /** No byte within this window ⇒ treat the socket as dead and reconnect. */
  stallTimeoutMs?: number;
  /** Reconnect backoff ceiling. */
  maxBackoffMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Where foreground/online wakes come from. Default (browser): `document`
   * for `visibilitychange` + `window` for `online`. A test passes one stub
   * that receives both. `null` disables proactive wakes.
   */
  wakeTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
}

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

// 2.4× the server's 25 s heartbeat — one missed heartbeat is noise, two is dead.
const DEFAULT_STALL_MS = 60_000;

export function subscribeConversation(
  conversationId: string,
  onEvent: (e: SseEvent) => void,
  onRecover: () => void,
  opts: SseOptions = {},
): SseHandle {
  const stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? 10_000;
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  // [target, event] pairs to (un)bind for proactive wakes
  const wakeBindings: Array<[Listenable, string]> = [];
  if (opts.wakeTarget === null) {
    // disabled
  } else if (opts.wakeTarget !== undefined) {
    wakeBindings.push([opts.wakeTarget, 'visibilitychange'], [opts.wakeTarget, 'online']);
  } else {
    if (typeof document !== 'undefined') wakeBindings.push([document, 'visibilitychange']);
    if (typeof window !== 'undefined') wakeBindings.push([window, 'online']);
  }

  let closed = false;
  let lastEventId: number | null = null;
  let retryMs = 500;
  let controller: AbortController | null = null;

  /** Abort the in-flight attempt so the read loop unwinds and reconnects. */
  const kick = (): void => {
    controller?.abort();
  };

  const onWake = (): void => {
    if (!closed) kick();
  };
  for (const [target, event] of wakeBindings) target.addEventListener(event, onWake);

  const connect = async (): Promise<void> => {
    while (!closed) {
      controller = new AbortController();
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const armStall = (): void => {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller?.abort(), stallTimeoutMs);
      };
      try {
        const res = await fetchImpl(`/api/conversations/${conversationId}/events`, {
          headers: {
            Authorization: `Bearer ${getToken() ?? ''}`,
            ...(lastEventId !== null ? { 'Last-Event-ID': String(lastEventId) } : {}),
          },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          // a credential can expire mid-stream with no REST in flight; route the
          // 401 to the same recovery `call()` uses instead of retrying forever
          if (res.status === 401) notifyUnauthorized();
          throw new Error(`sse ${res.status}`);
        }
        retryMs = 500;
        onRecover(); // state/summary events are not replayed — REST recovery (08 §3)
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        armStall();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || closed) break;
          armStall(); // any byte — data OR heartbeat comment — proves liveness
          buffer += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (raw.startsWith(':') || raw.trim() === '') continue;
            const frame: Partial<SseEvent> = {};
            for (const line of raw.split('\n')) {
              if (line.startsWith('id: ')) frame.id = Number(line.slice(4));
              else if (line.startsWith('event: ')) frame.event = line.slice(7);
              else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
            }
            if (frame.event) {
              if (frame.id !== undefined) lastEventId = frame.id;
              onEvent(frame as SseEvent);
            }
          }
        }
      } catch {
        // network error, non-200, stall abort, or wake abort — all reconnect
      } finally {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
      }
      if (closed) return;
      await new Promise((r) => setTimeout(r, retryMs));
      retryMs = Math.min(retryMs * 2, maxBackoffMs);
    }
  };

  void connect();
  return {
    close: () => {
      closed = true;
      for (const [target, event] of wakeBindings) target.removeEventListener(event, onWake);
      controller?.abort();
    },
  };
}
