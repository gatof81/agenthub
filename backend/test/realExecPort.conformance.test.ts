/**
 * B2-01 conformance suite: RealSubstrateExecPort against the seam contract
 * double (EXEC_API.md wire shapes), offline (13 §6). The parity block at the
 * end pins the doc-17 "done when": for equivalent scenarios the real port
 * yields the same SeamEvent shapes the fake produces, so the orchestrator
 * cannot tell the implementations apart (R-12).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecRequest, SeamEvent } from '../src/domain/ports.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import {
  RealSubstrateExecPort,
  SeamHttpError,
  SeamProtocolError,
  SeamValidationError,
} from '../src/substrate/real.js';
import { CookieSeamAuth, SeamAuthError } from '../src/substrate/seamAuth.js';
import { SeamDouble } from './seamDouble.js';

const REQ: ExecRequest = { argv: ['claude', '-p'], maxDurationMs: 600_000 };

let double: SeamDouble;
let port: RealSubstrateExecPort;

const collect = async (iter: AsyncIterable<SeamEvent>): Promise<SeamEvent[]> => {
  const events: SeamEvent[] = [];
  for await (const e of iter) events.push(e);
  return events;
};

beforeEach(async () => {
  double = new SeamDouble();
  await double.start();
  port = new RealSubstrateExecPort({
    baseUrl: double.baseUrl,
    auth: new CookieSeamAuth({
      baseUrl: double.baseUrl,
      username: double.username,
      password: double.password,
    }),
  });
});

afterEach(async () => {
  await double.stop();
});

describe('exec stream', () => {
  it('yields started/output/exit in order with the seam requestId (OPS-04)', async () => {
    double.execScripts.push({
      requestId: 'feedface00000001',
      execId: 'e_1',
      pgid: 42,
      lines: [
        JSON.stringify({ v: 1, type: 'output', stream: 'stdout', data: '{"type":"system"}\n' }),
        JSON.stringify({ v: 1, type: 'exit', exitCode: 0, reason: 'exited', ts: 'x' }),
      ],
    });
    const events = await collect(port.exec('sess1', REQ));
    expect(events.map((e) => e.type)).toEqual(['started', 'output', 'exit']);
    expect(events[0]).toEqual({
      v: 1,
      type: 'started',
      execId: 'e_1',
      pgid: 42,
      requestId: 'feedface00000001',
    });
    expect(events[2]).toEqual({ v: 1, type: 'exit', exitCode: 0, reason: 'exited' });
  });

  it('reassembles NDJSON lines from chunks that are not line-aligned', async () => {
    double.execScripts.push({
      chunkMode: 'split-mid-line',
      lines: [
        JSON.stringify({ v: 1, type: 'output', stream: 'stdout', data: 'long-enough-payload-1\n' }),
        JSON.stringify({ v: 1, type: 'output', stream: 'stderr', data: 'diag\n' }),
        JSON.stringify({ v: 1, type: 'exit', exitCode: 0, reason: 'exited' }),
      ],
    });
    const events = await collect(port.exec('sess1', REQ));
    expect(events.map((e) => e.type)).toEqual(['started', 'output', 'output', 'exit']);
    expect(events[1]).toMatchObject({ stream: 'stdout', data: 'long-enough-payload-1\n' });
    expect(events[2]).toMatchObject({ stream: 'stderr', data: 'diag\n' });
  });

  it('ignores unknown event types and unknown fields (v:1 forward compat)', async () => {
    double.execScripts.push({
      lines: [
        JSON.stringify({ v: 1, type: 'heartbeat', everything: 'new' }),
        JSON.stringify({ v: 1, type: 'output', stream: 'stdout', data: 'ok', future: true }),
        JSON.stringify({ v: 1, type: 'exit', exitCode: 0, reason: 'exited' }),
      ],
    });
    const events = await collect(port.exec('sess1', REQ));
    expect(events.map((e) => e.type)).toEqual(['started', 'output', 'exit']);
  });

  it('passes dropped and error events through', async () => {
    double.execScripts.push({
      lines: [
        JSON.stringify({ v: 1, type: 'dropped', scope: 'pre-start', bytes: 4096 }),
        JSON.stringify({ v: 1, type: 'error', code: 'container-died', message: 'gone' }),
      ],
    });
    const events = await collect(port.exec('sess1', REQ));
    expect(events[1]).toEqual({ v: 1, type: 'dropped', scope: 'pre-start', bytes: 4096 });
    expect(events[2]).toEqual({ v: 1, type: 'error', message: 'container-died: gone' });
  });

  it('surfaces a malformed wire line as SeamProtocolError', async () => {
    double.execScripts.push({ lines: ['{not-json'] });
    await expect(collect(port.exec('sess1', REQ))).rejects.toBeInstanceOf(SeamProtocolError);
  });

  it('throws SeamHttpError with status and body on a non-200 start (429 cap)', async () => {
    double.execScripts.push({ status: 429, errorBody: { error: 'too-many-concurrent-execs' } });
    const err = await collect(port.exec('sess1', REQ)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeamHttpError);
    expect((err as SeamHttpError).status).toBe(429);
    expect((err as SeamHttpError).body).toContain('too-many-concurrent-execs');
  });
});

describe('stdin delivery (ADR-003 prompts over a stdin-less seam)', () => {
  it('wraps argv so the payload rides as its own argv element into a pipe', async () => {
    double.execScripts.push({
      lines: [JSON.stringify({ v: 1, type: 'exit', exitCode: 0, reason: 'exited' })],
    });
    await collect(
      port.exec('sess1', { argv: ['claude', '-p'], stdin: 'the prompt', maxDurationMs: 1000 }),
    );
    const sent = double.execCalls[0]?.body as { cmd: string[] };
    expect(sent.cmd).toEqual([
      'bash',
      '-c',
      'printf %s "$1" | "${@:2}"',
      'hub_stdin',
      'the prompt',
      'claude',
      '-p',
    ]);
  });

  it('passes argv verbatim when there is no stdin', async () => {
    double.execScripts.push({
      lines: [JSON.stringify({ v: 1, type: 'exit', exitCode: 0, reason: 'exited' })],
    });
    await collect(port.exec('sess1', REQ));
    expect((double.execCalls[0]?.body as { cmd: string[] }).cmd).toEqual(['claude', '-p']);
  });

  it('never shell-interprets the payload (quoting/metacharacters survive as data)', async () => {
    double.execScripts.push({
      lines: [JSON.stringify({ v: 1, type: 'exit', exitCode: 0, reason: 'exited' })],
    });
    const hostile = '"; rm -rf / #$(reboot) `id` | tee';
    await collect(
      port.exec('sess1', { argv: ['claude'], stdin: hostile, maxDurationMs: 1000 }),
    );
    expect((double.execCalls[0]?.body as { cmd: string[] }).cmd[4]).toBe(hostile);
  });
});

describe('Hub-side validation (fail fast on seam limits)', () => {
  const noCall = (): void => {
    expect(double.execCalls).toHaveLength(0);
  };

  it('rejects an over-32KiB cmd before any HTTP call', async () => {
    const big = 'x'.repeat(33 * 1024);
    await expect(
      collect(port.exec('sess1', { argv: ['claude'], stdin: big, maxDurationMs: 1000 })),
    ).rejects.toBeInstanceOf(SeamValidationError);
    noCall();
  });

  it.each([
    ['bad name', { 'BAD-NAME': 'v' }],
    ['oversized value', { OK: 'v'.repeat(4097) }],
    [
      'too many entries',
      Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`VAR_${i}`, 'v'])),
    ],
  ])('rejects env with %s', async (_label, env) => {
    await expect(
      collect(port.exec('sess1', { ...REQ, env: env as Record<string, string> })),
    ).rejects.toBeInstanceOf(SeamValidationError);
    noCall();
  });

  it('rejects env totalling over 64 KiB', async () => {
    const env = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`VAR_${i}`, 'v'.repeat(4000)]),
    );
    await expect(collect(port.exec('sess1', { ...REQ, env }))).rejects.toBeInstanceOf(
      SeamValidationError,
    );
    noCall();
  });

  it('rejects maxDurationMs outside the seam range', async () => {
    await expect(
      collect(port.exec('sess1', { argv: ['claude'], maxDurationMs: 3_600_001 })),
    ).rejects.toBeInstanceOf(SeamValidationError);
    noCall();
  });
});

describe('auth (Q-04: dedicated account, JWT cookie)', () => {
  it('logs in once and reuses the cookie across calls', async () => {
    double.statusResponses.push({ body: { state: 'unknown' } }, { body: { state: 'unknown' } });
    await port.status('sess1', 'e_x');
    await port.status('sess1', 'e_y');
    expect(double.loginCount).toBe(1);
  });

  it('re-logs-in once on 401 and retries without double-running the exec', async () => {
    double.statusResponses.push({ body: { state: 'unknown' } });
    await port.status('sess1', 'e_x'); // establishes cookie #1
    double.expireAllCookies();
    double.execScripts.push({
      lines: [JSON.stringify({ v: 1, type: 'exit', exitCode: 0, reason: 'exited' })],
    });
    const events = await collect(port.exec('sess1', REQ));
    expect(events.map((e) => e.type)).toEqual(['started', 'exit']);
    expect(double.loginCount).toBe(2);
    // the 401'd attempt was rejected before the exec handler ran: the exec
    // executed exactly once (a stream POST retry is only safe pre-start)
    expect(double.execCalls).toHaveLength(1);
    expect(double.execScripts).toHaveLength(0); // exactly one script consumed
  });

  it('propagates a login failure as SeamAuthError', async () => {
    const bad = new RealSubstrateExecPort({
      baseUrl: double.baseUrl,
      auth: new CookieSeamAuth({
        baseUrl: double.baseUrl,
        username: double.username,
        password: 'wrong',
      }),
    });
    await expect(bad.status('sess1', 'e_x')).rejects.toBeInstanceOf(SeamAuthError);
  });
});

describe('status and kill mapping', () => {
  it('maps running / exited / unknown', async () => {
    double.statusResponses.push(
      { body: { execId: 'e', state: 'running', pgid: 9 } },
      { body: { execId: 'e', state: 'exited', exitCode: 15, reason: 'killed' } },
      { body: { execId: 'e', state: 'unknown' } },
    );
    expect(await port.status('s', 'e')).toEqual({ state: 'running' });
    expect(await port.status('s', 'e')).toEqual({ state: 'exited', exitCode: 15 });
    expect(await port.status('s', 'e')).toEqual({ state: 'unknown' });
  });

  it('passes kill outcomes through and sends graceMs', async () => {
    double.killResponses.push({ body: { outcome: 'terminated' } }, { body: { outcome: 'killed' } });
    expect(await port.kill('s', 'e', 5000)).toEqual({ outcome: 'terminated' });
    expect(await port.kill('s', 'e', 100)).toEqual({ outcome: 'killed' });
    expect(double.killCalls.map((c) => (c.body as { graceMs: number }).graceMs)).toEqual([
      5000, 100,
    ]);
  });

  it('collapses kill-404 (registry does not hold the id) into already-exited', async () => {
    double.killResponses.push({ status: 404, body: { error: 'unknown exec' } });
    expect(await port.kill('s', 'e_gone', 5000)).toEqual({ outcome: 'already-exited' });
  });

  it('surfaces kill 409 (pgid-unavailable) as SeamHttpError', async () => {
    double.killResponses.push({ status: 409, body: { error: 'pgid-unavailable' } });
    await expect(port.kill('s', 'e', 5000)).rejects.toBeInstanceOf(SeamHttpError);
  });
});

describe('parity with the fake port (doc 17 B2-01 "done when"; R-12)', () => {
  it('a normal completion yields the same event shapes from both ports', async () => {
    const fake = new FakeSubstrateExecPort();
    fake.enqueueFixture({ streamLines: ['line-1', 'line-2'], exitCode: 0 });
    const fakeEvents = await collect(fake.exec('fs', REQ));

    double.execScripts.push({
      lines: [
        JSON.stringify({ v: 1, type: 'output', stream: 'stdout', data: 'line-1\n' }),
        JSON.stringify({ v: 1, type: 'output', stream: 'stdout', data: 'line-2\n' }),
        JSON.stringify({ v: 1, type: 'exit', exitCode: 0 }),
      ],
    });
    const realEvents = await collect(port.exec('rs', REQ));

    expect(realEvents.map((e) => e.type)).toEqual(fakeEvents.map((e) => e.type));
    const stdout = (evts: SeamEvent[]): string =>
      evts
        .filter((e): e is SeamEvent & { type: 'output' } => e.type === 'output')
        .map((e) => e.data)
        .join('');
    expect(stdout(realEvents)).toBe(stdout(fakeEvents));
    expect(realEvents.at(-1)).toMatchObject({ type: 'exit', exitCode: 0 });
    expect(fakeEvents.at(-1)).toMatchObject({ type: 'exit', exitCode: 0 });
  });

  it('status of an unknown execId answers unknown from both ports', async () => {
    const fake = new FakeSubstrateExecPort();
    expect(await fake.status('fs', 'nope')).toEqual({ state: 'unknown' });
    double.statusResponses.push({ body: { state: 'unknown' } });
    expect(await port.status('rs', 'nope')).toEqual({ state: 'unknown' });
  });

  it('killing something already gone answers already-exited from both ports', async () => {
    const fake = new FakeSubstrateExecPort();
    expect(await fake.kill('fs', 'nope', 5000)).toEqual({ outcome: 'already-exited' });
    double.killResponses.push({ status: 404, body: { error: 'unknown exec' } });
    expect(await port.kill('rs', 'nope', 5000)).toEqual({ outcome: 'already-exited' });
  });
});
