/**
 * Real SubstrateExecPort (B2-01): thin HTTP client over the seam's exec API
 * (canonical contract: shared-terminal docs/EXEC_API.md, tracked in
 * docs/contracts/shared-terminal-exec-api.md). Scope is exec/status/kill —
 * session provisioning is B2-02.
 *
 * Contract facts this client encodes:
 * - NDJSON chunks are not line-aligned: lines are reassembled here.
 * - Unknown event types and unknown fields are ignored (forward compat, v:1).
 * - Status answers `unknown` for lost-registry and never-existed alike.
 * - Kill keeps 404 for unknown execIds; at the port boundary that collapses
 *   into the tolerant `already-exited` no-op (the fake's semantics — the
 *   orchestrator treats both as "nothing left to kill").
 * - The seam has NO stdin channel (verified: exec route schema at
 *   shared-terminal `6291397` is cmd/env/workingDir/maxDurationMs). ADR-003
 *   prompts ride stdin, so `ExecRequest.stdin` is delivered via an
 *   injection-safe wrapper: the payload travels as its own argv element
 *   (never shell-interpreted) and reaches the real command's stdin through
 *   a pipe. Cost: the payload counts against the seam's 32 KiB cmd cap.
 * - Env is validated Hub-side against the seam's session-config rules to
 *   fail fast before dispatch (contract delta table).
 */

import type {
  ExecRequest,
  ExecStatus,
  SeamEvent,
  SessionSeed,
  SubstrateExecPort,
} from '../domain/ports.js';
import type { KillOutcome } from '../domain/types.js';
import type { SeamAuth } from './seamAuth.js';

export class SeamHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = 'SeamHttpError';
  }

  static async from(res: Response, context: string): Promise<SeamHttpError> {
    const body = await res.text().catch(() => '');
    return new SeamHttpError(res.status, body, `${context}: seam responded ${res.status}`);
  }
}

/** Request rejected Hub-side before any HTTP call (fail fast on seam limits). */
export class SeamValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeamValidationError';
  }
}

/** A wire line that is not valid JSON is a protocol violation, not an event. */
export class SeamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeamProtocolError';
  }
}

// seam limits (EXEC_API.md; env rules = session-config rules)
const CMD_BYTES_MAX = 32 * 1024;
const MAX_DURATION_MS_MAX = 60 * 60 * 1000;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_MAX_ENTRIES = 64;
const ENV_MAX_VALUE_BYTES = 4096;
const ENV_MAX_TOTAL_BYTES = 64 * 1024;

/**
 * `bash -c <script> hub_stdin <payload> <argv...>`: $1 is the payload,
 * "${@:2}" the real argv — both only ever positional parameters, so their
 * content is never shell-interpreted.
 */
const STDIN_WRAPPER_SCRIPT = 'printf %s "$1" | "${@:2}"';

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

function buildCmd(req: ExecRequest): string[] {
  if (req.argv.length === 0) throw new SeamValidationError('argv must not be empty');
  const cmd =
    req.stdin === undefined
      ? req.argv
      : ['bash', '-c', STDIN_WRAPPER_SCRIPT, 'hub_stdin', req.stdin, ...req.argv];
  const bytes = cmd.reduce((n, arg) => n + utf8Bytes(arg), 0);
  if (bytes > CMD_BYTES_MAX) {
    throw new SeamValidationError(
      `cmd is ${bytes} bytes, over the seam's ${CMD_BYTES_MAX}-byte cap` +
        (req.stdin !== undefined ? ' (stdin payload rides inside cmd — see contract notes)' : ''),
    );
  }
  return cmd;
}

function validateEnv(env: Record<string, string> | undefined): void {
  if (env === undefined) return;
  const entries = Object.entries(env);
  if (entries.length > ENV_MAX_ENTRIES) {
    throw new SeamValidationError(`env has ${entries.length} entries, max ${ENV_MAX_ENTRIES}`);
  }
  let total = 0;
  for (const [name, value] of entries) {
    if (!ENV_NAME_RE.test(name)) {
      throw new SeamValidationError(`env name ${JSON.stringify(name)} is invalid`);
    }
    const valueBytes = utf8Bytes(value);
    if (valueBytes > ENV_MAX_VALUE_BYTES) {
      throw new SeamValidationError(
        `env ${name} is ${valueBytes} bytes, max ${ENV_MAX_VALUE_BYTES} per value`,
      );
    }
    total += utf8Bytes(name) + valueBytes;
  }
  if (total > ENV_MAX_TOTAL_BYTES) {
    throw new SeamValidationError(`env totals ${total} bytes, max ${ENV_MAX_TOTAL_BYTES}`);
  }
}

/** Parse one wire line into a SeamEvent; null = unknown type, ignored. */
function parseSeamEvent(line: string): SeamEvent | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new SeamProtocolError(`seam stream line is not JSON: ${line.slice(0, 120)}`);
  }
  switch (obj.type) {
    case 'started':
      return {
        v: 1,
        type: 'started',
        execId: String(obj.execId),
        pgid: Number(obj.pgid),
        requestId: String(obj.requestId),
      };
    case 'output':
      return {
        v: 1,
        type: 'output',
        stream: obj.stream === 'stderr' ? 'stderr' : 'stdout',
        data: String(obj.data),
      };
    case 'dropped':
      return { v: 1, type: 'dropped', scope: 'pre-start', bytes: Number(obj.bytes) };
    case 'exit':
      return {
        v: 1,
        type: 'exit',
        exitCode: obj.exitCode === null || obj.exitCode === undefined ? null : Number(obj.exitCode),
        ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}),
      };
    case 'error':
      return {
        v: 1,
        type: 'error',
        message:
          typeof obj.code === 'string' ? `${obj.code}: ${String(obj.message)}` : String(obj.message),
      };
    default:
      return null; // forward compat: unknown event types are ignored
  }
}

/** Reassemble NDJSON lines from chunks that need not be line-aligned. */
async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim() !== '') yield line;
      }
    }
    buf += decoder.decode();
    if (buf.trim() !== '') yield buf;
  } finally {
    reader.releaseLock();
  }
}

export interface RealExecPortOptions {
  /** e.g. `http://127.0.0.1:3001` — never a public hostname in config committed to the repo (R-09). */
  baseUrl: string;
  auth: SeamAuth;
  fetchImpl?: typeof fetch;
}

export class RealSubstrateExecPort implements SubstrateExecPort {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RealExecPortOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  createSession(_templateId: string, _seed: SessionSeed): Promise<{ sessionId: string }> {
    return Promise.reject(
      new Error('RealSubstrateExecPort.createSession lands with B2-02 (session provisioning)'),
    );
  }

  stopSession(_sessionId: string): Promise<void> {
    return Promise.reject(
      new Error('RealSubstrateExecPort.stopSession lands with B2-02 (session provisioning)'),
    );
  }

  async *exec(sessionId: string, req: ExecRequest): AsyncIterable<SeamEvent> {
    const cmd = buildCmd(req);
    validateEnv(req.env);
    if (!(req.maxDurationMs >= 1 && req.maxDurationMs <= MAX_DURATION_MS_MAX)) {
      throw new SeamValidationError(
        `maxDurationMs ${req.maxDurationMs} outside the seam's 1..${MAX_DURATION_MS_MAX} range`,
      );
    }
    const res = await this.request('POST', `/api/sessions/${sessionId}/exec`, {
      cmd,
      ...(req.env !== undefined ? { env: req.env } : {}),
      maxDurationMs: req.maxDurationMs,
    });
    if (!res.ok) throw await SeamHttpError.from(res, 'exec');
    if (res.body === null) throw new SeamProtocolError('exec: seam returned 200 with no body');
    for await (const line of ndjsonLines(res.body)) {
      const event = parseSeamEvent(line);
      if (event !== null) yield event;
    }
  }

  async status(sessionId: string, execId: string): Promise<ExecStatus> {
    const res = await this.request('GET', `/api/sessions/${sessionId}/exec/${execId}`);
    if (!res.ok) throw await SeamHttpError.from(res, 'status');
    const body = (await res.json()) as { state: ExecStatus['state']; exitCode?: number | null };
    return body.state === 'exited'
      ? { state: 'exited', exitCode: body.exitCode ?? null }
      : { state: body.state };
  }

  async kill(
    sessionId: string,
    execId: string,
    graceMs: number,
  ): Promise<{ outcome: KillOutcome }> {
    const res = await this.request('POST', `/api/sessions/${sessionId}/exec/${execId}/kill`, {
      graceMs,
    });
    // contract: kill keeps 404 for ids the registry does not hold (aged out,
    // lost to a restart, or never existed) — the port's tolerant no-op
    if (res.status === 404) return { outcome: 'already-exited' };
    if (!res.ok) throw await SeamHttpError.from(res, 'kill');
    const body = (await res.json()) as { outcome: KillOutcome };
    return { outcome: body.outcome };
  }

  /** Attach the auth cookie; on 401, re-login once and retry (nothing ran yet). */
  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const doFetch = async (): Promise<Response> =>
      this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method,
        headers: {
          cookie: await this.opts.auth.cookieHeader(),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    let res = await doFetch();
    if (res.status === 401) {
      this.opts.auth.invalidate();
      res = await doFetch();
    }
    return res;
  }
}
