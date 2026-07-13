# shared-terminal Exec API — contract draft

> **PROPOSAL** — drafted in the agenthub repo (see
> [ADR-001](../adr/ADR-001-shared-terminal-exec-seam.md)) as a requirement from
> the Hub. Not implemented anywhere yet. To be reviewed, amended, and
> implemented through the shared-terminal repo's own process; that repo's
> merged version supersedes this file, which then tracks it.

Target substrate: shared-terminal @ `36be2f2` or later. The API wraps the
existing in-process primitives `streamExec` / `killExecProcessGroup`
(`backend/src/dockerManager.ts`) — no new execution machinery, only HTTP
surface over what smoke-test Phase 6 already covers.

## Design constraints honored

- Product-agnostic: no knowledge of Hub concepts (runs, agents, conversations).
- Routes flow through the ordinary Express middleware chain (auth, rate
  limiting, request context) — no WS upgrade path.
- `cmd` is an argv array end-to-end; it must ride positional parameters into
  `setsid`/exec exactly like today's `PGID_WRAPPER_SCRIPT` path — never string
  interpolation (house invariant, `dockerManager.ts:1191-1194`).
- Contract is replica-agnostic: correlation by ids, no sticky-connection
  assumptions. (The v1 *implementation* may keep its exec registry
  process-local, matching the documented single-replica deployment.)

## Authentication & scoping

Endpoints require an authenticated principal (existing JWT auth). The principal
must **own the session**; otherwise `403`. No new auth mechanism is required:
the Hub authenticates via `/auth/login` as a dedicated account and only ever
touches sessions it created. Optionally (upstream's call), accept the JWT via
`Authorization: Bearer` in addition to the cookie for M2M ergonomics.

## Correlation (required)

Every response of every endpoint below carries `X-Request-Id: <16-hex>` — the
id that already exists in `requestContext.ts` and is stamped on every log line.
The `started` event echoes it, so a Hub-side run can be joined to substrate
logs after the fact. If the caller supplies an `X-Request-Id` header it MAY be
adopted (log-joined) but the response header remains the substrate's
authoritative id.

## Endpoints

### 1. Start an exec — `POST /sessions/:id/exec`

Starts a command in the session container and streams events until exit.

Request body:

```json
{
  "cmd": ["claude", "-p", "--resume", "abc123", "--output-format", "stream-json"],
  "env": { "MY_VAR": "value" },
  "workingDir": "/home/developer/workspace",
  "maxDurationMs": 600000
}
```

| Field | Type | Required | Semantics |
| --- | --- | --- | --- |
| `cmd` | `string[]` | yes | argv array; `cmd[0]` resolved via container `PATH`. Never shell-interpreted |
| `env` | `object` | no | extra environment; values are opaque strings. Size-capped (see Limits) |
| `workingDir` | `string` | no | default: the session workspace (same default as `streamExec` today) |
| `maxDurationMs` | `number` | no | server-side wall-clock cap; on expiry the server performs the kill procedure (below) and emits `exit` with `reason: "timeout"` |

Every exec runs with `newProcessGroup: true` — the pgid is the cancellation
handle and there is no reason to offer an uncancellable mode at this seam.

Response: `200` with `Content-Type: application/x-ndjson`, `Transfer-Encoding:
chunked`. One JSON object per line:

```json
{"v":1,"type":"started","execId":"e_9f2c...","pgid":137,"requestId":"a1b2c3d4e5f60718","ts":"2026-07-13T21:00:00.000Z"}
{"v":1,"type":"output","stream":"stdout","data":"{\"type\":\"system\",\"subtype\":\"init\", ..."}
{"v":1,"type":"output","stream":"stderr","data":"some diagnostic\n"}
{"v":1,"type":"exit","exitCode":0,"reason":"exited","ts":"2026-07-13T21:00:41.213Z"}
```

Event schema:

| `type` | Fields | Notes |
| --- | --- | --- |
| `started` | `execId`, `pgid`, `requestId`, `ts` | First event, before any output. `pgid` is informational (kill is by `execId`); guaranteed ≥ 2 |
| `output` | `stream` (`"stdout"`\|`"stderr"`), `data` | `data` is a UTF-8 chunk, not necessarily line-aligned; the consumer reassembles lines. Docker multiplexed frames preserve the stream distinction (`Tty:false`) |
| `exit` | `exitCode`, `reason` (`"exited"`\|`"killed"`\|`"timeout"`), `ts` | Terminal event; the response ends after it |
| `error` | `code`, `message` | Terminal event for mid-stream failures (container died, docker error). The response ends after it |

All events carry `v` (schema version, integer, currently `1`). Consumers must
ignore unknown fields and unknown event types (forward compatibility); the `v`
bump is reserved for breaking changes and is coordinated in this document.

Stream lifecycle rules:

- Client disconnect does **not** kill the process (Docker has no kill-exec;
  see `dockerManager.ts:1143-1155`). The exec keeps running server-side and
  remains addressable via endpoints 2 and 3.
- The server applies flow control: when the HTTP response backpressures, the
  underlying Docker stream is paused, not buffered unboundedly.

### 2. Exec status — `GET /sessions/:id/exec/:execId`

Recovery/reconciliation surface for a consumer that lost the stream.

```json
{ "execId": "e_9f2c...", "state": "running", "pgid": 137, "startedAt": "..." }
{ "execId": "e_9f2c...", "state": "exited", "exitCode": 0, "reason": "exited", "endedAt": "..." }
```

`state`: `running` | `exited` | `unknown` (registry lost, e.g. backend
restarted; the consumer should kill by pgid… which it no longer has — hence
`unknown` responses include the guidance semantics below).

On `unknown`, the safe consumer action is session-level reconciliation: the
process either exited on its own or still runs; the consumer decides whether
to stop/start the session (heavy hammer, always available today) or accept the
orphan. v1 accepts this gap; it is the same gap the substrate's own bootstrap
runner accepts on backend restart.

### 3. Kill — `POST /sessions/:id/exec/:execId/kill`

Maps 1:1 to `killExecProcessGroup(sessionId, pgid, graceMs)`.

Request: `{ "graceMs": 5000 }` (optional; default 5000, server-capped).

Response `200`:

```json
{ "outcome": "terminated" }
```

`outcome`: `already-exited` | `terminated` | `killed` — verbatim the primitive's
`KillProcessGroupOutcome`. Idempotent by design (`already-exited` is the
tolerant no-op, `dockerManager.ts:167-204`). After a successful kill the exec's
stream (if still attached) emits `exit` with `reason: "killed"`.

## Error semantics (non-stream)

| Status | When | Body |
| --- | --- | --- |
| `400` | malformed body, empty `cmd`, non-string argv entries, oversized `env` | `{ "error": "..." }` |
| `401` / `403` | unauthenticated / session not owned by principal | existing house shape |
| `404` | unknown session, unknown execId | — |
| `409` | session has no running container (`stopped`, still bootstrapping) | `{ "error": "container-not-running" }` |
| `429` | exec concurrency or rate cap hit | — |

Once the NDJSON stream has started, failures arrive as `error` events, not
status codes.

## Limits (server-enforced, deployment-configurable)

- Max concurrent execs per session (suggested default: 4) — protects
  `PidsLimit: 1024` and keeps one runaway consumer from starving tmux.
- Max `env` payload size (suggested: 32 KiB) and max `cmd` length.
- `graceMs` cap (suggested: 30 000).
- `maxDurationMs` cap (suggested: 1 hour) — a seam-level backstop; consumers
  enforce their own tighter budgets.

## Versioning

- Event schema: `v` field per event; breaking changes bump it and this
  document. Additive fields/event types are not breaking (consumers must
  ignore unknowns).
- Endpoint shape: follows the substrate's normal API evolution (no `/v1` path
  prefix exists today; introducing one only for this surface would be
  inconsistent).

## Security considerations

- This endpoint is *arbitrary code execution in the session container* by
  construction — exactly as powerful as the terminal WS already is for the
  same authenticated owner. It adds capability breadth (automation), not a new
  trust level.
- Ownership check is the entire authorization story (single-tenant network
  assumption #291 unchanged).
- `env` values may carry secrets; they must never be logged (extends the
  existing `d1Query`-style discipline) and are not echoed in any event.
- The kill path revalidates `pgid >= 2` server-side regardless of registry
  state (the guard at `dockerManager.ts:1363-1369` stays load-bearing).

## Non-goals (v1)

- Event replay / resume (`?after=seq`) — see ADR-001; additive if needed.
- Interactive stdin / PTY allocation — the terminal WS remains the interactive
  surface.
- Multi-replica exec registry.
- Any Hub-side concept (runs, budgets, turn semantics) — those live in the Hub.
