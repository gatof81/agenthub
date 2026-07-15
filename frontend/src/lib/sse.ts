/**
 * SSE client (11 §5, ADR-004). Native EventSource cannot send the
 * Authorization header, so this is a fetch-stream implementation with the
 * same semantics: auto-reconnect with Last-Event-ID (replayable events
 * only); on every (re)connect the caller's `onRecover` re-reads current
 * state over REST — the store is the source of truth (NFR-07), and mobile
 * backgrounding reconnects are normal, not errors.
 */

import { getToken } from './api.js';

export interface SseEvent {
  id?: number;
  event: string;
  data: unknown;
}

export interface SseHandle {
  close: () => void;
}

export function subscribeConversation(
  conversationId: string,
  onEvent: (e: SseEvent) => void,
  onRecover: () => void,
): SseHandle {
  let closed = false;
  let lastEventId: number | null = null;
  let retryMs = 500;

  const connect = async (): Promise<void> => {
    while (!closed) {
      try {
        const res = await fetch(`/api/conversations/${conversationId}/events`, {
          headers: {
            Authorization: `Bearer ${getToken() ?? ''}`,
            ...(lastEventId !== null ? { 'Last-Event-ID': String(lastEventId) } : {}),
          },
        });
        if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
        retryMs = 500;
        onRecover(); // state/summary events are not replayed — REST recovery (08 §3)
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done || closed) break;
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
        // fall through to retry
      }
      if (closed) return;
      await new Promise((r) => setTimeout(r, retryMs));
      retryMs = Math.min(retryMs * 2, 10_000);
    }
  };

  void connect();
  return {
    close: () => {
      closed = true;
    },
  };
}
