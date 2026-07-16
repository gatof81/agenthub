/**
 * Fake SubstrateExecPort (A1, B1-06, NFR-04): replays recorded stream-json
 * fixtures as a seam NDJSON exec stream (started/output/exit), honors kill
 * (stream stops early, NO result event — the S-01 evidence), and answers the
 * status endpoint with the contract's `unknown` semantics.
 *
 * Deterministic: no wall-clock timers. A test can inject a `gate` awaited
 * between events to interleave cancellation mid-stream.
 */

import { SessionGoneError } from '../domain/ports.js';
import type {
  ExecRequest,
  ExecStatus,
  SeamEvent,
  SessionSeed,
  SubstrateExecPort,
} from '../domain/ports.js';
import type { KillOutcome } from '../domain/types.js';

export interface ExecFixture {
  /** CLI stream-json lines replayed on stdout. */
  streamLines: string[];
  exitCode?: number;
  /** seam exit reason on a natural (non-killed) end; default 'exited'. */
  exitReason?: string;
  /** stderr chunks interleaved after the first stdout line. */
  stderr?: string[];
  /** split stdout into odd-sized chunks to exercise line reassembly. */
  splitChunks?: boolean;
}

interface ExecState {
  killed: boolean;
  exited: boolean;
  exitCode: number | null;
}

export interface FakeExecPortOptions {
  /** awaited between seam events; lets tests pace/cancel mid-stream. */
  gate?: () => Promise<void>;
  /** fallback when the queue is empty (e.g. dev-server fixture cycling). */
  fixtureProvider?: () => ExecFixture;
  /**
   * Awaited before the kill RESPONSE returns — the process dies first
   * (state.killed is already set), reproducing the real seam's
   * kill-outcome race where the stream's exit(killed) beats the kill
   * round-trip (B3-01).
   */
  killResponseGate?: () => Promise<void>;
}

export class FakeSubstrateExecPort implements SubstrateExecPort {
  private sessionCounter = 0;
  private execCounter = 0;
  private readonly queue: ExecFixture[] = [];
  private readonly execs = new Map<string, ExecState>();
  private readonly gate: () => Promise<void>;
  private readonly fixtureProvider: (() => ExecFixture) | undefined;
  private readonly killResponseGate: (() => Promise<void>) | undefined;
  /** every exec request the port received, for assertions */
  readonly execRequests: Array<{ sessionId: string; req: ExecRequest }> = [];
  readonly seededSessions: Array<{ templateId: string; seed: SessionSeed }> = [];
  readonly stoppedSessions: string[] = [];
  readonly startedSessions: string[] = [];
  private readonly goneSessions = new Set<string>();

  constructor(opts: FakeExecPortOptions = {}) {
    this.gate = opts.gate ?? (() => Promise.resolve());
    this.fixtureProvider = opts.fixtureProvider;
    this.killResponseGate = opts.killResponseGate;
  }

  stopSession(sessionId: string): Promise<void> {
    this.stoppedSessions.push(sessionId);
    return Promise.resolve();
  }

  /**
   * Restore (FR-43). A session id in `goneSessions` behaves like one
   * hard-deleted upstream: the real port turns that 404 into
   * `SessionGoneError`, so the fake raises the same type — the FR-44 branch
   * is only testable offline if the fake can produce it.
   */
  startSession(sessionId: string): Promise<void> {
    if (this.goneSessions.has(sessionId)) {
      return Promise.reject(new SessionGoneError(sessionId));
    }
    this.startedSessions.push(sessionId);
    return Promise.resolve();
  }

  /** Tests mark a session as hard-deleted upstream (FR-44 branch). */
  markSessionGone(sessionId: string): void {
    this.goneSessions.add(sessionId);
  }

  /** Tests enqueue the fixture each subsequent exec will replay. */
  enqueueFixture(fixture: ExecFixture): void {
    this.queue.push(fixture);
  }

  createSession(templateId: string, seed: SessionSeed): Promise<{ sessionId: string }> {
    this.sessionCounter += 1;
    this.seededSessions.push({ templateId, seed });
    return Promise.resolve({ sessionId: `fakesess_${this.sessionCounter}` });
  }

  async *exec(sessionId: string, req: ExecRequest): AsyncIterable<SeamEvent> {
    const fixture = this.queue.shift() ?? this.fixtureProvider?.();
    if (!fixture) throw new Error('FakeSubstrateExecPort: no fixture enqueued');
    this.execCounter += 1;
    const execId = `fakeexec_${this.execCounter}`;
    const state: ExecState = { killed: false, exited: false, exitCode: null };
    this.execs.set(execId, state);
    this.execRequests.push({ sessionId, req });

    yield { v: 1, type: 'started', execId, pgid: 1000 + this.execCounter, requestId: `fakereq_${this.execCounter}` };

    const chunks: SeamEvent[] = [];
    for (const line of fixture.streamLines) {
      const data = `${line}\n`;
      if (fixture.splitChunks && data.length > 3) {
        const mid = Math.floor(data.length / 3);
        chunks.push({ v: 1, type: 'output', stream: 'stdout', data: data.slice(0, mid) });
        chunks.push({ v: 1, type: 'output', stream: 'stdout', data: data.slice(mid) });
      } else {
        chunks.push({ v: 1, type: 'output', stream: 'stdout', data });
      }
    }
    for (const err of fixture.stderr ?? []) {
      chunks.splice(1, 0, { v: 1, type: 'output', stream: 'stderr', data: err });
    }

    for (const chunk of chunks) {
      await this.gate();
      if (state.killed) break;
      yield chunk;
    }

    state.exited = true;
    if (state.killed) {
      state.exitCode = 15; // raw signal number (contract delta: setsid -w propagation)
      yield { v: 1, type: 'exit', exitCode: 15, reason: 'killed' };
    } else {
      state.exitCode = fixture.exitCode ?? 0;
      // wire fidelity (B2-04): the seam always attributes a reason
      yield { v: 1, type: 'exit', exitCode: state.exitCode, reason: fixture.exitReason ?? 'exited' };
    }
  }

  status(_sessionId: string, execId: string): Promise<ExecStatus> {
    const state = this.execs.get(execId);
    if (!state) return Promise.resolve({ state: 'unknown' }); // 200 {state:"unknown"}, never 404
    return Promise.resolve(
      state.exited
        ? { state: 'exited', exitCode: state.exitCode }
        : { state: 'running' },
    );
  }

  async kill(
    _sessionId: string,
    execId: string,
    _graceMs: number,
  ): Promise<{ outcome: KillOutcome }> {
    const state = this.execs.get(execId);
    if (!state || state.exited) return { outcome: 'already-exited' };
    state.killed = true;
    await this.killResponseGate?.();
    return { outcome: 'terminated' };
  }
}
