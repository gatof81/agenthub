/**
 * B2-03 command construction + B2-04 real-vs-fake adapter contract test
 * (doc 17; R-12, 13 §2): both adapters must produce IDENTICAL AdapterItem
 * streams from the same S-01 fixtures — the mapping loop is shared by
 * construction, so what this pins is that neither implementation grows a
 * divergent code path. The last block runs the real adapter over the real
 * HTTP port (SeamDouble) to close the full real-stack chain.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdapterItem, TurnRequest } from '../src/domain/ports.js';
import { ClaudeCliRuntimeAdapter } from '../src/runtime/claudeCliAdapter.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import { RealSubstrateExecPort } from '../src/substrate/real.js';
import { CookieSeamAuth } from '../src/substrate/seamAuth.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';
import { SeamDouble } from './seamDouble.js';

const TURN: TurnRequest = {
  prompt: 'do the thing',
  policy: ['Read', 'Grep', 'Bash'],
  caps: { maxTurns: 30, budgetUsd: 2, timeoutMs: 600_000 },
  runtimeSessionId: null,
  env: { HUB_RUN_ID: 'run_test' },
};

const collect = async (iter: AsyncIterable<AdapterItem>): Promise<AdapterItem[]> => {
  const items: AdapterItem[] = [];
  for await (const i of iter) items.push(i);
  return items;
};

/** started carries port-generated ids — normalize so streams compare on substance. */
const normalized = (items: AdapterItem[]): AdapterItem[] =>
  items.map((i) => (i.kind === 'started' ? ({ kind: 'started' } as unknown as AdapterItem) : i));

describe('B2-03 — claude-cli command construction (ADR-003)', () => {
  const adapter = new ClaudeCliRuntimeAdapter(new FakeSubstrateExecPort());

  it('builds the first-turn invocation: no --resume, prompt via stdin', () => {
    const req = adapter.buildExecRequest(TURN);
    expect(req.argv).toEqual([
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      'Read',
      'Grep',
      'Bash',
      '--max-turns',
      '30',
    ]);
    expect(req.stdin).toBe('do the thing');
    expect(req.env).toEqual({ HUB_RUN_ID: 'run_test' });
    expect(req.maxDurationMs).toBe(600_000);
  });

  it('appends --resume on subsequent turns (FR-24)', () => {
    const req = adapter.buildExecRequest({ ...TURN, runtimeSessionId: 'sess-abc' });
    expect(req.argv.slice(-2)).toEqual(['--resume', 'sess-abc']);
  });

  it('omits --resume for an empty-string id (the S-01 prompt-eating trap)', () => {
    const req = adapter.buildExecRequest({ ...TURN, runtimeSessionId: '' });
    expect(req.argv).not.toContain('--resume');
  });

  it('rejects an empty policy (I-7 — silent auto-denial is unrepresentable)', () => {
    expect(() => adapter.buildExecRequest({ ...TURN, policy: [] })).toThrow(/I-7/);
  });
});

describe('B2-04 — real and fake adapters produce identical item streams (R-12)', () => {
  const phases = Object.values(FIXTURES);

  it.each(phases)('fixture %s: identical AdapterItem streams', async (phase) => {
    const lines = fixtureStreamLines(phase);

    const fakePort1 = new FakeSubstrateExecPort();
    fakePort1.enqueueFixture({ streamLines: lines });
    const fakeItems = await collect(new FakeRuntimeAdapter(fakePort1).runTurn('s', TURN));

    const fakePort2 = new FakeSubstrateExecPort();
    fakePort2.enqueueFixture({ streamLines: lines });
    const realItems = await collect(new ClaudeCliRuntimeAdapter(fakePort2).runTurn('s', TURN));

    expect(realItems).toEqual(fakeItems);
    expect(realItems.length).toBeGreaterThan(2); // started + mapped events + exit
  });

  it.each(phases)('fixture %s: identical under odd chunk splits', async (phase) => {
    const lines = fixtureStreamLines(phase);

    const whole = new FakeSubstrateExecPort();
    whole.enqueueFixture({ streamLines: lines });
    const wholeItems = await collect(new ClaudeCliRuntimeAdapter(whole).runTurn('s', TURN));

    const split = new FakeSubstrateExecPort();
    split.enqueueFixture({ streamLines: lines, splitChunks: true });
    const splitItems = await collect(new ClaudeCliRuntimeAdapter(split).runTurn('s', TURN));

    expect(splitItems).toEqual(wholeItems);
  });

  it('the two adapters differ only in the documented argv shape', () => {
    const port = new FakeSubstrateExecPort();
    const fakeReq = new FakeRuntimeAdapter(port).buildExecRequest(TURN);
    const realReq = new ClaudeCliRuntimeAdapter(port).buildExecRequest(TURN);
    expect(fakeReq.stdin).toEqual(realReq.stdin);
    expect(fakeReq.env).toEqual(realReq.env);
    expect(fakeReq.maxDurationMs).toEqual(realReq.maxDurationMs);
    expect(realReq.argv[0]).toBe('claude');
    expect(fakeReq.argv[0]).toBe('fake-runtime');
    // both carry the same policy and caps flags
    expect(realReq.argv.join(' ')).toContain('--allowedTools Read Grep Bash --max-turns 30');
    expect(fakeReq.argv.join(' ')).toContain('--allowedTools Read Grep Bash --max-turns 30');
  });
});

describe('B2-04 full real stack — claude-cli adapter over the real HTTP port', () => {
  let double: SeamDouble;

  beforeEach(async () => {
    double = new SeamDouble();
    await double.start();
  });

  afterEach(async () => {
    await double.stop();
  });

  it('baseline fixture through RealSubstrateExecPort matches the fake stack', async () => {
    const lines = fixtureStreamLines(FIXTURES.baseline);

    const fakePort = new FakeSubstrateExecPort();
    fakePort.enqueueFixture({ streamLines: lines });
    const fakeStack = await collect(new FakeRuntimeAdapter(fakePort).runTurn('s', TURN));

    double.execScripts.push({
      chunkMode: 'split-mid-line',
      lines: lines.map((l) =>
        JSON.stringify({ v: 1, type: 'output', stream: 'stdout', data: `${l}\n` }),
      ),
    });
    // the double streams exit as a wire event after the scripted lines
    double.execScripts[0]!.lines!.push(
      JSON.stringify({ v: 1, type: 'exit', exitCode: 0, reason: 'exited' }),
    );
    const realPort = new RealSubstrateExecPort({
      baseUrl: double.baseUrl,
      auth: new CookieSeamAuth({
        baseUrl: double.baseUrl,
        username: double.username,
        password: double.password,
      }),
    });
    const realStack = await collect(new ClaudeCliRuntimeAdapter(realPort).runTurn('s', TURN));

    expect(normalized(realStack)).toEqual(normalized(fakeStack));
    // and the wire carried the ADR-003 argv through the port's stdin wrapper
    const sent = double.execCalls[0]?.body as { cmd: string[] };
    expect(sent.cmd.slice(0, 4)).toEqual(['bash', '-c', 'printf %s "$1" | "${@:2}"', 'hub_stdin']);
    expect(sent.cmd[4]).toBe('do the thing');
    expect(sent.cmd[5]).toBe('claude');
  });
});
