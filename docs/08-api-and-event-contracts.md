# 08 — API & Event Contracts (Phase 1)

**Status:** draft — review · **Last updated:** 2026-07-14

The Hub's own wire contracts: HTTP API, SSE projection, persisted `RunEvent`
schema, the runner's command contract, the initial agent allowlist, and the
error taxonomy. Domain names from [06](./06-domain-model.md); transports from
[ADR-004](./adr/ADR-004-ui-streaming-transport.md); runner behavior from
[ADR-003](./adr/ADR-003-claude-cli-runner.md). The seam contract lives in
[contracts/shared-terminal-exec-api.md](./contracts/shared-terminal-exec-api.md)
(tracking upstream) and is not duplicated here.

Conventions: JSON everywhere; timestamps UTC ISO-8601; ids are opaque strings;
consumers ignore unknown fields (additive-first evolution, same policy as the
seam). No `/v1` path prefix — consistent with the substrate; a breaking change
requires a documented migration, which Phase 1 has no mechanism for and
therefore must not make.

## 1. HTTP API

All routes under `/api`, behind the single-credential gateway middleware
(Q-07 Phase 1). Every response carries `X-Request-Id` (Hub-generated,
16-hex — mirroring the seam's convention).

| Route | Purpose | Notes |
| --- | --- | --- |
| `GET /api/health` | liveness + backup freshness signal | unauthenticated liveness, authenticated detail |
| `GET /api/agents` | list config-defined agents | id, name, allowlist, caps — read-only in Phase 1 (FR-02) |
| `POST /api/conversations` | create conversation → provisions its session (UC-01) | body `{agentId, title?}`; returns `202` with `status: "provisioning"` |
| `GET /api/conversations` | list with status + last message | archived filtered by default |
| `GET /api/conversations/:id` | detail + messages (paged) | `?before=<messageId>&limit=` |
| `PATCH /api/conversations/:id` | rename / archive | `{title?}` or `{status: "archived"}` (FR-01) |
| `POST /api/conversations/:id/messages` | send message → creates the run (FR-03) | body `{content}`; returns `202 {messageId, runId, runState}` — `queued` or `starting` (UC-03); `409` while `provisioning`/`error` |
| `GET /api/runs/:id` | run detail: state, snapshots, activity projection, usage, error | activity derived on read (06 §2) |
| `POST /api/runs/:id/cancel` | cancel active or queued run (FR-20) | returns `202`; final state + `killOutcome`/`sweepResult` arrive via SSE and `GET /api/runs/:id` |
| `GET /api/conversations/:id/events` | **SSE stream** (ADR-004) | `Last-Event-ID` replay; §3 |

Status usage: `202` for anything that continues asynchronously (message
accepted, cancel requested); `409` for state conflicts (send while
provisioning, cancel on a terminal run — body carries the current state);
`422` for validation; `401` for auth; `404` never distinguishes "hidden" from
"absent".

## 2. Persisted `RunEvent` schema

The store's event rows (06 §2), the source of truth every other surface
projects from:

```json
{ "id": "ev_...", "runId": "run_...", "seq": 17,
  "type": "tool_use", "ts": "2026-07-14T20:00:00.000Z",
  "payload": { "name": "Bash", "input": { "command": "cat hello.txt" } } }
```

- `type ∈ {started, output, tool_use, permission_denial, exit, error, unknown}`
  — mapping from CLI stream-json per ADR-003; seam-level events (`dropped`)
  and unrecognized CLI types persist as `unknown` with the original type
  inside the payload (FR-16).
- **Payload cap: 64 KiB** (NFR-02). Oversized payloads are truncated to the
  cap with `"truncated": true` and original byte count — sized 8× above
  S-01's largest observed event (< 8 KiB), generous headroom for real tool
  output. (S-03's D1 ~100 KB per-statement ceiling served as a historical
  upper bound; SQLite imposes no such limit — bounding payloads is schema
  hygiene, not a storage constraint.)
- Idempotency: `id` unique; `(runId, seq)` unique and gapless per run as
  ingested (I-4). Re-ingestion of a duplicate `id` is a no-op.

## 3. SSE projection (per conversation)

`GET /api/conversations/:id/events`, `text/event-stream`. SSE `id:` is the
global per-conversation event sequence; on reconnect the Hub replays from the
store starting after `Last-Event-ID` (ADR-004). Heartbeat comment every 25 s.

| SSE `event:` | Payload | Emitted when |
| --- | --- | --- |
| `run.state` | `{runId, state, error?, killOutcome?, sweepResult?}` | every state-machine transition (05) |
| `message.delta` | `{runId, messageId, text}` | assistant text chunks from `output` events |
| `activity.item` | `{runId, kind: "command" \| "file" \| "denial", detail}` | derived from `tool_use` / `permission_denial` |
| `run.usage` | `{runId, totalCostUsd?, numTurns?, source}` | terminal runs (FR-18; `source: "cancelled-unknown"` has null cost) |
| `conversation.state` | `{status}` | provisioning lifecycle (UC-01, FR-33) |

The SSE payloads are a *projection* — recomputable from `RunEvent` rows; a
client that misses everything can rebuild from `GET /api/runs/:id` +
`GET /api/conversations/:id` (NFR-07).

## 4. Runner command contract (summary — normative text in ADR-003)

- Command: `claude -p --output-format stream-json --verbose --allowedTools
  <allowlist> --max-turns <caps.maxTurns> [--resume <runtimeSessionId>]`,
  prompt **via stdin**.
- Exec env: `CLAUDE_CODE_OAUTH_TOKEN` (SEC-07) + `HUB_RUN_ID=<runId>` (sweep
  marker) — validated against the seam's env rules before dispatch.
- Post-cancel sweep: follow-up exec scanning `/proc/*/environ` for
  `HUB_RUN_ID=<runId>`; TERM→poll→KILL survivors; report
  `{scanned, killed[], survivors[]}` into `Run.sweepResult`.
- Exec `maxDurationMs` = run wall-clock cap; kill `graceMs` = 5000.

## 5. Initial agent allowlist (Q-02 deliverable)

Default agent (`dev`) allowlist for Phase 1:

```text
Read, Grep, Glob, Write, Edit, Bash
```

Rationale, informed by the S-01 `tool_use` corpus and R-05:

- The six cover the entire observed corpus (file create/read/run flows).
- **Excluded: web tools** (`WebFetch`, `WebSearch`) — with open container
  egress they are the shortest prompt-injection exfiltration path (R-05);
  Bash can reach the network too, but curl-from-Bash appears in the audit
  trail as an explicit command (SEC-08), while WebFetch normalizes it.
- **Excluded: `Task`** (subagents) — multi-agent is Phase 4; a subagent
  inside the CLI would evade per-run caps accounting.
- Everything excluded surfaces as `permission_denial` → visible partial
  outcome (FR-15), never a silent capability.
- Command-pattern narrowing (`Bash(gh pr view:*)`-style) and autonomy-tier
  mapping are the SEC-09 path, deliberately not in Phase 1.

## 6. Error taxonomy

Machine-readable `code` on run errors and API error bodies:

| Code | Meaning | Surfaces as |
| --- | --- | --- |
| `provisioning_failed` | session create/bootstrap failed (UC-01) | conversation `status: error` |
| `seam_unavailable` | substrate unreachable / 5xx | run `failed`; retryable by re-send |
| `exec_refused` | seam 409/429 (container down, caps) | run `failed` (FR-33 context attached) |
| `run_timeout` | wall-clock cap hit (FR-17) | run `failed` |
| `budget_exceeded` | lagging budget estimate crossed (ADR-003) | run `failed` |
| `cancelled` | user cancel (FR-20) | run `cancelled` (not an error code on the API) |
| `runtime_error` | CLI exited non-zero without result / `error` event | run `failed`, stderr excerpt attached (capped) |
| `internal` | anything else | run `failed`; alert-worthy |

`completed_with_denials` is a **state**, not an error — the denial list rides
the activity projection (FR-15).

## 7. Contract tests

- The sanitized S-01 fixtures are the canonical corpus for the
  stream-json → `RunEvent` mapping (both adapters must produce identical
  event streams from them — A1/R-12).
- SSE replay: kill the connection mid-run in tests, reconnect with
  `Last-Event-ID`, assert gapless projection (doc 13).
- Fixture refresh procedure on CLI bumps: re-run the S-01 package, sanitize,
  re-record (R-02).
