/**
 * SSE contract (ADR-004, 08 §3, 13 §4): live projection, drop mid-run,
 * reconnect with Last-Event-ID → gapless replay of run_events-derived
 * events; state/summary events are NOT replayed and recover over REST.
 */

import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { makeApiHarness, TEST_TOKEN, type ApiHarness } from './apiHarness.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

interface SseFrame {
  id?: number;
  event: string;
  data: unknown;
}

class SseClient {
  private controller = new AbortController();
  readonly frames: SseFrame[] = [];
  private done: Promise<void>;

  constructor(url: string, lastEventId?: number) {
    this.done = this.consume(url, lastEventId);
  }

  private async consume(url: string, lastEventId?: number): Promise<void> {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        ...(lastEventId !== undefined ? { 'Last-Event-ID': String(lastEventId) } : {}),
      },
      signal: this.controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (raw.startsWith(':')) continue; // comment/heartbeat
          const frame: Partial<SseFrame> = {};
          for (const line of raw.split('\n')) {
            if (line.startsWith('id: ')) frame.id = Number(line.slice(4));
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
          }
          if (frame.event) this.frames.push(frame as SseFrame);
        }
      }
    } catch {
      // aborted — expected in the drop scenario
    }
  }

  /** waits (bounded) until a predicate over collected frames holds */
  async until(pred: (frames: SseFrame[]) => boolean, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!pred(this.frames)) {
      if (Date.now() - start > ms) throw new Error(`SSE wait timed out; got ${JSON.stringify(this.frames)}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.done;
  }
}

async function listen(h: ApiHarness): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = h.app.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

describe('SSE stream (ADR-004)', () => {
  it('delivers live projection with ids only on replayable events; reconnect replays gapless (13 §4)', async () => {
    // pace the fixture so the client provably receives mid-run
    let releases: Array<() => void> = [];
    const gate = (): Promise<void> =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    const h = makeApiHarness(gate);
    const { server, base } = await listen(h);
    servers.push(server);

    const project = h.orch.createProject({ name: 'p', defaultAgentId: 'dev' });
    await h.orch.idle();
    const conv = h.orch.createConversation({ projectId: project.id });

    const client = new SseClient(`${base}/api/conversations/${conv.id}/events`);
    await new Promise((r) => setTimeout(r, 20)); // client subscribed

    h.port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.toolshape) });
    const { run } = h.orch.send(conv.id, 'work please');

    // release fixture chunks until the client has some replayable events
    const pump = setInterval(() => {
      releases.splice(0).forEach((r) => r());
    }, 2);
    await client.until((f) => f.filter((x) => x.id !== undefined).length >= 3);
    clearInterval(pump);

    // run.state events observed live but WITHOUT replayable ids (08 §3)
    const stateFrames = client.frames.filter((f) => f.event === 'run.state');
    expect(stateFrames.length).toBeGreaterThanOrEqual(1);
    expect(stateFrames.every((f) => f.id === undefined)).toBe(true);
    const gotIds = client.frames.filter((f) => f.id !== undefined).map((f) => f.id as number);
    const lastSeen = Math.max(...gotIds);

    // drop mid-run (iPhone backgrounding is routine, 11 §5)
    await client.close();

    // let the run finish
    const finishPump = setInterval(() => {
      releases.splice(0).forEach((r) => r());
    }, 2);
    await h.orch.idle();
    clearInterval(finishPump);
    releases = [];
    expect(h.store.getRun(run.id)!.state).toBe('completed');

    // reconnect with Last-Event-ID → gapless continuation of replayables
    const reconnect = new SseClient(`${base}/api/conversations/${conv.id}/events`, lastSeen);
    const total = h.store.getReplayableEvents(conv.id).length;
    await reconnect.until((f) => {
      const maxId = Math.max(-1, ...f.filter((x) => x.id !== undefined).map((x) => x.id as number));
      return maxId === total - 1;
    });
    const replayIds = reconnect.frames.filter((f) => f.id !== undefined).map((f) => f.id as number);
    // Gapless: some replayable rows legitimately emit no frame (thinking /
    // tool_result outputs), so ids may skip — what must hold is: nothing
    // before the cursor is re-sent, nothing after it is missed, no dupes.
    expect(Math.min(...replayIds)).toBeGreaterThan(lastSeen);
    expect(replayIds).toEqual([...replayIds].sort((a, b) => a - b));
    expect(new Set(replayIds).size).toBe(replayIds.length);
    const { sseFromRunEvent } = await import('../src/domain/projections.js');
    const emittingIndices = h.store
      .getReplayableEvents(conv.id)
      .filter((r) => sseFromRunEvent(run.messageId, r.event).length > 0)
      .map((r) => r.index);
    const seenEverywhere = new Set([...gotIds, ...replayIds]);
    for (const idx of emittingIndices) {
      expect(seenEverywhere.has(idx), `emitting row ${idx} delivered exactly once`).toBe(true);
    }

    // state/summary are NOT replayed — the client recovers them over REST (NFR-07)
    expect(reconnect.frames.some((f) => f.event === 'run.state')).toBe(false);
    expect(reconnect.frames.some((f) => f.event === 'run.summary')).toBe(false);
    expect(h.store.getSummary(run.id)).toBeDefined(); // GET /api/runs/:id serves it
    await reconnect.close();
  });

  it('emits heartbeat comments on an idle stream — the keep-alive backgrounding recovery relies on (B3-03, 08 §3)', async () => {
    const h = makeApiHarness(undefined, { heartbeatMs: 30 });
    const { server, base } = await listen(h);
    servers.push(server);
    const project = h.orch.createProject({ name: 'p', defaultAgentId: 'dev' });
    await h.orch.idle();
    const conv = h.orch.createConversation({ projectId: project.id });

    // read raw bytes (SseClient strips comments) from an otherwise-silent stream
    const ac = new AbortController();
    const res = await fetch(`${base}/api/conversations/${conv.id}/events`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    const deadline = Date.now() + 2000;
    try {
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        if ((raw.match(/: hb/g) ?? []).length >= 2) break; // periodic, not just once
      }
    } finally {
      ac.abort();
      reader.cancel().catch(() => {});
    }
    expect(raw).toContain(': connected');
    expect((raw.match(/: hb/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('a client that missed everything rebuilds the full projection from index -1', async () => {
    const h = makeApiHarness();
    const { server, base } = await listen(h);
    servers.push(server);
    h.orch.createProject({ name: 'p', defaultAgentId: 'dev' });
    await h.orch.idle();
    const project = h.store.listProjects()[0]!;
    const conv = h.orch.createConversation({ projectId: project.id });
    h.port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    h.orch.send(conv.id, 'hello');
    await h.orch.idle();

    const client = new SseClient(`${base}/api/conversations/${conv.id}/events`);
    const total = h.store.getReplayableEvents(conv.id).length;
    expect(total).toBeGreaterThan(0);
    await client.until(
      (f) => f.filter((x) => x.id !== undefined).length >= 1 && f.some((x) => x.event === 'message.delta'),
    );
    const ids = client.frames.filter((f) => f.id !== undefined).map((f) => f.id as number);
    expect(Math.min(...ids)).toBe(0); // full replay from the beginning
    await client.close();
  });
});
