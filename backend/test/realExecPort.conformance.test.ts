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

  it('maps a quota 429 on create to SeamHttpError', async () => {
    double.templateResponses.push({ body: { config: {} } });
    double.createResponses.push({
      status: 429,
      body: { error: 'session budget exceeded', cap: 'maxSessions' },
    });
    const err = await fastPort()
      .createSession('tpl', {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeamHttpError);
    expect((err as SeamHttpError).status).toBe(429);
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
