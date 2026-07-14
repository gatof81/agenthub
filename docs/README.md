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
| `04-requirements.md` | not started | 01, 03 approved |
| `05-use-cases-and-flows.md` | not started | 04 |
| `06-domain-model.md` | not started | 04, 05 |
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
| [adr/](./adr/README.md) | ADR-001 accepted · ADR-002 proposed (gated on S-03) | see adr/README.md |

**Reading order for this review round:** 01 → 02 → 03 → 15 → 16 → adr/ADR-001 → adr/ADR-002.

## Decisions requested now

From [15-open-questions.md](./15-open-questions.md):

No decision is blocking right now. Q-02 (runner permission posture) was
resolved 2026-07-14: curated allowlist. ADR-001 was accepted 2026-07-13; its
contract draft is ready to go to the shared-terminal repo as a proposal.
Owner-coordinated next actions: propose the exec contract upstream; schedule
spikes S-01 (API key) and S-03 (scratch D1) — both spend-capped.

## Architecture decision records

New repo, new numbering (the discovery-era ADR list predates the separate-repos
decision and is superseded):

| ADR | Topic | Status |
| --- | --- | --- |
| [ADR-001](./adr/ADR-001-shared-terminal-exec-seam.md) | Integration seam with shared-terminal: exec-over-HTTP contract (transport, auth, framing, cancellation, reconnection, correlation, versioning — and the "ask for nothing new" option) | **accepted** — contract draft at [contracts/shared-terminal-exec-api.md](./contracts/shared-terminal-exec-api.md) |
| [ADR-002](./adr/ADR-002-hub-persistence.md) | Hub-owned persistence: own D1 chosen (owner platform directive; SQLite documented as revert path); also records the deployment shape (co-located Node backend + Pages frontend, resolves Q-05) | **proposed** — acceptance gated on S-03 |

Candidates identified for later steps (written at doc 07 time): Claude CLI runner
integration (per-turn `-p --resume`, policy→flags, cancel mapping — gated on S-01),
Hub↔frontend streaming transport, Hub user/auth model.

## Spikes

| Spike | Question it settles | Status |
| --- | --- | --- |
| S-01 | Headless runner probe on pinned CLI 2.1.207: freeze-without-permission-flags, per-turn `--resume` latency, mid-tool-call cancellation via process-group kill, cost/`session_id` result fields, `tool_use` event shape | package prepared in PR-4; execution coordinated by owner (spends tokens) |
| S-02 | Claude state continuity across container recreate | **resolved upstream** — shared-terminal #371/#378, re-asserted by its CI smoke test |
| S-03 | D1 turn-commit latency, value-size limits, quota math against a scratch database | **required** — gates ADR-002 acceptance (revert criteria defined there); owner-coordinated (needs scratch D1 + scoped token) |

## Work plan

1. **PR-1 (this): foundational docs** — 01, 02, 03, 15, 16, this index, adr/README.
2. **PR-2: ADR-001** — the exec seam, plus `contracts/shared-terminal-exec-api.md` (PROPOSAL to take upstream).
3. **PR-3: ADR-002** — Hub persistence.
4. **PR-4: S-01 package** — script + runbook + fixture sanitization; then execute S-01 (owner-coordinated).
5. Requirements (04) and use cases/flows (05).
6. Domain model (06).
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

- **2026-07-14** — PR-3: ADR-002 (Hub-owned D1, gated on S-03; deployment shape
  recorded, Q-05 resolved). Q-02 resolved: curated allowlist. Risks R-14/R-15
  revived. PR-2 merged earlier the same round: ADR-001 accepted, exec contract
  PROPOSAL ready for upstream.
- **2026-07-13** — PR-1: foundational docs against substrate `36be2f2`. Discovery-era
  drafts (written 2026-07-12 against `7a551f0`, when the Hub was planned inside the
  shared-terminal repo) were curated into these documents; the separate-repos decision
  and the substrate hardening batch (#371/#373/#375/#378) supersede parts of them.
