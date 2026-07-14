# shared-terminal Exec API — tracking document

> **TRACKING** — the canonical contract now lives upstream:
> [`docs/EXEC_API.md` in shared-terminal](https://github.com/gatof81/shared-terminal/blob/main/docs/EXEC_API.md),
> implemented, deployed, and verified end-to-end (shared-terminal #381 →
> #385/#386/#387, verified here at `main @ b37dc4d`). This file records what
> the Hub *consumes*, the deltas between the accepted merged contract and the
> original proposal from [ADR-001](../adr/ADR-001-shared-terminal-exec-seam.md)
> (the proposal's full text lives in this file's git history), and the
> Hub-side implementation notes those deltas imply. On upstream changes to
> `EXEC_API.md`, this file is updated in the same PR that adapts the Hub.

## Surface consumed by the Hub

| Endpoint | Use |
| --- | --- |
| `POST /sessions/:id/exec` → NDJSON stream (`started` / `output` / `dropped` / `exit` / `error`, versioned `v:1`) | one call per run turn (FR-10) |
| `GET /sessions/:id/exec/:execId` → `running \| exited \| unknown` | boot reconciliation (FR-23, UC-06) |
| `POST /sessions/:id/exec/:execId/kill {graceMs}` → `already-exited \| terminated \| killed` | cancellation (FR-20, UC-04) |

Auth: existing JWT, session ownership enforced (Hub uses its dedicated
account, SEC-06). `X-Request-Id` emitted on every response and echoed in
`started` — recorded per run (OPS-04).

## Deltas: merged contract vs the ADR-001 proposal

| Topic | Proposal said | Merged contract says | Hub consequence |
| --- | --- | --- | --- |
| Status of an unknown `execId` | `404` | **`200 {state:"unknown"}`** — after a substrate restart, "registry lost" and "never existed" are indistinguishable, so 404 would lie. Kill keeps `404` for unknown ids; registry entries age out after 1 h | UC-06's `unknown` branch handles both cases; never treat `unknown` as "run never happened" |
| `maxDurationMs` omitted | unspecified | **defaults to the 1 h cap — an exec is always bounded** | Hub still always sends its own tighter per-run timeout (FR-17); the seam backstop is defense in depth |
| Pre-`started` output overflow | not covered | new **`dropped` event** (`{v:1, type:"dropped", scope:"pre-start", bytes}`), non-terminal: the 256 KiB pre-start hold buffer overflowed and `bytes` were discarded — signaled, not silent | Ingestion persists it (FR-16 covers it as a typed event); activity view can mark truncation |
| `env` limits | flat 32 KiB | **session-config rules**: name charset, ≤ 64 entries, ≤ 4096 B/value, ≤ 64 KiB total | Runner env (OAuth token + per-run vars) fits comfortably; validate Hub-side before dispatch to fail fast |
| Kill vs natural-exit race | not covered | **kill `outcome` is authoritative** over the stream's `reason` when they disagree | Never retry or re-classify a run based on `reason` alone; record both, trust `outcome` |
| Exit code of a killed exec | implied 128+signal | **raw signal number** (e.g. `15` = SIGTERM; `setsid -w` propagation, upstream #386) | Use `reason` as the primary classification signal; `exitCode` is diagnostic |
| Caller-supplied `X-Request-Id` | MAY be adopted | **ignored**; the response header is always the substrate's own id | One id to record, no ambiguity |
| Operational limits | suggested values | **4 concurrent execs/session · 120/min per IP (start+kill; status unlimited) · `graceMs` ≤ 30000** | FR-19 serializes runs per session anyway (1 ≪ 4); reconciliation polling uses status freely |

## Related upstream closures

- **Zombies (Q-08): resolved.** Upstream confirmed accumulation (3 permanent
  zombies per group kill, measured) and shipped `Init: true` (docker-init as
  PID 1, #387), pinned by smoke-test **Phase 9**. Containers created before
  the fix need one recycle (handled in the deployment).
- Per-user quotas (#202): `GET /quotas` lets the Hub's service account check
  headroom before creating sessions — input for doc 12/14.

## Non-goals (v1, unchanged)

Event replay/resume · stdin/PTY (the terminal WS remains the interactive
surface) · multi-replica exec registry.
