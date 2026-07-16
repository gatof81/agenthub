# 14 — Observability & Operations (Phase 1)

**Status:** approved (owner, 2026-07-15) · **Last updated:** 2026-07-16

How the running Hub is observed and operated: logs, signals, health, the
runbooks a single operator needs, and the alerting floor. Scoped to a
single-replica, co-located, single-user deployment (ADR-002); nothing here
assumes a fleet. Requirements: OPS-01..06; architecture 07 §6.

## 1. Logging

- **Structured JSON logs**, one correlation id per inbound request, propagated
  through the whole async chain and **joined with the seam's `X-Request-Id`**
  per exec on the run row (OPS-04) — so a run in the Hub DB traces to
  shared-terminal's logs and back.
- **Never logged** (SEC-04/05): secrets, OAuth/JWT/Cloudflare tokens, and —
  by default — run-event payloads (asserted by test, doc 13 §5). Log the
  event *type* and ids, not the content.
- Levels: `error` for anything alert-worthy (backup failure, `internal`
  taxonomy code); `warn` for recoverable seam/exec failures; `info` for
  lifecycle (run transitions, provisioning); `debug` off in production.
- **Implementation (B3-07):** `observability/logger.ts` emits one JSON line
  per event (`ts`/`level`/`event`/`cid` + typed fields). The correlation id
  is generated per request, echoed as `X-Request-Id`, and carried through the
  async chain via `AsyncLocalStorage` so a log emitted deep in a run keeps
  the request's `cid`. The `Logger` interface's field type
  (`string | number | boolean | null` only) makes logging a payload object a
  type error — the no-payload guarantee is enforced at the type level, not
  just by discipline, and pinned by a canary test (BX-02, 13 §5).

## 2. Signals (metrics)

Process-local counters/gauges (single replica — no external TSDB required in
Phase 1; expose on an internal endpoint or log-derive):

| Signal | Kind | Why |
| --- | --- | --- |
| run state transitions | counter by state | throughput + failure/cancel rate |
| active runs, queue depth (per project) | gauge | contention visibility (I-2 serialization) |
| seam error rate | counter | seam health, feeds an alert |
| backup freshness | gauge (age of last snapshot) | R-16 — the load-bearing one (OPS-02) |
| Hub DB size + WAL size | gauge | disk trend (OPS-05) |
| per-run cost / per-day rollup | derived from `UsageRecord` | consumption visibility (OPS-06, R-06) |
| CLI version per run | label on run rows | drift detection (R-02) |

## 3. Health

`GET /api/health`:

- **Liveness** (unauthenticated): process up.
- **Detail** (authenticated): a `backup` object —
  `{ enabled, lastSnapshotAt, degraded }` (OPS-02; `degraded` is the
  staleness verdict, true past 2× the interval) — plus seam reachability,
  DB writable, migration/schema version. This is the single pane the
  operator checks.

## 4. Runbooks

| Situation | Procedure |
| --- | --- |
| **Deploy / restart** | stop → deploy → `npm ci && npm run build` → start (`npm start` = `node dist/main.js`); the boot **reconciler heals in-flight runs** (UC-06) and rebuilds the queue — no manual run cleanup. **The production entrypoint is compiled JS, never `tsx`** (B3-09): under the `tsx` loader the clean-shutdown snapshot's first R2 request never completes, so SIGTERM hangs and the snapshot is silently lost. `npm run start:tsx` exists for dev convenience only |
| **Backup** | automatic (`VACUUM INTO` → R2, 6 h + on clean shutdown, OPS-01). The shutdown snapshot is deadline-bounded and always logs its outcome — `backup.shutdown_snapshot` (with the key), `backup.shutdown_snapshot_failed`, or `backup.shutdown_snapshot_timeout`. A manual on-demand trigger is deferred — its interface (admin route vs CLI) is specified with the backup implementation, not here |
| **Restore** | stop → fetch snapshot from R2 → replace DB file (no WAL/SHM) → start → reconciler heals (09 §5); drilled once before Phase-1 exit (OPS-03) |
| **CLI version bump** (substrate updates 2.1.207) | re-run the S-01 package → sanitize → refresh fixtures → run the `RuntimeAdapter` contract test; only then accept the new version (R-02) |
| **Session recycle** | pre-`Init:true` containers need one recycle (shared-terminal #387); new sessions are fine |
| **Project `error` at provisioning, runtime never ready** | the readiness probe (B3-08) timed out: the session exists but `claude` never resolved on PATH — the session image's entrypoint failed its `~/.npm-global` swap. Its own WARN in `docker logs` names the case; recovery is a container recreate (DELETE + `POST /sessions/:id/start`) so the image's npm-global is re-applied. The project keeps its session id, so archiving it still stops the container |
| **Capacity check** | before creating a project, the Hub queries the substrate's `GET /quotas` for headroom (02 §6) — surface low-headroom in the UI |
| **Seam outage** | runs fail with `seam_unavailable` (08 §6) and are re-sendable; no data loss (store is authority). Check substrate health, not the Hub |

## 5. Alerting floor

Minimal, operator-facing (this is a personal deployment, not a NOC):

- **Backup stale** (> 2× interval) — data-loss exposure (R-16), highest
  priority.
- **Seam error rate** sustained — the substrate is down or the credential
  expired.
- **Disk** approaching limit — Hub DB + WAL + workspaces share the host.

Delivery: logs + the health endpoint in Phase 1; push notifications arrive
with the mobile approvals work (Phase 2+, UX-07) and can carry these too.

## 6. Configuration & secrets (ops view)

- All secrets and deployment specifics live in the **private deployment
  config** (SEC-10, 10 §5): `.env`, `agents.<name>.yaml`, compose/systemd,
  hostnames, tunnel. The public repo has only `.env.example` and
  `agents.example.yaml`.
- Scoped credentials: substrate JWT (Hub's dedicated account, SEC-06),
  Cloudflare token (R2 only), Anthropic OAuth token (subscription, Q-10).
  Rotation is a manual restart with new env.

## 7. Deferred (later phases)

External metrics/tracing backend · dashboards · push-notification delivery
(Phase 2+ with approvals) · multi-replica operational concerns (Agent Nodes,
Phase 5) · automated log-based anomaly detection · at-rest encryption
operations. Phase 1 is a single operator reading structured logs and one
health endpoint — deliberately.
