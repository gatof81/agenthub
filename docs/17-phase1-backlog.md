# 17 — Phase-1 Backlog

**Status:** approved (owner, 2026-07-15) · **Last updated:** 2026-07-15

The actionable work items for the Phase-1 MVP, grouped by the three increments
of [12-mvp-implementation-plan.md](./12-mvp-implementation-plan.md), each
traceable to its requirement, domain element, or use case. This is the
implementation checklist — the last specification artifact. Items are scoped
to be individually testable (doc 13); nothing here introduces a decision not
already in the spec.

Legend: **Traces** = the FR/NFR/SEC/OPS/UX, module (07 §2), UC, or invariant an
item satisfies. **Done when** = its acceptance signal (usually a test).

## Increment 1 — fake runtime, end-to-end

Goal: the full spine offline and deterministic (12 §Increment 1).

| ID | Item | Traces | Done when |
| --- | --- | --- | --- |
| B1-01 | `HubStore` SQLite engine + DDL + migration runner | 09 §1/§2/§4, NFR-01/03 | contract suite green on SQLite + fake; migration apply-from-scratch/version-gap/abort tests pass (13 §4) |
| B1-02 | In-memory `HubStore` fake | NFR-03, 06 §4 | identical contract-suite results incl. guarded-update rejections (I-2/I-3) |
| B1-03 | Domain types + run state machine + guarded transitions | 05, 06, I-1..I-11 | illegal transitions rejected; per-project serialization (I-2) enforced |
| B1-04 | Orchestrator: send → queue → dispatch → ingest → terminal | UC-02/03, 09 §3 | each transition one transaction; queue FIFO per project (FR-04) |
| B1-05 | `RunSummary` mechanical derivation | FR-42, 06 §RunSummary | summary present on every terminal run incl. cancelled (unknown cost) |
| B1-06 | Fake `SubstrateExecPort` (S-01 fixture replay + kill) | A1, NFR-04, 06 §4 | replays started/output/exit; honors kill |
| B1-07 | Fake `RuntimeAdapter` (fixture stream-json → RunEvents) | ADR-003 mapping, A1 | emits the ADR-003 event set from fixtures |
| B1-08 | API: projects/conversations/messages/runs routes | 08 §1, FR-01/03/40/41 | route + auth-gateway coverage test (13 §5) |
| B1-09 | SSE projection + `Last-Event-ID` replay | 08 §3, ADR-004, NFR-07 | reconnect-with-gap test green (13 §4) |
| B1-10 | React + Vite frontend slice (project → conversation → send → stream → activity → summary → cancel) | 11, UX-01..06 | Mac layout drives the fake end-to-end; iPhone single-column renders the same data |
| B1-11 | Module-boundary lint | 07 §2, R-10 | dependency-arrow violations fail CI |

**Increment-1 done:** create project (fake session) → send → fixture-driven
run streams → activity + summary → cancel, entirely offline, deterministic in
CI with no credentials present (13 §6).

## Increment 2 — real substrate + real Claude

Goal: swap both fakes behind unchanged ports (12 §Increment 2). Unblocked —
exec API live upstream, Q-02/Q-10 decided.

| ID | Item | Traces | Done when |
| --- | --- | --- | --- |
| B2-01 | Real `SubstrateExecPort` (HTTP: exec/status/kill, `X-Request-Id` capture) | ADR-001 contract, OPS-04 | conformance suite matches the fake's wire expectations |
| B2-02 | Real session provisioning (template → create → agentSeed → start/stop) | FR-30, ADR-005, 02 §1/§3 | project provisions a real session; instructions seeded |
| B2-03 | Real `claude-cli` `RuntimeAdapter` (stdin prompt, allowlist, `--resume`, env) | ADR-003, SEC-07, Q-02 | real turn produces the same RunEvent shapes |
| B2-04 | Real-vs-fake adapter contract test | R-12, 13 §2 | both produce identical RunEvent streams from S-01 fixtures |
| B2-05 | OAuth token wiring + `HUB_RUN_ID` marker | SEC-07, ADR-003 | token never persisted/logged (13 §5); marker present in exec env |

**Increment-2 done:** a real project runs a real Claude turn end-to-end, real
cost in the summary, `--resume` continuity, activity from live `tool_use`.

## Increment 3 — hardening

Goal: survive the failure modes (12 §Increment 3, UC-06/07/08).

| ID | Item | Traces | Done when |
| --- | --- | --- | --- |
| B3-01 | Cancellation + post-cancel sweep (`HUB_RUN_ID` scan) | FR-20/21, ADR-003 | escaping Bash-tool child is swept; outcome authoritative over `reason` |
| B3-02 | Boot reconciliation (two-transaction) + queue rebuild | FR-23, UC-06, 09 §3 | crash-point tests heal to a legal state |
| B3-03 | SSE resilience (reconnect + REST recovery, mobile backgrounding) | 11 §5, NFR-07 | backgrounding reconnect is normal, not an error |
| B3-04 | Backup pipeline (`VACUUM INTO` → R2) + freshness gauge | OPS-01/02, R-16 | automated restore drill green (13 §4); freshness on `/api/health` |
| B3-05 | Restore drill (production, once before exit) | OPS-03 | a prod snapshot restores into scratch and takes a turn |
| B3-06 | Error taxonomy surfacing + timeouts + lagging budget | 08 §6, FR-17/25, ADR-003, R-06 | every code surfaces; caps enforced |
| B3-07 | Observability floor (correlation ids, counters, health) | 14, OPS-04 | logs carry ids; no payloads logged (13 §5) |

**Increment-3 done:** clean recovery from Hub restart, container recreate, and
seam outage; backup/restore drilled.

## Cross-cutting (throughout)

| ID | Item | Traces |
| --- | --- | --- |
| BX-01 | Config from gitignored deployment config; `agents.example.yaml` in repo | SEC-10, 10 §5 |
| BX-02 | Security-derived test suite (route coverage, no-payload-logging, scrubbing, policy-non-empty, sanitizer gates) | 13 §5, 10 §6 |
| BX-03 | Secret handling (env-only, never in prompts/events/logs) | SEC-04/05, V-2 |

## Explicitly out of Phase 1

Everything on the ADR-005 deferred list (project memory/documents, multi-repo,
multi-terminal, per-project permissions) · Task entity · agent registry UI ·
routing/multi-agent · remote nodes · advanced memory · push notifications ·
autonomy levels ≥ 1 and approvals (the `awaiting_approval` state is reserved,
not built). Each is a later-phase item, tracked in [03](./03-scope-and-phases.md).
