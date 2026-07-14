# Agent Hub — documentation

Specification workspace for Agent Hub. **No product code lands until the quality gates below pass.**

All repo artifacts are in English. Substrate facts are verified against
[shared-terminal](https://github.com/gatof81/shared-terminal) at commit `36be2f2` unless noted;
re-verify before relying on them after that repo moves.

## Document index

Docs 04–14 are planned but not started; they are listed so the index shows the whole shape.
Unwritten docs are intentionally not linked (link check runs in CI).

| Doc | Status | Depends on |
| --- | --- | --- |
| [01-product-brief.md](./01-product-brief.md) | draft — review | — |
| [02-substrate-analysis.md](./02-substrate-analysis.md) | draft — review | — |
| [03-scope-and-phases.md](./03-scope-and-phases.md) | draft — review | 01 |
| [04-requirements.md](./04-requirements.md) | draft — review | 01, 03 approved |
| [05-use-cases-and-flows.md](./05-use-cases-and-flows.md) | draft — review | 04 |
| [06-domain-model.md](./06-domain-model.md) | draft — review | 04, 05 |
| `07-architecture.md` | not started | 06, ADR-001, ADR-002 |
| `08-api-and-event-contracts.md` | not started | 07, spike S-01 |
| `09-persistence.md` | not started | 06, ADR-002 |
| `10-security-threat-model.md` | not started | 07 |
| `11-ux-specification.md` | not started | 05 (frontend framework decided here) |
| `12-mvp-implementation-plan.md` | not started | 07–11 |
| `13-testing-strategy.md` | not started | 08 |
| `14-observability-and-operations.md` | not started | 07 |
| [15-open-questions.md](./15-open-questions.md) | draft — review | — |
| [16-risk-register.md](./16-risk-register.md) | draft — review | — |
| [adr/](./adr/README.md) | ADR-001 accepted · ADR-002 accepted | see adr/README.md |

**Reading order for this review round:** 06 (earlier rounds: 01 → 02 → 03
→ 15 → 16 → ADRs → spike results → 04 → 05).

## Decisions requested now

From [15-open-questions.md](./15-open-questions.md):

No decision is blocking right now. Q-01/Q-02/Q-04/Q-05/Q-10 are resolved (see
doc 15). Q-08 is **confirmed, not resolved**: one zombie per killed run,
residual tracked in R-04, upstream fix pending on
[shared-terminal#381](https://github.com/gatof81/shared-terminal/issues/381) —
the same issue that carries the accepted ADR-001 exec contract proposal.
S-01 and S-03 both executed 2026-07-14; ADR-001 and ADR-002 are accepted.
Owner housekeeping: the scratch D1 `agenthub-s03-scratch` can be deleted.
Next work-plan step: requirements (04) + use cases/flows (05).

## Architecture decision records

New repo, new numbering (the discovery-era ADR list predates the separate-repos
decision and is superseded):

| ADR | Topic | Status |
| --- | --- | --- |
| [ADR-001](./adr/ADR-001-shared-terminal-exec-seam.md) | Integration seam with shared-terminal: exec-over-HTTP contract (transport, auth, framing, cancellation, reconnection, correlation, versioning — and the "ask for nothing new" option) | **accepted** — contract draft at [contracts/shared-terminal-exec-api.md](./contracts/shared-terminal-exec-api.md) |
| [ADR-002](./adr/ADR-002-hub-persistence.md) | Hub-owned persistence: **SQLite local + scheduled backups to R2** (the initial D1 directive was reverted when S-03 fired the pre-agreed latency gate); also records the deployment shape (co-located Node backend + Pages frontend, resolves Q-05) | **accepted** (2026-07-14) |

Candidates identified for later steps (written at doc 07 time): Claude CLI runner
integration (per-turn `-p --resume`, policy→flags, cancel mapping — gated on S-01),
Hub↔frontend streaming transport, Hub user/auth model.

## Spikes

| Spike | Question it settles | Status |
| --- | --- | --- |
| S-01 | Headless runner probe on pinned CLI 2.1.207: freeze-without-permission-flags, per-turn `--resume` latency, mid-tool-call cancellation via process-group kill, cost/`session_id` result fields, `tool_use` event shape | **EXECUTED 2026-07-14** — all questions answered; see [spikes/S-01/RESULTS.md](./spikes/S-01/RESULTS.md). Headlines: no freeze but silent auto-denial; per-turn resume ≈ 0.6 s; 1 zombie per cancelled run (Q-08 confirmed); **Bash-tool children survive group kill** (runner post-cancel policy needed) |
| S-02 | Claude state continuity across container recreate | **resolved upstream** — shared-terminal #371/#378, re-asserted by its CI smoke test |
| S-03 | D1 turn-commit latency, value-size limits, quota math against a scratch database | **EXECUTED 2026-07-14** — gate fired: turn-commit p50 291 ms from the deployment host (ceiling was 150 ms) → ADR-002 reverted to SQLite + R2 backups. See [spikes/S-03/RESULTS.md](./spikes/S-03/RESULTS.md) |

## Work plan

Plan labels (PR-0…PR-4) are the kickoff's logical batch numbers; GitHub PR
numbers are noted per item as they land, since the two drift.

1. **PR-1 (GitHub #2, merged): foundational docs** — 01, 02, 03, 15, 16, this index, adr/README.
2. **PR-2 (GitHub #3, merged): ADR-001** — the exec seam, plus `contracts/shared-terminal-exec-api.md` (PROPOSAL to take upstream).
3. **PR-3 (GitHub #4): ADR-002** — Hub persistence.
4. **PR-4 (GitHub #5): S-01 package** — script + runbook + fixture sanitization; then execute S-01 (owner-coordinated).
5. Requirements (04) and use cases/flows (05) — **merged (GitHub #8)**.
6. Domain model (06) — **drafted (GitHub #10), in review**.
7. Architecture (07) + remaining ADRs.
8. API & event contracts (08) — gated on S-01 fixtures.
9. Persistence (09).
10. Security threat model (10).
11. UX specification (11) — frontend framework decision.
12. MVP implementation plan (12) — fake-runtime increment first.
13. Testing strategy (13) and observability (14).
14. Phase-1 backlog + quality-gate review → implementation may start.

## Quality gates (implementation may not start before all pass)

- Product brief approved (01)
- MVP scope approved (03)
- Architecture reviewed (07)
- Domain model validated (06)
- Initial threat model (10)
- Main contracts defined (08 + ADR-001 contract proposal)
- Critical flows defined (05)
- Test & migration strategy (13)
- Phase-1 backlog exists
- ADR-001 and ADR-002 resolved; later ADRs at least drafted
- Mitigations accepted for every MVP-phase risk in 16 marked open

## Changelog

- **2026-07-14** — Doc 06 (domain model: 2 aggregates, invariants I-1..I-9,
  3 ports) drafted (GitHub #10). 04/05 merged.
- **2026-07-14** — Docs 04 (requirements, stable IDs, spike-traceable) and 05
  (run state machine + 10 flows) drafted (GitHub #8).
- **2026-07-14** — S-03 EXECUTED (GitHub #7): the pre-agreed latency gate fired
  (turn-commit p50 291 ms > 150 ms from the deployment host) and the owner
  confirmed the reversion — ADR-002 accepted as **SQLite local + R2 backups**.
  R-14/R-15 closed (mooted); R-16 opened (backup-pipeline failure).
- **2026-07-14** — S-01 EXECUTED (GitHub #6): sanitized fixtures + RESULTS.
  Q-01/Q-10 closed; Q-08 confirmed (upstream #381 pending); R-03 re-scoped
  (silent denial, not freeze). Auth: subscription OAuth validated headless.
- **2026-07-14** — PR-4 (GitHub #5): S-01 spike package (probe script, kill/zombie
  instrumentation, sanitizer, runbook). Exec contract proposed upstream:
  shared-terminal#381.
- **2026-07-14** — PR-3 (GitHub #4): ADR-002 (Hub-owned D1, gated on S-03;
  deployment shape recorded, Q-05 resolved). Q-02 resolved: curated allowlist.
  Risks R-14/R-15 revived. PR-2 (GitHub #3) merged earlier the same round:
  ADR-001 accepted, exec contract PROPOSAL ready for upstream.
- **2026-07-13** — PR-1: foundational docs against substrate `36be2f2`. Discovery-era
  drafts (written 2026-07-12 against `7a551f0`, when the Hub was planned inside the
  shared-terminal repo) were curated into these documents; the separate-repos decision
  and the substrate hardening batch (#371/#373/#375/#378) supersede parts of them.
