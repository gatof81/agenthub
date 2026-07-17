# ADR-002 — Hub-owned persistence

Status: accepted (owner sign-off 2026-07-14, after the S-03 gate fired)
Date: 2026-07-14

Substrate evidence cited at [shared-terminal](https://github.com/gatof81/shared-terminal) `main` @ `36be2f2`
(`d1Query`: `backend/src/db.ts:81`; `DockerManager.reconcile()`: `backend/src/dockerManager.ts:2254`).
Latency evidence: spike [S-03](../spikes/S-03/RESULTS.md), measured from the deployment host.

## Context

The Hub owns its data: conversations, messages, agents, runs, run events,
usage records. It never touches shared-terminal's D1 (separate repos, no
data-layer coupling). The write pattern is chat-shaped: every turn produces one
message row plus a burst of run events (tool_use activity, state transitions,
a usage record) — tens of writes per turn, read back immediately by the UI.
The hot path sits directly in front of the user: database latency on a turn
commit delays the first token of every reply.

Deployment shape (decided with the owner, resolves Q-05): the Hub mirrors
shared-terminal's own topology — long-lived Node backend co-located on the
substrate's host behind the Cloudflare tunnel, frontend on Cloudflare Pages
(**superseded 2026-07-17 — the backend serves the SPA same-origin instead;
see Consequences**), seam to the substrate over localhost. A Workers-based
*backend* was considered
and set aside: ADR-001's seam consumes long-lived NDJSON streams and keeps
process state (run queue, exec registry, boot reconciliation); on Workers that
requires Durable Objects + Queues — new moving parts against the
anti-over-architecture rule — and forces the seam onto the public tunnel
hostname. Revisit at Agent Nodes time (Phase 5) if remote execution changes
the calculus.

### Decision history

The owner's initial directive (2026-07-14) was a Hub-owned **D1** database for
Cloudflare-stack operational consistency, with acceptance gated on spike S-03
and pre-agreed revert criteria: *turn-commit p50 > 150 ms from the co-located
host, or quota headroom < 10× → revert to SQLite local.* **S-03 fired the
gate**: turn-commit p50 = 291 ms (p95 480 ms); even a single-statement write
or a 50-row read pays a ~260–290 ms round-trip from the deployment host, and
co-location with the substrate does not lower it (D1 latency is
distance-to-Cloudflare-bound). The owner confirmed the reversion the same day.

## Options

### Do nothing — append-only JSON files, no database (rejected)

Chat history could be JSONL per conversation. Fails on first contact with the
product: the activity view queries across runs, run state must survive crashes
consistently (half-written JSON lines corrupt silently), and every later phase
(registry, router, budgets) is relational. A database is the boring, justified
piece.

### Hub-owned D1 (rejected on measured evidence)

The original directive. Real benefits: one platform's tooling across projects,
Time Travel backups for free, no irreplaceable state on the host. Measured
costs ([S-03](../spikes/S-03/RESULTS.md), from the deployment host):

- **~290 ms p50 on the turn-commit hot path** (the pre-agreed ceiling was
  150 ms) and ~260 ms on every UI read — paid before the model even starts.
- No multi-statement transactions; crash windows need reconcile patterns.
- ~100 KB per-statement ceiling (`SQLITE_TOOBIG` between 64 KB and 256 KB)
  forces payload chunking in the schema design.
- Batching discipline is mandatory forever: the naive 3-call commit costs
  ~860 ms p50 — a foot-gun the codebase would have to guard against in review
  indefinitely.

### Postgres (rejected)

No failing constraint justifies it: one user, one replica, personal chat
volume. Operating a Postgres instance buys nothing SQLite doesn't already
provide at this scale (risk R-10).

### SQLite local + scheduled backups to R2 (chosen)

`better-sqlite3` (or equivalent) in WAL mode on the Hub's host:

- **Sub-millisecond turn commits with real transactions** — the entire class
  of batching/reconciliation mitigations D1 required disappears from the hot
  path.
- Perfect fit for the single-replica co-located backend (its documented
  deployment shape).
- The one real D1 advantage — an operated backup story — is recovered with
  **scheduled snapshot uploads to R2**: SQLite's online backup API (or
  `VACUUM INTO`) produces a consistent snapshot file; a timer ships it to an
  R2 bucket with retention. This keeps Cloudflare in the stack where it
  genuinely adds value (durable off-host storage) instead of on the hot path.

## Decision

**SQLite local, with a scheduled snapshot-to-R2 backup pipeline designed in
doc 09 and doc 14.** Backup requirements (hard, day-1): consistent snapshots
(online backup API / `VACUUM INTO` — never a raw file copy of a live WAL db),
configurable cadence + retention, restore procedure documented and tested
once before Phase-1 exit, and a monitored freshness signal — a silent backup
failure is data-loss risk R-16.

## Consequences

- **Repository interface stays** (`HubStore` port, in-memory fake for tests) —
  required by R-13 regardless of engine; also keeps a future engine swap
  contained.
- Risks R-14/R-15 (D1 RTT/cost, D1 non-transactionality) **close** — not
  mitigated but mooted by evidence. New risk **R-16** opens: backup-pipeline
  failure → silent data-loss exposure (see [16-risk-register.md](../16-risk-register.md)).
- R2 enters the stack now with a concrete failing constraint behind it
  (off-host durability for the only copy of every conversation) — consistent
  with the anti-over-architecture rule, and it satisfies the owner's
  Cloudflare-stack preference where it doesn't cost latency.
- The scratch D1 database (`agenthub-s03-scratch`) can be deleted; S-03's
  package stays runnable if D1 economics/latency ever change materially.
- Doc 09 inherits: schema, snapshot/restore design, retention policy, and the
  payload-size lesson from S-03 (cap event payloads — generous, but capped —
  so a single event can never balloon a snapshot or a query result).
- Hub host disk is now stateful beyond workspaces: the SQLite file + WAL live
  outside the substrate's `WORKSPACE_ROOT`; doc 14 owns disk monitoring.
- **Frontend placement amended (2026-07-17): the backend serves the built SPA
  same-origin, not Cloudflare Pages.** The Context above named Pages, but the
  frontend calls `/api` relative (the single-hostname intent of this ADR), and
  Pages serves only static files — hosting the SPA there would split the
  origin and force `VITE_API_URL` + CORS + cross-origin cookies, contradicting
  the single-hostname constraint it was meant to satisfy. So a single
  Cloudflare tunnel points at the co-located Node backend, which serves both
  `/api` and the SPA (`buildApp`'s `staticDir`). Cloudflare's role in the
  stack is unchanged in spirit — tunnel + R2; only the frontend *placement*
  moves from Pages to the same backend. Browser auth for public exposure stays
  open (Q-07): Cloudflare Access as the gate, with the backend verifying the
  signed Access JWT — a later ADR.
