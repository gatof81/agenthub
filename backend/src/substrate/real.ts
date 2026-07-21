/**
 * Real SubstrateExecPort: thin HTTP client over the seam. B2-01 covers
 * exec/status/kill (canonical contract: shared-terminal docs/EXEC_API.md,
 * tracked in docs/contracts/shared-terminal-exec-api.md); B2-02 adds
 * session provisioning (template → create → agentSeed → bootstrap wait →
 * start/stop) against the substrate's session routes.
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

import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  ExecRequest,
  ExecStatus,
  SeamEvent,
  SessionInfo,
  SessionListing,
  SessionSeed,
  SubstrateExecPort,
} from '../domain/ports.js';
import type { KillOutcome } from '../domain/types.js';
import { SessionGoneError } from '../domain/ports.js';
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

/**
 * Session provisioning failed or timed out (UC-01 error branch). Carries the
 * substrate's captured bootstrap log (tail-capped) as diagnostic detail —
 * surfaced on the project, never logged with payloads (13 §5).
 */
export class SeamProvisioningError extends Error {
  constructor(
    message: string,
    readonly bootstrapLog: string | null,
  ) {
    super(message);
    this.name = 'SeamProvisioningError';
  }
}

// Transport timeouts (#116). A stalled or half-open seam connection must
// unwind with a seam error, never wedge the per-workspace run queue behind it.
// - Non-streaming calls (status/kill/session/bootstrap polls) get a per-request
//   deadline: their responses are tiny, so a stall means the socket is dead.
// - The exec NDJSON stream instead gets an IDLE timeout reset on every chunk —
//   a long, actively-streaming turn is legitimate, so a fixed total deadline
//   would be wrong; only a stream that goes silent (half-open) may trip it.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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

/**
 * Map an aborted/timed-out fetch onto a seam error so a stalled connection
 * surfaces instead of a raw DOMException (#116). A streaming idle-abort already
 * carries a SeamProtocolError as its abort reason — pass it through untouched;
 * a per-request `AbortSignal.timeout` rejects with a `TimeoutError`, which
 * becomes a SeamProtocolError so callers see one seam-error taxonomy.
 */
function asTransportError(err: unknown, context: string): unknown {
  if (err instanceof SeamProtocolError) return err;
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new SeamProtocolError(`${context}: no seam response within the request timeout`);
  }
  return err;
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
        // always present on the wire (exec.ts:255 `?? "exited"`); default
        // defensively to the same value rather than fabricate a variant
        reason: typeof obj.reason === 'string' ? obj.reason : 'exited',
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

/**
 * Map a seam session row (serializeMeta shape, admin rows add ownerUsername)
 * to the port's `SessionInfo`. `envVars` and container details are dropped
 * here, at the boundary — see the port type's rationale (SEC-04/05).
 */
function toSessionInfo(row: Record<string, unknown>, fallbackOwner: string | null): SessionInfo {
  return {
    sessionId: String(row.sessionId),
    name: String(row.name ?? ''),
    status: String(row.status ?? 'unknown'),
    ownerUsername: typeof row.ownerUsername === 'string' ? row.ownerUsername : fallbackOwner,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
    lastConnectedAt: typeof row.lastConnectedAt === 'string' ? row.lastConnectedAt : null,
    // in serializeMeta since shared-terminal#418 (verified at c2db7f7)
    externalRef: typeof row.externalRef === 'string' ? row.externalRef : null,
  };
}

/**
 * Reassemble NDJSON lines from chunks that need not be line-aligned.
 * `onChunk` fires on every received chunk so the caller can reset its idle
 * timeout (#116) — an actively-streaming turn keeps the deadline at bay.
 */
async function* ndjsonLines(
  body: ReadableStream<Uint8Array>,
  onChunk: () => void,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk();
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
  /** Bootstrap-wait pacing (B2-02); defaults: poll 1 s, give up after 180 s. */
  provisioning?: { pollIntervalMs?: number; timeoutMs?: number };
  /**
   * The execution identity's own seam username (N1). Own-scope listing rows
   * carry no owner on the wire — the caller IS the owner — so the port
   * attributes them to this name rather than reporting `null` and making the
   * UI guess (FR-48). Absent → own-scope rows report `ownerUsername: null`.
   */
  selfUsername?: string;
  /**
   * The owner's admin-account user id (N2, ADR-007). When set, `createSession`
   * creates the session **in the owner's account** via `ownerUserId`
   * (shared-terminal#420) and returns it. Absent → self-owned create.
   */
  ownerUserId?: string;
  /**
   * Transport-level timeouts (#116) so a stalled/half-open seam connection
   * unwinds with a seam error instead of hanging the run queue behind it.
   * - `requestTimeoutMs`: per-request deadline for the non-streaming calls
   *   (status/kill/session/bootstrap polls); default 30 s. NOT applied to the
   *   exec stream, whose legitimate turns run long.
   * - `streamIdleTimeoutMs`: idle timeout for the exec NDJSON stream, reset on
   *   every received chunk; default 5 min. Distinct from the server-side
   *   `maxDurationMs`, which bounds the child process, not the wire.
   */
  transport?: { requestTimeoutMs?: number; streamIdleTimeoutMs?: number };
}

/** Cap the bootstrap-log tail carried on a provisioning error. */
const BOOTSTRAP_LOG_TAIL_BYTES = 2048;
/** Seam cap per agentSeed field (sessionConfig.ts MAX_AGENT_SEED_BYTES). */
const AGENT_SEED_MAX_BYTES = 256 * 1024;

export class RealSubstrateExecPort implements SubstrateExecPort {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;

  constructor(private readonly opts: RealExecPortOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestTimeoutMs = opts.transport?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.streamIdleTimeoutMs =
      opts.transport?.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  }

  /**
   * UC-01 provisioning (B2-02): templates are client-side presets upstream
   * (`GET /templates/:id` returns the full config; `POST /sessions` takes
   * the materialized `config`), so the port resolves the template, folds
   * the agentSeed in (seed fields override the template's per-field), and
   * waits for the async bootstrap to finish before reporting the session.
   *
   * Bootstrap-completion signal, chosen to avoid a WebSocket dependency:
   * upstream persists `bootstrap_log` when the runner finishes — success
   * or failure (`bootstrap.ts` persistLog on both branches) — and flips
   * `status` to `failed` on hard-fail. So: `status === "failed"` ⇒ error
   * (with the log as diagnostic); non-null bootstrap-log ⇒ ready. `null`
   * cannot mean "never ran" here because a seeded create always runs the
   * bootstrap (the create response says `bootstrapping: true`).
   */
  async createSession(
    templateId: string,
    seed: SessionSeed,
  ): Promise<{ sessionId: string; ownerUserId: string | null }> {
    const tplRes = await this.request(
      'GET',
      `/api/templates/${encodeURIComponent(templateId)}`,
    );
    if (!tplRes.ok) throw await SeamHttpError.from(tplRes, 'createSession: template');
    const template = (await tplRes.json()) as { config?: Record<string, unknown> };

    const templateSeed = (template.config?.agentSeed ?? {}) as Record<string, unknown>;
    // The template's own agentSeed passes through untouched — including its
    // `settings`, which the Hub deliberately never overrides (S-05; see the
    // `SessionSeed` port). Deployment-wide settings belong to the template,
    // which is the project's workspace declaration (FR-45), not to a seed
    // assembled from whichever role happened to provision.
    //
    // wire shape (sessionConfig.ts AgentSeedSpec, live-E2E finding):
    // agentSeed fields are byte-capped STRINGS.
    const agentSeed: Record<string, unknown> = {
      ...templateSeed,
      ...(seed.claudeMd !== undefined ? { claudeMd: seed.claudeMd } : {}),
    };
    for (const [field, value] of Object.entries(agentSeed)) {
      if (typeof value === 'string' && utf8Bytes(value) > AGENT_SEED_MAX_BYTES) {
        throw new SeamValidationError(
          `agentSeed.${field} is ${utf8Bytes(value)} bytes, over the seam's ${AGENT_SEED_MAX_BYTES}-byte cap`,
        );
      }
    }
    // The project's repo overrides whatever the template happens to clone:
    // the workspace is the project's declaration (ADR-006, FR-45), and a
    // template is a preset, not an authority.
    //
    // `auth` is folded in HERE, at the last moment before dispatch, and only
    // when a repo is actually being cloned. It came in as its own argument
    // and is never attached to the stored `repo` shape, so there is no object
    // in the Hub that carries both the metadata and the secret (SEC-11). The
    // seam encrypts it on receipt (`encryptAuthCredentials`,
    // `sessionConfig.ts:1138` @ shared-terminal c35b6da).
    const repoConfig =
      seed.repo === undefined
        ? undefined
        : {
            url: seed.repo.url,
            ...(seed.repo.ref !== undefined ? { ref: seed.repo.ref } : {}),
            ...(seed.repo.target !== undefined ? { target: seed.repo.target } : {}),
            auth: seed.repoAuth ?? { kind: 'none' },
          };
    const config: Record<string, unknown> = {
      ...(template.config ?? {}),
      ...(Object.keys(agentSeed).length > 0 ? { agentSeed } : {}),
      ...(repoConfig !== undefined ? { repo: repoConfig } : {}),
    };

    // substrate-side display name only — the Hub tracks sessions by id
    const name = `hub-${randomBytes(4).toString('hex')}`;
    const ownerUserId = this.opts.ownerUserId ?? null;
    const res = await this.request('POST', '/api/sessions', {
      name,
      config,
      // top-level create field, not part of config (#418, verified at c2db7f7)
      ...(seed.externalRef !== undefined ? { externalRef: seed.externalRef } : {}),
      // create in the owner's account on their behalf (#420, admin-only,
      // verified at 1a5af57). Absent → self-owned, the pre-#420 behavior.
      ...(ownerUserId !== null ? { ownerUserId } : {}),
    });
    // On-behalf create charges the OWNER's budget, not the Hub's — a 429 here
    // is the owner's quota. Two shapes, both verified at 1a5af57: a CPU/mem
    // budget cap is `{error, cap:"cpu"|"mem"}` (routes/sessions.ts:273); the
    // session-count cap is `{error, quota:<n>}` (:451). Name whichever the
    // seam sent so the provisioning error says why, not a bare status.
    if (res.status === 429) {
      const q = (await res.json().catch(() => ({}))) as { error?: string; cap?: string; quota?: unknown };
      const scope = ownerUserId !== null ? 'owner' : 'account';
      // null (neither field present) → don't duplicate the word "quota"
      const which = q.cap ?? (q.quota !== undefined ? 'session-count' : null);
      throw new SeamProvisioningError(
        which !== null
          ? `session create refused: ${scope} ${which} quota exceeded`
          : `session create refused: ${scope} quota exceeded`,
        null,
      );
    }
    if (!res.ok) throw await SeamHttpError.from(res, 'createSession');
    const created = (await res.json()) as { sessionId: string; bootstrapping?: boolean };
    if (created.bootstrapping === true) await this.awaitBootstrap(created.sessionId);
    return { sessionId: created.sessionId, ownerUserId };
  }

  /**
   * Session discovery (N1, FR-48, ADR-007). Tries the admin-wide listing
   * first — the ADR-007 target has the execution identity admin-flagged, and
   * `GET /api/admin/sessions` is the only listing that attributes each row
   * to its owner (`ownerUsername`, verified at shared-terminal `0cd4ed5`,
   * `routes/admin.ts:139-151`). A 403 (no admin flag yet) degrades to the
   * own-sessions listing with `scope: 'own'` so callers can tell a partial
   * view from the whole estate rather than being handed one as the other.
   */
  async listSessions(): Promise<SessionListing> {
    const adminRes = await this.request('GET', '/api/admin/sessions');
    if (adminRes.ok) {
      const rows = (await adminRes.json()) as Array<Record<string, unknown>>;
      return { scope: 'all', sessions: rows.map((r) => toSessionInfo(r, null)) };
    }
    if (adminRes.status !== 403) throw await SeamHttpError.from(adminRes, 'listSessions');
    const ownRes = await this.request('GET', '/api/sessions');
    if (!ownRes.ok) throw await SeamHttpError.from(ownRes, 'listSessions: own scope');
    const rows = (await ownRes.json()) as Array<Record<string, unknown>>;
    return {
      scope: 'own',
      sessions: rows.map((r) => toSessionInfo(r, this.opts.selfUsername ?? null)),
    };
  }

  /**
   * Single-session metadata (N1). Operate-tier upstream since #412 (owner OR
   * admin), so it works on owner-account sessions once the identity is
   * admin-flagged. 404 → `null`: gone is a state to surface (FR-44), not an
   * error to retry. The single GET carries no owner attribution on the wire.
   */
  async getSession(sessionId: string): Promise<SessionInfo | null> {
    const res = await this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await SeamHttpError.from(res, 'getSession');
    return toSessionInfo((await res.json()) as Record<string, unknown>, null);
  }

  /**
   * Write the session ↔ project link (N2, shared-terminal#418): `PATCH
   * /api/sessions/:id {externalRef}` — the route's ONLY patchable field
   * (unknown keys 400 upstream); `null` clears. Operate-tier (owner OR
   * admin, verified at `c2db7f7`, `routes/sessions.ts:770-800`).
   */
  async setSessionExternalRef(sessionId: string, ref: string | null): Promise<void> {
    const res = await this.request(
      'PATCH',
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { externalRef: ref },
    );
    if (!res.ok) throw await SeamHttpError.from(res, 'setSessionExternalRef');
  }

  /** Archive path (FR-30): tolerant of a session that is already gone. */
  async stopSession(sessionId: string): Promise<void> {
    const res = await this.request('POST', `/api/sessions/${sessionId}/stop`);
    if (res.status === 404) return;
    if (!res.ok) throw await SeamHttpError.from(res, 'stopSession');
  }

  /**
   * Restore path (FR-43): restart a stopped session. Upstream respawns the
   * container from the stored config with the same workspace bind mount, so
   * the files and the CLI transcripts under them come back with it.
   *
   * 404 is NOT tolerated here, unlike `stopSession`. For a stop, "already
   * gone" satisfies the caller's intent; for a restore it defeats it — the
   * session was hard-deleted and took its workspace, so there is nothing to
   * bring back. Surfacing that as its own error is what lets the orchestrator
   * keep the project archived instead of quietly standing up an empty
   * replacement (FR-44).
   */
  async startSession(sessionId: string): Promise<void> {
    const res = await this.request('POST', `/api/sessions/${sessionId}/start`);
    if (res.status === 404) throw new SessionGoneError(sessionId);
    if (!res.ok) throw await SeamHttpError.from(res, 'startSession');
  }

  private async awaitBootstrap(sessionId: string): Promise<void> {
    const pollIntervalMs = this.opts.provisioning?.pollIntervalMs ?? 1000;
    const timeoutMs = this.opts.provisioning?.timeoutMs ?? 180_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const metaRes = await this.request('GET', `/api/sessions/${sessionId}`);
      if (!metaRes.ok) throw await SeamHttpError.from(metaRes, 'createSession: bootstrap poll');
      const meta = (await metaRes.json()) as { status: string };
      if (meta.status === 'failed') {
        throw new SeamProvisioningError(
          `session ${sessionId} failed during bootstrap`,
          await this.bootstrapLogTail(sessionId),
        );
      }
      const logRes = await this.request('GET', `/api/sessions/${sessionId}/bootstrap-log`);
      if (logRes.ok) {
        const { log } = (await logRes.json()) as { log: string | null };
        if (log !== null) {
          // Upstream persists the log BEFORE flipping status on the failure
          // path (bootstrap.ts finishWithFail: "Persist BEFORE flipping
          // status…"), so a log-first read can race the failed flip. Give
          // the flip one poll interval to land, then classify. Residual:
          // if upstream's own status UPDATE fails (its CRITICAL branch),
          // the row stays `running` forever and no client can tell — that
          // window is upstream's, not ours.
          await sleep(pollIntervalMs);
          const confirmRes = await this.request('GET', `/api/sessions/${sessionId}`);
          if (!confirmRes.ok) {
            throw await SeamHttpError.from(confirmRes, 'createSession: bootstrap confirm');
          }
          const confirmed = (await confirmRes.json()) as { status: string };
          if (confirmed.status === 'failed') {
            throw new SeamProvisioningError(
              `session ${sessionId} failed during bootstrap`,
              log.slice(-BOOTSTRAP_LOG_TAIL_BYTES),
            );
          }
          return;
        }
      }
      if (Date.now() >= deadline) {
        throw new SeamProvisioningError(
          `session ${sessionId} bootstrap did not finish within ${timeoutMs} ms`,
          null,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  private async bootstrapLogTail(sessionId: string): Promise<string | null> {
    try {
      const res = await this.request('GET', `/api/sessions/${sessionId}/bootstrap-log`);
      if (!res.ok) return null;
      const { log } = (await res.json()) as { log: string | null };
      return log === null ? null : log.slice(-BOOTSTRAP_LOG_TAIL_BYTES);
    } catch {
      return null;
    }
  }

  async *exec(sessionId: string, req: ExecRequest): AsyncIterable<SeamEvent> {
    const cmd = buildCmd(req);
    validateEnv(req.env);
    if (!(req.maxDurationMs >= 1 && req.maxDurationMs <= MAX_DURATION_MS_MAX)) {
      throw new SeamValidationError(
        `maxDurationMs ${req.maxDurationMs} outside the seam's 1..${MAX_DURATION_MS_MAX} range`,
      );
    }
    // Idle-timeout guard (#116): abort the stream if it goes silent for
    // `streamIdleTimeoutMs`. Armed before the POST so a stream that never even
    // sends headers also unwinds; reset on every chunk so a long, actively-
    // streaming turn never trips it. The abort reason IS a SeamProtocolError,
    // so the read rejects with the seam-error taxonomy already in hand.
    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        controller.abort(
          new SeamProtocolError(
            `exec stream idle for ${this.streamIdleTimeoutMs} ms with no data — seam unresponsive`,
          ),
        );
      }, this.streamIdleTimeoutMs);
      idleTimer.unref();
    };
    const clearIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = undefined;
    };

    resetIdle();
    try {
      const res = await this.request(
        'POST',
        `/api/sessions/${sessionId}/exec`,
        {
          cmd,
          ...(req.env !== undefined ? { env: req.env } : {}),
          ...(req.workingDir !== undefined ? { workingDir: req.workingDir } : {}),
          maxDurationMs: req.maxDurationMs,
        },
        { signal: controller.signal },
      );
      if (!res.ok) throw await SeamHttpError.from(res, 'exec');
      if (res.body === null) throw new SeamProtocolError('exec: seam returned 200 with no body');
      for await (const line of ndjsonLines(res.body, resetIdle)) {
        const event = parseSeamEvent(line);
        if (event !== null) yield event;
      }
    } finally {
      clearIdle();
      // Close the socket when we stop consuming — normal end, error, or an
      // early break by the orchestrator. Harmless if already aborted.
      controller.abort();
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

  /**
   * Attach the auth cookie; on 401, re-login once and retry (nothing ran yet).
   * Non-streaming calls get a fresh per-request `AbortSignal.timeout` per
   * attempt (#116); the exec stream passes its own idle-reset `signal` via
   * `opts` instead, since its legitimate turns outlast any fixed deadline.
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    opts?: { signal?: AbortSignal },
  ): Promise<Response> {
    const doFetch = async (): Promise<Response> => {
      const signal = opts?.signal ?? AbortSignal.timeout(this.requestTimeoutMs);
      try {
        return await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
          method,
          headers: {
            cookie: await this.opts.auth.cookieHeader(),
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal,
        });
      } catch (err) {
        throw asTransportError(err, `${method} ${path}`);
      }
    };
    let res = await doFetch();
    if (res.status === 401) {
      this.opts.auth.invalidate();
      res = await doFetch();
    }
    return res;
  }
}
