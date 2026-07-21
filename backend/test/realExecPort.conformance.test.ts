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
  SeamProvisioningError,
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

describe('transport timeouts (#116: a stalled seam must not wedge the queue)', () => {
  const timeoutPort = (transport: {
    requestTimeoutMs?: number;
    streamIdleTimeoutMs?: number;
  }): RealSubstrateExecPort =>
    new RealSubstrateExecPort({
      baseUrl: double.baseUrl,
      auth: new CookieSeamAuth({
        baseUrl: double.baseUrl,
        username: double.username,
        password: double.password,
      }),
      transport,
    });

  it('unwinds a half-open exec stream as SeamProtocolError instead of hanging', async () => {
    // The seam opens the NDJSON stream (200 headers) then never yields a line
    // and never closes it — the exact wedge from #116.
    double.execScripts.push({ hang: true });
    const port = timeoutPort({ streamIdleTimeoutMs: 40 });
    const err = await collect(port.exec('sess1', REQ)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeamProtocolError);
    expect((err as Error).message).toMatch(/idle/);
  });

  it('resets the idle deadline on each chunk — a slow-but-live stream completes', async () => {
    // Chunks land ~1 ms apart (split-mid-line), comfortably under the 200 ms
    // idle window, so an actively-streaming turn is never falsely timed out.
    double.execScripts.push({
      chunkMode: 'split-mid-line',
      lines: [
        JSON.stringify({ v: 1, type: 'output', stream: 'stdout', data: 'streaming-payload-1\n' }),
        JSON.stringify({ v: 1, type: 'output', stream: 'stdout', data: 'streaming-payload-2\n' }),
        JSON.stringify({ v: 1, type: 'exit', exitCode: 0, reason: 'exited' }),
      ],
    });
    const port = timeoutPort({ streamIdleTimeoutMs: 200 });
    const events = await collect(port.exec('sess1', REQ));
    expect(events.map((e) => e.type)).toEqual(['started', 'output', 'output', 'exit']);
  });

  it('unwinds a stalled non-streaming call (status) as SeamProtocolError', async () => {
    double.statusResponses.push({ hang: true });
    const port = timeoutPort({ requestTimeoutMs: 40 });
    await expect(port.status('sess1', 'e_x')).rejects.toBeInstanceOf(SeamProtocolError);
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

describe('session provisioning (B2-02: template → create → agentSeed → bootstrap wait)', () => {
  const fastPort = (): RealSubstrateExecPort =>
    new RealSubstrateExecPort({
      baseUrl: double.baseUrl,
      auth: new CookieSeamAuth({
        baseUrl: double.baseUrl,
        username: double.username,
        password: double.password,
      }),
      provisioning: { pollIntervalMs: 1, timeoutMs: 250 },
    });

  it('materializes the template config, folds the seed in, and waits for bootstrap', async () => {
    double.templateResponses.push({
      body: {
        id: 'tpl-dev',
        name: 'dev template',
        config: { cpuLimit: 2, agentSeed: { settings: '{"theme":"tpl"}' } },
      },
    });
    double.createResponses.push({
      status: 201,
      body: { sessionId: 'sess_new', status: 'running', bootstrapping: true },
    });
    double.metaResponses.push(
      { body: { sessionId: 'sess_new', status: 'running' } },
      { body: { sessionId: 'sess_new', status: 'running' } },
    );
    double.bootstrapLogResponses.push({ body: { log: null } }, { body: { log: 'seeded ok\n' } });

    const { sessionId } = await fastPort().createSession('tpl-dev', {
      claudeMd: '# instructions',
    });
    expect(sessionId).toBe('sess_new');
    expect(double.templateCalls).toEqual(['tpl-dev']);
    const sent = double.createCalls[0] as {
      name: string;
      config: { cpuLimit: number; agentSeed: Record<string, unknown> };
    };
    expect(sent.name).toMatch(/^hub-[0-9a-f]{8}$/);
    expect(sent.config.cpuLimit).toBe(2); // template config preserved
    expect(sent.config.agentSeed).toEqual({
      settings: '{"theme":"tpl"}', // template field kept (seed did not set it)
      claudeMd: '# instructions', // seed field folded in
    });
    expect(double.bootstrapLogCalls.length).toBe(2); // polled until the log landed
  });

  it('seed fields override the template agentSeed per-field, but never its settings (S-05)', async () => {
    double.templateResponses.push({
      body: { config: { agentSeed: { settings: '{"theme":"tpl"}', claudeMd: 'template md' } } },
    });
    double.createResponses.push({
      status: 201,
      body: { sessionId: 'sess_o', status: 'running' }, // no bootstrapping flag
    });
    await fastPort().createSession('tpl', { claudeMd: 'seeded md' });
    const sent = double.createCalls[0] as { config: { agentSeed: unknown } };
    expect(sent.config.agentSeed).toEqual({
      claudeMd: 'seeded md', // seed field folded in over the template's
      // The template's settings survive because the Hub sends none. There is
      // no seed shape that can reach this field: `SessionSeed` has no
      // `settings` (S-05), so a workspace can never be handed one role's
      // tool allowlist.
      settings: '{"theme":"tpl"}',
    });
  });

  it('rejects an agentSeed field over the seam 256 KiB cap before any create', async () => {
    double.templateResponses.push({ body: { config: {} } });
    const err = await fastPort()
      .createSession('tpl', { claudeMd: 'x'.repeat(257 * 1024) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeamValidationError);
    expect(double.createCalls).toHaveLength(0);
  });

  it('skips the bootstrap wait when the create is not bootstrapping', async () => {
    double.templateResponses.push({ body: { config: {} } });
    double.createResponses.push({ status: 201, body: { sessionId: 'sess_b', status: 'running' } });
    const { sessionId } = await fastPort().createSession('tpl', {});
    expect(sessionId).toBe('sess_b');
    expect(double.metaCalls).toHaveLength(0);
    expect(double.bootstrapLogCalls).toHaveLength(0);
  });

  it('surfaces a bootstrap hard-fail with the log tail as SeamProvisioningError', async () => {
    double.templateResponses.push({ body: { config: {} } });
    double.createResponses.push({
      status: 201,
      body: { sessionId: 'sess_f', status: 'running', bootstrapping: true },
    });
    double.metaResponses.push({ body: { sessionId: 'sess_f', status: 'failed' } });
    double.bootstrapLogResponses.push({ body: { log: 'cloning...\nagentSeed: EACCES\n' } });
    const err = await fastPort()
      .createSession('tpl', { claudeMd: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeamProvisioningError);
    expect((err as SeamProvisioningError).bootstrapLog).toContain('agentSeed: EACCES');
  });

  it('catches the log-before-status-flip race: log lands, then status flips to failed', async () => {
    // upstream failure order is persistLog THEN updateStatus('failed')
    // (bootstrap.ts finishWithFail) — a log-first read must not be
    // declared ready until the status is re-confirmed
    double.templateResponses.push({ body: { config: {} } });
    double.createResponses.push({
      status: 201,
      body: { sessionId: 'sess_race', status: 'running', bootstrapping: true },
    });
    double.metaResponses.push(
      { body: { sessionId: 'sess_race', status: 'running' } }, // poll: pre-flip window
      { body: { sessionId: 'sess_race', status: 'failed' } }, // confirm: flip landed
    );
    double.bootstrapLogResponses.push({ body: { log: 'agentSeed: exit 1\n' } });
    const err = await fastPort()
      .createSession('tpl', { claudeMd: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeamProvisioningError);
    expect((err as SeamProvisioningError).bootstrapLog).toContain('agentSeed: exit 1');
  });

  it('times out when the bootstrap never finishes', async () => {
    double.templateResponses.push({ body: { config: {} } });
    double.createResponses.push({
      status: 201,
      body: { sessionId: 'sess_t', status: 'running', bootstrapping: true },
    });
    // defaults in the double keep answering running + log:null
    const err = await fastPort()
      .createSession('tpl', { claudeMd: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeamProvisioningError);
    expect((err as Error).message).toContain('did not finish');
  });

  it('maps a budget 429 on create to a provisioning error naming the cap (N2)', async () => {
    double.templateResponses.push({ body: { config: {} } });
    // budget cap wire shape at 1a5af57 (routes/sessions.ts:273): {error, cap}
    // with cap ∈ "cpu"|"mem". Self-owned create → scope "account".
    double.createResponses.push({
      status: 429,
      body: { error: 'CPU budget exceeded', cap: 'cpu' },
    });
    const err = await fastPort()
      .createSession('tpl', {})
      .catch((e: unknown) => e);
    // 429 is a quota/provisioning failure, not a generic transport error:
    // SeamProvisioningError with the cap named. More descriptive than the
    // pre-N2 bare SeamHttpError.
    expect(err).toBeInstanceOf(SeamProvisioningError);
    expect((err as Error).message).toMatch(/account cpu quota exceeded/);
  });

  it('maps a session-count 429 on create naming the count cap (N2)', async () => {
    double.templateResponses.push({ body: { config: {} } });
    // session-count wire shape at 1a5af57 (routes/sessions.ts:451): {error, quota:<n>}
    double.createResponses.push({
      status: 429,
      body: { error: 'Active session limit (50) reached', quota: 50 },
    });
    const err = await fastPort()
      .createSession('tpl', {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeamProvisioningError);
    expect((err as Error).message).toMatch(/account session-count quota exceeded/);
  });

  it('propagates an unknown template as SeamHttpError 404', async () => {
    double.templateResponses.push({ status: 404, body: { error: 'Template not found' } });
    const err = await fastPort()
      .createSession('nope', {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeamHttpError);
    expect((err as SeamHttpError).status).toBe(404);
  });

  it('stopSession posts to /stop, tolerates 404, throws on 5xx', async () => {
    const p = fastPort();
    await p.stopSession('sess_1');
    expect(double.stopCalls).toEqual(['sess_1']);
    double.stopResponses.push({ status: 404, body: { error: 'Session not found' } });
    await expect(p.stopSession('sess_gone')).resolves.toBeUndefined();
    double.stopResponses.push({ status: 500, body: { error: 'boom' } });
    await expect(p.stopSession('sess_1')).rejects.toBeInstanceOf(SeamHttpError);
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
        // reason always present on the wire (exec.ts:255 — `?? "exited"`)
        JSON.stringify({ v: 1, type: 'exit', exitCode: 0, reason: 'exited' }),
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
    expect(realEvents.at(-1)).toEqual({ v: 1, type: 'exit', exitCode: 0, reason: 'exited' });
    expect(fakeEvents.at(-1)).toEqual({ v: 1, type: 'exit', exitCode: 0, reason: 'exited' });
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

  it('createSession resolves to {sessionId} and stopSession to void from both ports', async () => {
    const fake = new FakeSubstrateExecPort();
    const seed = { claudeMd: 'md' };
    const fakeCreated = await fake.createSession('tpl', seed);
    expect(fakeCreated.sessionId).toMatch(/\S/);
    await expect(fake.stopSession(fakeCreated.sessionId)).resolves.toBeUndefined();

    double.templateResponses.push({ body: { config: {} } });
    double.createResponses.push({ status: 201, body: { sessionId: 'sess_p', status: 'running' } });
    const realCreated = await port.createSession('tpl', seed);
    expect(realCreated.sessionId).toMatch(/\S/);
    await expect(port.stopSession(realCreated.sessionId)).resolves.toBeUndefined();
  });
});

describe('session discovery (N1, FR-48, ADR-007)', () => {
  /** A wire-accurate serializeMeta row (0cd4ed5) with noise the port must drop. */
  const wireRow = (over: Record<string, unknown>): Record<string, unknown> => ({
    sessionId: 's_x',
    name: 'sess',
    status: 'running',
    containerId: 'abc123def456',
    containerName: 'st-abc',
    createdAt: '2026-07-17T00:00:00.000Z',
    lastConnectedAt: null,
    cols: 80,
    rows: 24,
    envVars: { SECRET_TOKEN: 'hunter2' },
    cpuLimit: null,
    memLimit: null,
    usage: null,
    ...over,
  });

  it('admin-flagged identity lists the whole estate with owner attribution (scope all)', async () => {
    double.adminListResponses.push({
      body: [
        wireRow({ sessionId: 's_edu', name: 'Education Hz', userId: 'u1', ownerUsername: 'owner-admin' }),
        wireRow({ sessionId: 's_hub', name: 'hub-1234', status: 'stopped', userId: 'u2', ownerUsername: 'hub-service' }),
      ],
    });
    const listing = await port.listSessions();
    expect(listing.scope).toBe('all');
    expect(listing.sessions).toEqual([
      {
        sessionId: 's_edu',
        name: 'Education Hz',
        status: 'running',
        ownerUsername: 'owner-admin',
        createdAt: '2026-07-17T00:00:00.000Z',
        lastConnectedAt: null,
        externalRef: null,
      },
      {
        sessionId: 's_hub',
        name: 'hub-1234',
        status: 'stopped',
        ownerUsername: 'hub-service',
        createdAt: '2026-07-17T00:00:00.000Z',
        lastConnectedAt: null,
        externalRef: null,
      },
    ]);
    expect(double.ownListCalls).toBe(0);
  });

  it('403 on the admin listing degrades to scope own, attributed to selfUsername (FR-48)', async () => {
    double.isAdmin = false;
    double.ownListResponses.push({ body: [wireRow({ sessionId: 's_mine', name: 'hub-abcd' })] });
    const selfPort = new RealSubstrateExecPort({
      baseUrl: double.baseUrl,
      auth: new CookieSeamAuth({
        baseUrl: double.baseUrl,
        username: double.username,
        password: double.password,
      }),
      selfUsername: 'hub-service',
    });
    const listing = await selfPort.listSessions();
    expect(listing.scope).toBe('own');
    expect(listing.sessions[0]?.ownerUsername).toBe('hub-service');
    expect(double.adminListCalls).toBe(1);
  });

  it('a non-403 admin-listing failure surfaces — never silently degraded to own scope', async () => {
    double.adminListResponses.push({ status: 500, body: { error: 'boom' } });
    await expect(port.listSessions()).rejects.toBeInstanceOf(SeamHttpError);
    expect(double.ownListCalls).toBe(0);
  });

  it('envVars and container details never cross the port boundary (SEC-04/05)', async () => {
    double.adminListResponses.push({ body: [wireRow({ ownerUsername: 'o' })] });
    const listing = await port.listSessions();
    const flat = JSON.stringify(listing);
    expect(flat).not.toContain('hunter2');
    expect(flat).not.toContain('envVars');
    expect(flat).not.toContain('containerId');
  });

  it('getSession returns metadata for a live session and null for a 404 (FR-44)', async () => {
    double.metaResponses.push({ body: wireRow({ sessionId: 's_live', runtimeReady: true }) });
    const live = await port.getSession('s_live');
    expect(live).toEqual({
      sessionId: 's_live',
      name: 'sess',
      status: 'running',
      ownerUsername: null,
      createdAt: '2026-07-17T00:00:00.000Z',
      lastConnectedAt: null,
      externalRef: null,
    });
    double.metaResponses.push({ status: 404, body: { error: 'Session not found' } });
    expect(await port.getSession('s_gone')).toBeNull();
  });

  it('fake parity: created sessions appear in the listing; gone ones vanish (R-12)', async () => {
    const fake = new FakeSubstrateExecPort();
    fake.seedSession({
      sessionId: 's_seed',
      name: 'Education Hz',
      status: 'running',
      ownerUsername: 'owner-admin',
      createdAt: null,
      lastConnectedAt: null,
      externalRef: null,
    });
    const { sessionId } = await fake.createSession('tpl', {});
    let listing = await fake.listSessions();
    expect(listing.scope).toBe('all');
    expect(listing.sessions.map((s) => s.sessionId).sort()).toEqual([sessionId, 's_seed'].sort());
    expect(await fake.getSession('s_seed')).not.toBeNull();

    fake.markSessionGone('s_seed');
    listing = await fake.listSessions();
    expect(listing.sessions.map((s) => s.sessionId)).toEqual([sessionId]);
    expect(await fake.getSession('s_seed')).toBeNull();
  });
});

describe('session external_ref (N2, shared-terminal#418)', () => {
  it('setSessionExternalRef PATCHes the ref and null clears it', async () => {
    double.patchRefResponses.push({ body: { sessionId: 's1', status: 'running' } });
    double.patchRefResponses.push({ body: { sessionId: 's1', status: 'running' } });
    await port.setSessionExternalRef('s1', 'agenthub:project:p1');
    await port.setSessionExternalRef('s1', null);
    expect(double.patchRefCalls).toEqual([
      { sessionId: 's1', externalRef: 'agenthub:project:p1' },
      { sessionId: 's1', externalRef: null },
    ]);
  });

  it('a failed PATCH surfaces as SeamHttpError', async () => {
    double.patchRefResponses.push({ status: 404, body: { error: 'Session not found' } });
    await expect(port.setSessionExternalRef('s_gone', 'x')).rejects.toBeInstanceOf(SeamHttpError);
  });

  it('createSession sends externalRef as a TOP-LEVEL create field, not config', async () => {
    double.templateResponses.push({ body: { config: {} } });
    double.createResponses.push({ status: 201, body: { sessionId: 's_new', status: 'running' } });
    await port.createSession('tpl', { externalRef: 'agenthub:project:p9' });
    const call = double.createCalls[0] as Record<string, unknown>;
    expect(call.externalRef).toBe('agenthub:project:p9');
    expect((call.config as Record<string, unknown>).externalRef).toBeUndefined();
  });

  it('listing rows surface externalRef; fake parity via setSessionExternalRef (R-12)', async () => {
    double.adminListResponses.push({
      body: [
        {
          sessionId: 's_ref',
          name: 'n',
          status: 'running',
          createdAt: '2026-07-17T00:00:00.000Z',
          lastConnectedAt: null,
          envVars: {},
          ownerUsername: 'o',
          externalRef: 'agenthub:project:p1',
        },
      ],
    });
    const listing = await port.listSessions();
    expect(listing.sessions[0]?.externalRef).toBe('agenthub:project:p1');

    const fake = new FakeSubstrateExecPort();
    const { sessionId } = await fake.createSession('tpl', {});
    await fake.setSessionExternalRef(sessionId, 'agenthub:project:p1');
    expect((await fake.getSession(sessionId))?.externalRef).toBe('agenthub:project:p1');
    await fake.setSessionExternalRef(sessionId, null);
    expect((await fake.getSession(sessionId))?.externalRef).toBeNull();
    await expect(fake.setSessionExternalRef('s_unknown', 'x')).rejects.toThrow(/unknown session/);
  });
});

describe('create-on-behalf (N2, shared-terminal#420)', () => {
  it('sends ownerUserId when configured and returns it (owner-account create)', async () => {
    const onBehalf = new RealSubstrateExecPort({
      baseUrl: double.baseUrl,
      auth: new CookieSeamAuth({
        baseUrl: double.baseUrl,
        username: double.username,
        password: double.password,
      }),
      ownerUserId: 'owner-uuid-1',
    });
    double.templateResponses.push({ body: { config: {} } });
    double.createResponses.push({ status: 201, body: { sessionId: 's_owned', status: 'running' } });
    const created = await onBehalf.createSession('tpl', { externalRef: 'agenthub:project:p1' });
    expect(created).toEqual({ sessionId: 's_owned', ownerUserId: 'owner-uuid-1' });
    const body = double.createCalls[0] as Record<string, unknown>;
    expect(body.ownerUserId).toBe('owner-uuid-1');
    expect(body.externalRef).toBe('agenthub:project:p1');
  });

  it('omits ownerUserId and returns null when not configured (self-owned)', async () => {
    double.templateResponses.push({ body: { config: {} } });
    double.createResponses.push({ status: 201, body: { sessionId: 's_self', status: 'running' } });
    const created = await port.createSession('tpl', {});
    expect(created.ownerUserId).toBeNull();
    expect((double.createCalls[0] as Record<string, unknown>).ownerUserId).toBeUndefined();
  });

  it('maps a 429 (owner quota) to a provisioning error naming the cap', async () => {
    const onBehalf = new RealSubstrateExecPort({
      baseUrl: double.baseUrl,
      auth: new CookieSeamAuth({
        baseUrl: double.baseUrl,
        username: double.username,
        password: double.password,
      }),
      ownerUserId: 'owner-uuid-1',
    });
    double.templateResponses.push({ body: { config: {} } });
    double.createResponses.push({ status: 429, body: { error: 'cpu budget exceeded', cap: 'cpu' } });
    await expect(onBehalf.createSession('tpl', {})).rejects.toThrow(/owner cpu quota exceeded/);
  });

  it('fake parity: createOnBehalfUserId flips the returned ownerUserId (R-12)', async () => {
    const fake = new FakeSubstrateExecPort();
    expect((await fake.createSession('tpl', {})).ownerUserId).toBeNull();
    fake.createOnBehalfUserId = 'owner-uuid-1';
    expect((await fake.createSession('tpl', {})).ownerUserId).toBe('owner-uuid-1');
  });
});
