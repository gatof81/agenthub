/**
 * Fake RuntimeAdapter (A1, B1-07): deterministic peer of the future
 * claude-cli adapter (R-12). It builds a fake exec request and pushes the
 * port's stream through the EXACT ADR-003 mapping — the same code path the
 * real adapter will use, so fixture-driven contract tests pin both.
 */

import type {
  AdapterItem,
  ExecRequest,
  ExecStatus,
  RuntimeAdapter,
  SubstrateExecPort,
  TurnRequest,
} from '../domain/ports.js';
import type { KillOutcome } from '../domain/types.js';
import { runExecThroughMapping } from './adapterCore.js';

export class FakeRuntimeAdapter implements RuntimeAdapter {
  constructor(private readonly port: SubstrateExecPort) {}

  buildExecRequest(turn: TurnRequest): ExecRequest {
    // Mirrors the ADR-003 shape (allowlist never absent, prompt via stdin)
    // without invoking any real binary.
    return {
      argv: [
        'fake-runtime',
        '--allowedTools',
        ...turn.policy,
        '--max-turns',
        String(turn.caps.maxTurns),
        ...(turn.runtimeSessionId ? ['--resume', turn.runtimeSessionId] : []),
      ],
      stdin: turn.prompt,
      env: turn.env,
      maxDurationMs: turn.caps.timeoutMs,
    };
  }

  runTurn(sessionId: string, turn: TurnRequest): AsyncIterable<AdapterItem> {
    return runExecThroughMapping(this.port, sessionId, this.buildExecRequest(turn));
  }

  kill(sessionId: string, execId: string, graceMs: number): Promise<{ outcome: KillOutcome }> {
    return this.port.kill(sessionId, execId, graceMs);
  }

  status(sessionId: string, execId: string): Promise<ExecStatus> {
    return this.port.status(sessionId, execId);
  }
}
