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
 *
 * B5-04: `--append-system-prompt` is verified against the pinned CLI, not
 * assumed (ADR-006 left the mechanism unasserted) — a live headless turn was
 * given a codeword it could not otherwise know and echoed it back
 * (docs/spikes/S-04/RESULTS.md). The instruction rides argv, which shares the
 * seam's 32 KiB command cap with the prompt; the real port validates that cap,
 * so an over-long role fails at the boundary rather than mid-turn.
 * `--append-system-prompt-file` exists on the same CLI if that day comes.
 */

import { setTimeout as sleep } from 'node:timers/promises';
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

/** The runtime never became runnable in a provisioned session (B3-08). */
export class RuntimeNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeNotReadyError';
  }
}

/**
 * Readiness probe: resolve the CLI the same way a turn's argv will — through
 * PATH, in a non-interactive shell. `command -v` is a bash builtin, so it
 * costs no process beyond the shell and answers exactly the question that
 * matters ("would `claude` resolve right now?").
 */
const PROBE_ARGV = ['bash', '-c', 'command -v claude'];
const PROBE_MAX_DURATION_MS = 10_000;
const DEFAULT_READINESS_POLL_MS = 500;
const DEFAULT_READINESS_TIMEOUT_MS = 60_000;

export interface ClaudeCliAdapterOptions {
  /** Readiness-probe pacing (B3-08); defaults: poll 500 ms, give up after 60 s. */
  readiness?: { pollIntervalMs?: number; timeoutMs?: number };
}

export class ClaudeCliRuntimeAdapter implements RuntimeAdapter {
  constructor(
    private readonly port: SubstrateExecPort,
    private readonly opts: ClaudeCliAdapterOptions = {},
  ) {}

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
        // Must stay AFTER `--max-turns`: `--allowedTools` is variadic and
        // would swallow this flag as a tool name (the same S-01 trap that
        // sends the prompt through stdin).
        ...(turn.instructions ? ['--append-system-prompt', turn.instructions] : []),
      ],
      stdin: turn.prompt,
      env: turn.env,
      ...(turn.workingDir ? { workingDir: turn.workingDir } : {}),
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

  /**
   * Poll until `claude` resolves on PATH (B3-08).
   *
   * Why this is needed even though the session reports provisioned: the CLI
   * lives in `~/.npm-global/bin`, which the session image's entrypoint
   * REPLACES with a symlink into the bind-mounted workspace on every boot so
   * self-updates persist (verified at shared-terminal `3f1b9e7`:
   * `session-image/entrypoint.sh:130` `mv ~/.npm-global ~/.npm-global.old`
   * then `:133` `ln -sfn ~/workspace/.npm-global ~/.npm-global`). Between
   * those two lines the directory is absent and every PATH lookup of
   * `claude` fails — and on a first boot the preceding `cp -a` (`:102`)
   * copies the whole CLI install into the mount, widening the window to
   * seconds.
   *
   * Nothing synchronises that window with the session lifecycle: upstream's
   * `container.start()` returns when Docker starts the process, not when the
   * entrypoint finishes (`backend/src/dockerManager.ts:531`), and our own
   * bootstrap (an agentSeed write — two files) can finish first. So the
   * seam's `bootstrap_log != null && status != failed` can be true while the
   * runtime is still unusable, which surfaced as a `claude: command not
   * found` on a fresh session's first turn.
   *
   * The durable fix is an upstream readiness marker (the entrypoint already
   * logs "container ready" at `:405`, but nothing exposes it); until that
   * exists this probe converts a mid-turn runtime_error into a provisioning
   * failure the user sees before a turn is ever billed. A permanently broken
   * swap (the entrypoint's own WARN branch at `:119`) fails the deadline —
   * correctly, since no turn would ever run.
   */
  async awaitReady(sessionId: string): Promise<void> {
    const pollIntervalMs = this.opts.readiness?.pollIntervalMs ?? DEFAULT_READINESS_POLL_MS;
    const timeoutMs = this.opts.readiness?.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    // every path through the loop body assigns this before the deadline
    // check can read it, so an initializer here would be dead code
    let lastDetail: string;
    for (;;) {
      try {
        const exitCode = await this.probeOnce(sessionId);
        if (exitCode === 0) return;
        lastDetail = `probe exited ${exitCode ?? 'null'} (claude not on PATH yet)`;
      } catch (err) {
        // A probe that cannot even dispatch (seam hiccup, container still
        // coming up) is indistinguishable from "not ready" and is retried;
        // the deadline is the only thing that ends this loop unhappily.
        lastDetail = (err as Error).message;
      }
      if (Date.now() >= deadline) {
        throw new RuntimeNotReadyError(
          `claude-cli did not become runnable in session ${sessionId} within ${timeoutMs} ms — last probe: ${lastDetail}`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  /** One probe exec; resolves its exit code, throws if the stream gave none. */
  private async probeOnce(sessionId: string): Promise<number | null> {
    let exit: { exitCode: number | null } | null = null;
    for await (const event of this.port.exec(sessionId, {
      argv: PROBE_ARGV,
      maxDurationMs: PROBE_MAX_DURATION_MS,
    })) {
      if (event.type === 'exit') exit = { exitCode: event.exitCode };
    }
    if (exit === null) throw new Error('probe stream ended without an exit event');
    return exit.exitCode;
  }
}
