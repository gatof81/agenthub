# Agent Hub — documentation

Specification workspace for Agent Hub. **The specification is complete and approved** (docs 01–18 approved by the owner on 2026-07-15; ADR-001..005 accepted; spikes S-01/S-03 executed; doc 18 is a non-normative vision companion). **All quality gates below have passed. Increment 1 is complete** (B1-01..B1-12, [17-phase1-backlog.md](./17-phase1-backlog.md)); Increment 2 (real substrate + real Claude, B2-01..05) is in progress.

All repo artifacts are in English. Substrate facts are verified against
[shared-terminal](https://github.com/gatof81/shared-terminal) at commit `36be2f2` unless noted;
re-verify before relying on them after that repo moves.

## Document index

All specification documents are drafted and **approved** (owner, 2026-07-15);
every index row links to its doc. **Status** is the document's maturity, not
its PR state. The work plan below tracks per-PR/build progress separately.

| Doc | Status | Depends on |
| --- | --- | --- |
| [01-product-brief.md](./01-product-brief.md) | approved | — |
| [02-substrate-analysis.md](./02-substrate-analysis.md) | approved | — |
| [03-scope-and-phases.md](./03-scope-and-phases.md) | approved | 01 |
| [04-requirements.md](./04-requirements.md) | approved | 01, 03 approved |
| [05-use-cases-and-flows.md](./05-use-cases-and-flows.md) | approved | 04 |
| [06-domain-model.md](./06-domain-model.md) | approved | 04, 05 |
| [07-architecture.md](./07-architecture.md) | approved | 06, ADR-001..004 |
| [08-api-and-event-contracts.md](./08-api-and-event-contracts.md) | approved | 07, spike S-01 |
| [09-persistence.md](./09-persistence.md) | approved | 06, ADR-002 |
| [10-security-threat-model.md](./10-security-threat-model.md) | approved | 07, 16 |
| [11-ux-specification.md](./11-ux-specification.md) | approved | 05 (frontend framework decided here) |
| [12-mvp-implementation-plan.md](./12-mvp-implementation-plan.md) | approved | 07–11 |
| [13-testing-strategy.md](./13-testing-strategy.md) | approved | 04, 08–12 |
| [14-observability-and-operations.md](./14-observability-and-operations.md) | approved | 07 |
| [15-open-questions.md](./15-open-questions.md) | approved | — |
| [16-risk-register.md](./16-risk-register.md) | approved | — |
| [17-phase1-backlog.md](./17-phase1-backlog.md) | approved | 12 |
| [18-agent-collaboration-model.md](./18-agent-collaboration-model.md) | approved — vision, non-normative (not gate-relevant) | 01, 03 |
| [adr/](./adr/README.md) | ADR-001..005 all accepted | see adr/README.md |

**Specification complete and approved.** Suggested full read-through order: 01 → 02 → 03 → 18 → 15 → 16 → ADR-001..005 → spike results → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 14 → 17.

## Decisions requested now

From [15-open-questions.md](./15-open-questions.md):

No decision is blocking. Q-01/Q-02/Q-04/Q-05/Q-08/Q-10 are resolved
(see doc 15 — Q-08 closed upstream 2026-07-14: exec API #385 and `Init: true`
(#387) shipped and deployed; **Increment 2 is unblocked** and R-08 is closed).
S-01 and S-03 both executed 2026-07-14; ADR-001..005 are accepted.
Owner housekeeping: the scratch D1 `agenthub-s03-scratch` can be deleted.
**The owner approved docs 01–18 on 2026-07-15** — all quality gates are
*passed*; implementation is underway (Increment 1 complete, doc 17).

## Architecture decision records

New repo, new numbering (the discovery-era ADR list predates the separate-repos
decision and is superseded):

| ADR | Topic | Status |
| --- | --- | --- |
| [ADR-001](./adr/ADR-001-shared-terminal-exec-seam.md) | Integration seam with shared-terminal: exec-over-HTTP contract (transport, auth, framing, cancellation, reconnection, correlation, versioning — and the "ask for nothing new" option) | **accepted & implemented upstream** (#385) — [contracts/shared-terminal-exec-api.md](./contracts/shared-terminal-exec-api.md) tracks the canonical `EXEC_API.md` |
| [ADR-002](./adr/ADR-002-hub-persistence.md) | Hub-owned persistence: **SQLite local + scheduled backups to R2** (the initial D1 directive was reverted when S-03 fired the pre-agreed latency gate); also records the deployment shape (co-located Node backend + Pages frontend, resolves Q-05) | **accepted** (2026-07-14) |
| [ADR-003](./adr/ADR-003-claude-cli-runner.md) | Claude CLI runner integration: per-turn command construction, event mapping, marker-based post-cancel sweep, budget strategy (S-01 lessons encoded) | **accepted** (2026-07-14) |
| [ADR-004](./adr/ADR-004-ui-streaming-transport.md) | Hub↔frontend streaming: SSE with `Last-Event-ID` replay from the store | **accepted** (2026-07-14) |
| [ADR-005](./adr/ADR-005-project-aggregate.md) | **Project as the organizing aggregate** — owner-directed pivot: one workspace/container per project, conversations share it; minimal Phase-1 shape with an explicit deferred list (R-17) | **accepted** (2026-07-14) |

Remaining candidate (deferred, non-blocking): Hub user/auth model (Q-07).

## Spikes

| Spike | Question it settles | Status |
| --- | --- | --- |
| S-01 | Headless runner probe on pinned CLI 2.1.207: freeze-without-permission-flags, per-turn `--resume` latency, mid-tool-call cancellation via process-group kill, cost/`session_id` result fields, `tool_use` event shape | **EXECUTED 2026-07-14** — all questions answered; see [spikes/S-01/RESULTS.md](./spikes/S-01/RESULTS.md). Headlines: no freeze but silent auto-denial; per-turn resume ≈ 0.6 s; unreaped zombies per cancelled run (1 in S-01's probe, 3 in upstream's broader count — Q-08, since resolved by `Init: true`); **Bash-tool children survive group kill** (runner post-cancel policy needed) |
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
6. Domain model (06) — **merged (GitHub #10)**.
7. Architecture (07) + ADR-003/ADR-004 — **merged (GitHub #12), ADRs accepted**.
8. API & event contracts (08) — **merged (GitHub #13)**.
9. Persistence (09) — **merged (GitHub #14)**.
10. Security threat model (10) — **merged (GitHub #16)**.
11. UX specification (11) — **merged (GitHub #17)**; Q-06 resolved: React + Vite.
12. MVP implementation plan (12) — **merged (GitHub #18)**; fake-runtime increment first.
13. Testing strategy (13) and observability (14) — **merged (#19, #20)**.
14. Phase-1 backlog (17) + quality-gate review — **merged (GitHub #21)**.
15. Second direction review: collaboration model (18) + amendments — **merged (GitHub #22)**; owner approved docs 01–18 (gates passed, GitHub #23 records it).
16. **Increment 1 — fake-runtime spine, complete**: backend B1-01..09 + B1-11 + BX-01 (GitHub #26), frontend B1-10 (GitHub #27), command palette B1-12 (GitHub #28).
17. **Increment 2 — real substrate + real Claude, COMPLETE**: B2-01 real `SubstrateExecPort` + offline conformance suite (GitHub #29); B2-02 real session provisioning (GitHub #30); B2-03 real `claude-cli` adapter + B2-04 real-vs-fake contract test (GitHub #31); B2-05 composition-root wiring + token hygiene (GitHub #32) + agentSeed wire fix and **live end-to-end acceptance passed on the deployment host** (GitHub #33). **Next: Increment 3 (hardening, B3-01..07).**

## Quality gates

**All gates passed** — the owner approved the drafts (docs 01–18) on
2026-07-15. Implementation is underway: Increment 1 complete, Increment 2
in progress (doc 17).

| Gate | Artifact | State |
| --- | --- | --- |
| Product brief approved | 01 | **passed** (owner, 2026-07-15) |
| MVP scope approved | 03 | **passed** (owner, 2026-07-15) |
| Architecture reviewed | 07 | **passed** (owner, 2026-07-15) |
| Domain model validated | 06 | **passed** (owner, 2026-07-15) |
| Initial threat model | 10 | **passed** (owner, 2026-07-15) |
| Main contracts defined | 08 + exec contract (live upstream) | **passed** |
| Critical flows defined | 05 | **passed** (owner, 2026-07-15) |
| Test & migration strategy | 13 | **passed** (owner, 2026-07-15) |
| Phase-1 backlog exists | 17 | **passed** (owner, 2026-07-15) |
| ADR-001..005 resolved; later ADRs at least drafted | all five accepted | **passed** |
| MVP-phase risk mitigations accepted | 16 (closed/accepted per doc) | **passed** (owner, 2026-07-15) |

## Changelog

- **2026-07-15** — **Two-level sidebar IA + contrast pass** (owner UX
  feedback on the B1-10 UI): projects home vs in-project context with a
  dropdown project switcher and `‹ All projects`; explicit new-conversation
  affordance; border/tone tokens replace black hairlines so panels read
  as panels (GitHub #34).

- **2026-07-15** — **Increment 2 COMPLETE — live end-to-end acceptance
  passed** on the deployment host (dedicated seam account, Q-04): real
  provisioning (template → create → agentSeed bootstrap → ready), a real
  Claude turn ($0.059, 1 turn, summary present, exact-marker response),
  `--resume` continuity (second turn recalled the first's marker
  verbatim), cancel mid-run (202 → `cancelled`), archive (session
  stopped). Two findings, both fixed or routed: (1) `agentSeed` fields
  are byte-capped **strings** on the wire — `settings` is serialized
  JSON; the port now stringifies and the contract double enforces the
  wire shape it previously masked. (2) A kill-outcome race (kill
  round-trip vs stream end) loses the diagnostic `killOutcome` field on
  real cancels — state stays correct; fix routed to B3-01 with analysis.
  **Increment 3 (hardening) is next.**

- **2026-07-15** — **B2-05 (wiring half)**: `HUB_RUNTIME=fake|real` selects
  the stack in the composition root (pure resolution in
  `config/runtime.ts`, fail-fast on missing real-mode variables, names
  only — values never echoed); real mode wires `CookieSeamAuth` +
  `RealSubstrateExecPort` + `ClaudeCliRuntimeAdapter` and injects
  `CLAUDE_CODE_OAUTH_TOKEN` into each run's exec env alongside the
  existing `HUB_RUN_ID` marker. Token-hygiene test (13 §5): the canary
  token reaches exec env only and the raw SQLite file bytes contain no
  trace after full turns. `.env.example` documents the matrix. CI stays
  fake/credential-free. **Open**: the live end-to-end acceptance (real
  project → real session → real Claude turn) waits on the dedicated seam
  account.

- **2026-07-15** — **B2-03 + B2-04**: real `claude-cli` adapter (ADR-003
  command construction with the S-01 traps guarded: variadic allowlist ⇒
  stdin prompt, empty `--resume` omitted, empty policy rejected at the
  boundary per I-7) sharing the fake's mapping loop by construction; the
  real-vs-fake contract test pins identical AdapterItem streams across all
  S-01 fixtures, whole and chunk-split, plus one full-real-stack run
  (adapter → real port → contract double). Fake-port fidelity fix the
  contract test surfaced: natural exits now carry `reason:"exited"` like
  the wire always does.

- **2026-07-15** — **B2-02 session provisioning**: the real port now does
  UC-01 end-to-end — template materialized client-side (upstream presets),
  `agentSeed` folded in (seed overrides per-field), async-bootstrap wait
  via the bootstrap-log readiness signal (no WebSocket dependency),
  hard-fail surfaced as a typed provisioning error with a tail-capped log,
  quota 429 mapped, tolerant stop. Fixed in passing: the seam login path
  is `/api/auth/login` (the whole upstream router mounts under `/api`) —
  B2-01 had `/auth/login` and its double mirrored the mistake; both
  corrected against the verified mount. Conformance suite grows to 34.

- **2026-07-15** — **Increment 2 started**: B2-01 real `SubstrateExecPort`
  (HTTP exec/status/kill, NDJSON reassembly, JWT-cookie auth with one
  retry-on-401, Hub-side seam-limit validation) + offline conformance suite
  against a wire-accurate contract double, with fake-parity assertions
  (R-12). Contract gap found and bridged: the seam has no stdin channel —
  ADR-003 prompts ride an injection-safe `bash -c` argv wrapper (payload
  counts against the 32 KiB cmd cap); recorded in the contract tracking doc.

- **2026-07-15** — **Increment 1 complete** (B1-01..B1-12): offline
  backend spine — store/domain/orchestrator/fakes/API/SSE + module-boundary
  lint (GitHub #26); React + Vite frontend, Mac three-pane + iPhone
  single-column (GitHub #27); command palette, closing 11 §8's action-set
  question (GitHub #28). Full spine runs offline and deterministic in CI
  with no credentials present (13 §6). **Increment 2 (real substrate +
  real Claude, B2-01..05) is next.**

- **2026-07-15** — **Execution topology clarified** (owner's
  session-ownership question, analyzed — the spec already matched: ADR-005
  rejected session-per-conversation): normative **three-term glossary** in
  06 §1 (substrate session = Project's persistent environment; runtime
  session = a runtime's continuity transcript, `Conversation`-held in P1;
  agent role = reusable config, no session of its own). 18 §2 gains
  "Execution topology": sessions are stable reused resources; default =
  role template executes inside the target project's substrate session
  under an isolated runtime session; new-session creation requires a
  concrete operational cause; Run/Step environment selection reserved for
  later phases; the logical exclusion unit is the **workspace** (I-2's
  per-project rule is its P1 realization); role-specific sessions = future
  exceptional topology with disposable/project-partitioned transcripts.
  Two rejected shapes added (18 §10). No MVP change; Increments 1–2
  untouched.

- **2026-07-15** — **Two dimensions of specialization made explicit**
  (owner's composition question, analyzed): role = stateless template,
  project = stateful context, "project agent" = the derived
  *(project, role)* pair — no new entity. **Knowledge-isolation rule**
  recorded in 18 §2 (accumulated knowledge binds to the pair, never the
  role; templates change only by deliberate edit) with its two security
  grounds (cross-project confidentiality; R-05 blast-radius containment) —
  it constrains Phase-2 registry/memory and Phase-6 memory design.
  `ProjectAgent`-as-entity rejected (18 §10); 06 §Agent forward constraint
  sharpened (stateless template). No MVP change.

- **2026-07-15** — **Owner approved docs 01–18** (after the second direction
  review merged, GitHub #22). All 11 quality gates flip to **passed**; doc
  statuses flip to *approved*. **The specification phase is closed;
  implementation starts at Increment 1 (doc 17).**

- **2026-07-15** — **Second direction review** (owner's 12-idea conceptual
  revision, analyzed critically): half were already adopted by the 07-14
  pivot; the rest consolidated into doc 18
  (agent collaboration model, **vision — non-normative**): Coordinator
  decomposed into Orchestrator/router/supervisor (no new entity), Work
  Products & Knowledge Flow/Context Packages as Phase-4 vocabulary,
  workflow templates code-first (extract at the third pipeline),
  "permanent agents" = (project, agent)-indexed memory, Task parents to
  Project (Phase-2 forward constraint), dashboard as evolution of the
  project view. Rejected shapes recorded in 18 §10. Owner follow-up
  (same PR): **need-to-know knowledge flow elevated to a non-negotiable
  principle (01 §3)**; the Work Product **family envelope**
  (type/producer/provenance/structured body) fixed in 18 §4 with
  RunSummary as its first member; **Project Policies** (declarative
  gates, branch-protection analogy) recorded as future direction (18 §7).
  Amendments: 01 §1/§3/§4, 03 §1, 11 §7; R-17 broadened to vision churn.
  **No MVP change; quality gates untouched.**

- **2026-07-15** — Doc 17 (Phase-1 backlog: Increment-1/2/3 work items,
  each traceable to FR/module/UC) drafted (GitHub #21). **Specification
  complete** — docs 01–17, ADR-001..005, spikes S-01/S-03 all merged; quality
  gates satisfied pending owner approval. Doc 14 merged.

- **2026-07-14** — Doc 14 (observability & operations: correlation-id
  logging, backup-freshness alert, operator runbooks) drafted (GitHub #20).
  Doc 13 merged.

- **2026-07-14** — Doc 13 (testing strategy: fixture-driven offline CI,
  contract-test spine, security-derived tests from threat model) drafted
  (GitHub #19). Doc 12 merged.

- **2026-07-14** — Doc 12 (MVP implementation plan: 3 increments
  fake→real→hardening, backend-first module build order, quality-gate
  mapping) drafted (GitHub #18). Doc 11 merged (Q-06: React + Vite).

- **2026-07-14** — Doc 11 (UX spec: React + Vite framework decision [Q-06],
  Mac productivity + iPhone conversational targets, IA, SSE client contract)
  drafted (GitHub #17). Doc 10 merged.

- **2026-07-14** — Doc 10 (threat model: trust boundaries, assets,
  5 attackers, vectors V-1..V-5 with prompt injection central, open-source
  posture incl. private deployment repo recommendation) drafted (GitHub #16).
  Project pivot merged.

- **2026-07-14** — **Project-centric pivot** (owner direction, analyzed and
  incorporated): ADR-005 accepted — Project aggregate owns the workspace,
  conversations share it (container economics + mental model). Mechanical
  `RunSummary` per terminal run (A6, first Work Product). Agents restated as
  professional roles. Task entity and Work Products named as Phase 2-4
  evolutions. UX-07 (Mac+iPhone), SEC-10 (config privacy), Q-11, R-17.

- **2026-07-14** — Doc 09 (persistence: DDL, guarded-update invariant
  enforcement, migrations, snapshot/restore procedure with retention and
  drill requirement) drafted (GitHub #14). 08 merged.

- **2026-07-14** — Doc 08 (Hub HTTP+SSE contracts, RunEvent schema with 64 KiB
  cap, initial `dev` allowlist, error taxonomy) drafted (GitHub #13).
  ADR-003/004 accepted; 07 merged.

- **2026-07-14** — Doc 07 (architecture: context/modules/runtime/deployment)
  with ADR-003 (CLI runner integration) and ADR-004 (SSE to the UI) drafted
  (GitHub #12). Q-09 resolved: TS/Node. I-8 wording fixed (write-once
  cliVersion). 06 and the exec-seam tracking PR merged.

- **2026-07-14** — Upstream landed the exec seam (shared-terminal #385/#386/#387,
  deployed & verified): contract doc now TRACKS canonical `EXEC_API.md` with the
  accepted deltas; Q-08 resolved (`Init: true`); FR-22 retired; R-04 residual (a)
  and R-08 closed; 02 gains a `b37dc4d` addendum. **Increment 2 unblocked.**
- **2026-07-14** — Doc 06 (domain model: 2 aggregates, invariants I-1..I-8,
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
