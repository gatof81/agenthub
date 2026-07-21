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
  /** set once the server's `: connected` comment is seen — the marker it writes
   * before replay, so waiting on it proves the connection is past the handshake
   * (deterministic signal, not a fixed sleep). */
  connected = false;
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
          if (raw.startsWith(':')) {
            if (raw.includes('connected')) this.connected = true;
            continue; // comment/heartbeat
          }
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

  /** waits (bounded) until the server's `: connected` marker has arrived. The
   * server writes it before replay, and the synchronous replay writes ride the
   * same flush — so once this resolves, any replayed frames are already in
   * `frames`. Replaces a fixed sleep in negative-assertion tests. */
  async untilConnected(ms = 5000): Promise<void> {
    const start = Date.now();
    while (!this.connected) {
      if (Date.now() - start > ms) throw new Error('SSE never connected');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** resolves when the server ends the stream (e.g. it threw after headers were
   * sent). A deterministic signal that the request was fully processed. */
  async waitClosed(ms = 5000): Promise<void> {
    await Promise.race([
      this.done,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('stream did not close')), ms)),
    ]);
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

    const project = h.orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
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
    const project = h.orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
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

  /**
   * Regression (found in production 2026-07-16): a page load showed the
   * assistant's answer twice and sat on "working" for a run that had long
   * finished, and reloading reproduced it every time.
   *
   * Replay exists to hand a dropped connection what it MISSED. A cold
   * connect missed nothing — the client just loaded the conversation over
   * REST, history included. Replaying there re-streamed every past run's
   * deltas on top of the REST messages (the duplicate), and since state
   * events are deliberately not replayed (11 §5), the client saw live deltas
   * with no terminal `run.state` and stayed on "working".
   *
   * NFR-07 says a client that missed everything rebuilds from REST — the
   * store is the source of truth. It does NOT say the SSE stream re-narrates
   * history. The test this replaces asserted the opposite and pinned the bug.
   */
  it('a cold connect (no Last-Event-ID) replays nothing — history came from REST', async () => {
    const h = makeApiHarness();
    const { server, base } = await listen(h);
    servers.push(server);
    h.orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    await h.orch.idle();
    const project = h.store.listProjects()[0]!;
    const conv = h.orch.createConversation({ projectId: project.id });
    h.port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    h.orch.send(conv.id, 'hello');
    await h.orch.idle();
    // the run is over and its events ARE in the store — the point is that a
    // fresh connection does not re-narrate them
    expect(h.store.getReplayableEvents(conv.id).length).toBeGreaterThan(0);

    const client = new SseClient(`${base}/api/conversations/${conv.id}/events`);
    await new Promise((r) => setTimeout(r, 400));
    expect(client.frames.filter((f) => f.event === 'message.delta')).toHaveLength(0);
    expect(client.frames.filter((f) => f.id !== undefined)).toHaveLength(0);
    await client.close();
  });

  /**
   * #117: replay used to accept ANY finite Last-Event-ID, so a client could
   * send "-1" (or "0") and reach the internal "from the beginning" sentinel,
   * forcing a full-history re-stream — the exact double-stream the cold-connect
   * guard exists to prevent, just via an explicit header instead of an absent
   * one. The parsed cursor is now clamped to >= 0: the smallest legitimate
   * cursor is 0 ("I already have index 0"), which resumes from index 1. Index 0
   * is therefore never re-narrated.
   */
  it('clamps a negative Last-Event-ID so it cannot force a full-history re-stream (#117)', async () => {
    const h = makeApiHarness();
    const { server, base } = await listen(h);
    servers.push(server);
    h.orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    await h.orch.idle();
    const project = h.store.listProjects()[0]!;
    const conv = h.orch.createConversation({ projectId: project.id });
    h.port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    h.orch.send(conv.id, 'hello');
    await h.orch.idle();
    // the whole conversation's replayable history IS in the store (index 0) ...
    expect(h.store.getReplayableEvents(conv.id).length).toBeGreaterThan(0);
    expect(h.store.getReplayableEvents(conv.id).some((r) => r.index === 0)).toBe(true);

    // ... yet "-1" clamps to 0 and replays only index > 0, so index 0 (all the
    // baseline fixture has) is withheld: nothing is re-streamed.
    const client = new SseClient(`${base}/api/conversations/${conv.id}/events`, -1);
    // wait for the `: connected` marker the server writes *before* replay; the
    // synchronous replay rides the same flush, so if the clamp regressed and
    // index 0 were re-streamed, its frame would already be here.
    await client.untilConnected();
    expect(client.frames.filter((f) => f.id !== undefined)).toHaveLength(0);
    expect(client.frames.filter((f) => f.event === 'message.delta')).toHaveLength(0);
    await client.close();
  });

  it('an explicit cursor still resumes everything after it, never re-narrating index 0 (#117)', async () => {
    const h = makeApiHarness();
    const { server, base } = await listen(h);
    servers.push(server);
    h.orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    await h.orch.idle();
    const project = h.store.listProjects()[0]!;
    const conv = h.orch.createConversation({ projectId: project.id });
    h.port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.toolshape) });
    const { run } = h.orch.send(conv.id, 'work please');
    await h.orch.idle();

    const { sseFromRunEvent } = await import('../src/domain/projections.js');
    // index 0 always exists (0-based contiguous cursor) — the row we withhold
    expect(h.store.getReplayableEvents(conv.id).some((r) => r.index === 0)).toBe(true);
    // exactly what a cursor of 0 must resume: emitting rows with index > 0
    const expected = h.store
      .getReplayableEvents(conv.id, 0)
      .filter((r) => sseFromRunEvent(run.messageId, r.event).length > 0)
      .map((r) => r.index);
    expect(expected.length).toBeGreaterThan(0);

    // cursor 0 = "I already have index 0"; clamp is a no-op, resume from 1
    const client = new SseClient(`${base}/api/conversations/${conv.id}/events`, 0);
    await client.until((f) => {
      const seen = new Set(f.filter((x) => x.id !== undefined).map((x) => x.id as number));
      return expected.every((i) => seen.has(i));
    });
    const seen = new Set(client.frames.filter((f) => f.id !== undefined).map((f) => f.id as number));
    expect(seen.has(0)).toBe(false); // index 0 withheld
    expect([...seen].sort((a, b) => a - b)).toEqual([...new Set(expected)].sort((a, b) => a - b));
    await client.close();
  });

  /**
   * #117: replay runs AFTER the SSE headers (and `: connected`) are written, so
   * a throw there cannot become a clean HTTP error — it unwinds to Express with
   * headers already sent. Cleanup is registered before the replay loop, so the
   * broadcaster subscription is still torn down; otherwise the closure leaks and
   * the per-conversation Set grows for the life of the process.
   */
  it('a throw during replay still unsubscribes — no leaked subscriber (#117)', async () => {
    const h = makeApiHarness();
    const { server, base } = await listen(h);
    servers.push(server);
    h.orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    await h.orch.idle();
    const project = h.store.listProjects()[0]!;
    const conv = h.orch.createConversation({ projectId: project.id });

    // force replay to blow up (an id: header takes the replay path)
    h.store.getReplayableEvents = () => {
      throw new Error('boom mid-replay');
    };
    const byConversation = (h.broadcaster as unknown as { byConversation: Map<string, Set<unknown>> })
      .byConversation;

    const client = new SseClient(`${base}/api/conversations/${conv.id}/events`, 5);
    // the replay throw unwinds to Express after headers are sent, so the server
    // ends the stream; waiting for that close is a deterministic signal the
    // catch (and its cleanup) has run — no fixed sleep.
    await client.waitClosed();
    // cleanup ran in the catch: the subscriber Set was emptied and dropped (#117)
    expect(byConversation.has(conv.id)).toBe(false);
    await client.close();
  });
});
