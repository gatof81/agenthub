/**
 * Real claude-cli RuntimeAdapter (B2-03, ADR-003): builds the per-turn CLI
 * invocation and drives it through the same shared mapping loop the fake
 * uses (adapterCore) — command construction is the ONLY difference between
 * the two implementations, which is what makes the B2-04 real-vs-fake
 * contract test meaningful (R-12).
 *
 * S-01 lessons encoded here:
 * - `--allowedTools` is variadic and eats positional prompts → the prompt
 *   always rides `ExecRequest.stdin` (the real port delivers it through its
 *   injection-safe wrapper; the seam has no stdin channel).
 * - `--resume ''` also eats the prompt → the falsy check below covers both
 *   null (first turn, FR-24) and empty string.
 * - An absent allowlist means headless silent auto-denial (R-03) → an empty
 *   policy is rejected at this boundary too (I-7).
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

export class ClaudeCliRuntimeAdapter implements RuntimeAdapter {
  constructor(private readonly port: SubstrateExecPort) {}

  /** ADR-003 §Command construction (per turn). */
  buildExecRequest(turn: TurnRequest): ExecRequest {
    if (turn.policy.length === 0) {
      throw new Error(
        'claude-cli adapter: empty tool policy is unrepresentable (I-7) — a headless run without --allowedTools silently auto-denies (R-03)',
      );
    }
    return {
      argv: [
        'claude',
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
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
