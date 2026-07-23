# Agent Hub — documentation

Specification workspace for Agent Hub. **The specification is complete and approved** (docs 01–18 approved by the owner on 2026-07-15; ADR-001..010 accepted; spikes S-01/S-03/S-04/S-05 executed; doc 18 is a non-normative vision companion). **All quality gates below have passed. Increments 1–5 are complete** ([17-phase1-backlog.md](./17-phase1-backlog.md)). **2026-07-17 — model correction (owner directive):** a project corresponds to a real Shared Terminal session **owned by the owner's admin account**; specialists are reusable identities with optional personal sessions; conversations gain automatic routing; coordinated work gains a dev → QA → human-approval lifecycle. Decisions in ADR-007..010; diagnosis, migration plan, and the N1–N6 increment backlog in [19-model-correction-plan.md](./19-model-correction-plan.md).

All repo artifacts are in English. Substrate facts are verified against
[shared-terminal](https://github.com/gatof81/shared-terminal) at commit `36be2f2` unless noted —
the correction documents (ADR-007..010, doc 19) verify at `0cd4ed5`, and increment N1
completes the full re-pin; re-verify before relying on substrate facts after that repo moves.

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
| [19-model-correction-plan.md](./19-model-correction-plan.md) | approved (owner, 2026-07-17) — diagnosis, migration plan, N1–N6 backlog | ADR-007..010 |
| [adr/](./adr/README.md) | ADR-001..012 + 014–015 accepted, ADR-013 proposed | see adr/README.md |
| [logs/](./logs/README.md) | living — in-repo memory for the stateless specialist roles (architecture / developer / QA) | ADR-008, 18 §2 |

**Specification complete and approved.** Suggested full read-through order: 01 → 02 → 03 → 18 → 15 → 16 → ADR-001..013 → spike results → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 14 → 17 → 19.

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
| [ADR-002](./adr/ADR-002-hub-persistence.md) | Hub-owned persistence: **SQLite local + scheduled backups to R2** (the initial D1 directive was reverted when S-03 fired the pre-agreed latency gate); also records the deployment shape (co-located Node backend serving the SPA same-origin — frontend placement superseded 2026-07-17 from Cloudflare Pages, see ADR-002 Consequences; resolves Q-05) | **accepted** (2026-07-14) |
| [ADR-003](./adr/ADR-003-claude-cli-runner.md) | Claude CLI runner integration: per-turn command construction, event mapping, marker-based post-cancel sweep, budget strategy (S-01 lessons encoded); **amended 2026-07-19 — budget cap optional, off by default** | **accepted** (2026-07-14, amended 2026-07-19) |
| [ADR-004](./adr/ADR-004-ui-streaming-transport.md) | Hub↔frontend streaming: SSE with `Last-Event-ID` replay from the store | **accepted** (2026-07-14) |
| [ADR-005](./adr/ADR-005-project-aggregate.md) | **Project as the organizing aggregate** — owner-directed pivot: one workspace/container per project, conversations share it; minimal Phase-1 shape with an explicit deferred list (R-17) | **accepted** (2026-07-14) |
| [ADR-006](./adr/ADR-006-workspace-belongs-to-the-project.md) | **The workspace belongs to the project, not the agent** — an agent is a role reusable across projects; a project is a workspace with a repository. Adds `Project.repo` + the per-repo credential, and makes per-turn role instructions necessary (FR-45/46/47, SEC-11) | **accepted** (2026-07-16) — shipped in Increment 5; its one deferred consequence (the per-turn mechanism) closed by [S-04](./spikes/S-04/RESULTS.md) |
| [ADR-007](./adr/ADR-007-session-ownership-and-binding.md) | **Session ownership moves to the owner's admin account** — projects bind an existing session or create one there (1↔1 primary session); the dedicated account is demoted to an audited execution identity. Supersedes SEC-06's ownership clause and Q-04. Upstream asks: shared-terminal [#416](https://github.com/gatof81/shared-terminal/issues/416)/[#418](https://github.com/gatof81/shared-terminal/issues/418)/[#419](https://github.com/gatof81/shared-terminal/issues/419)/[#420](https://github.com/gatof81/shared-terminal/issues/420) | **accepted** (owner, 2026-07-17) |
| [ADR-008](./adr/ADR-008-specialists-and-execution-target.md) | **Specialists & execution-target selection** — reusable identities with optional personal sessions; conversation modes (automatic default); router proposes, deterministic selector picks the session, orchestrator enforces; I-2 restated per workspace | **accepted** (owner, 2026-07-17) |
| [ADR-009](./adr/ADR-009-task-lifecycle-dev-qa-approval.md) | **Task lifecycle** — dev → QA → human approval as one concrete flow; `ImplementationReport`/`QaReport` work products; terminal success = owner approval | **accepted** (owner, 2026-07-17) |
| [ADR-010](./adr/ADR-010-code-sharing-strategies.md) | **Code-sharing strategy ladder** — specialist runs in the project session / task worktree by default; read-only, diff, artifact for analysis and review; repo authority stays with the project session | **accepted** (owner, 2026-07-17) |
| [ADR-011](./adr/ADR-011-browser-auth-cloudflare-access.md) | **Browser auth via Cloudflare Access** — the backend verifies the signed `Cf-Access-Jwt-Assertion` (aud + iss + JWKS signature), never the forgeable email header; bearer token retained for localhost/programmatic. Resolves Q-07 for Phase-1 browser auth | **accepted** (owner, 2026-07-17) |
| [ADR-012](./adr/ADR-012-router-model-call.md) | **Automatic-mode model router calls the Messages API directly** (N4b, Haiku 4.5, forced tool call) reusing `CLAUDE_CODE_OAUTH_TOKEN` — a narrow control-plane carve-out from ADR-001's "all model I/O via the seam"; deterministic fallback on failure; offline suite unaffected | **accepted** (owner, 2026-07-19) |
| [ADR-013](./adr/ADR-013-orchestrator-decomposition.md) | Decompose the ~1,667-line **Orchestrator** into four intra-module collaborators behind a thin facade (from the architecture review C4); boundaries preserved, incremental migration | **proposed** (2026-07-21) |
| [ADR-014](./adr/ADR-014-one-active-task-per-conversation.md) | **One active task per conversation (I-14)** — messages steer the running task (`question` answers, `steer` folds at the next step boundary), never spawn siblings; explicit user request is the only early split | **accepted** (owner, 2026-07-23) |
| [ADR-015](./adr/ADR-015-implementer-default-and-architect-consult.md) | **Conversation's agent implements by default; architect as on-demand `design` consult** (read-only, `DesignBrief` work product, bounded); QA remains an unconditional gate | **accepted** (owner, 2026-07-23) |

Remaining candidate (deferred, non-blocking): a full Hub-owned user/tenant
login (ADR-011 Option 4) — Q-07 is resolved for Phase-1 browser auth by
ADR-011; the multi-user model stays future work.

## Spikes

| Spike | Question it settles | Status |
| --- | --- | --- |
| S-01 | Headless runner probe on pinned CLI 2.1.207: freeze-without-permission-flags, per-turn `--resume` latency, mid-tool-call cancellation via process-group kill, cost/`session_id` result fields, `tool_use` event shape | **EXECUTED 2026-07-14** — all questions answered; see [spikes/S-01/RESULTS.md](./spikes/S-01/RESULTS.md). Headlines: no freeze but silent auto-denial; per-turn resume ≈ 0.6 s; unreaped zombies per cancelled run (1 in S-01's probe, 3 in upstream's broader count — Q-08, since resolved by `Init: true`); **Bash-tool children survive group kill** (runner post-cancel policy needed) |
| S-02 | Claude state continuity across container recreate | **resolved upstream** — shared-terminal #371/#378, re-asserted by its CI smoke test |
| S-03 | D1 turn-commit latency, value-size limits, quota math against a scratch database | **EXECUTED 2026-07-14** — gate fired: turn-commit p50 291 ms from the deployment host (ceiling was 150 ms) → ADR-002 reverted to SQLite + R2 backups. See [spikes/S-03/RESULTS.md](./spikes/S-03/RESULTS.md) |
| S-04 | Does `--append-system-prompt` reach the model on pinned CLI 2.1.207, or is it parsed and dropped? (the mechanism ADR-006 refused to assert, blocking B5-04) | **EXECUTED 2026-07-17** — it reaches the model: a codeword injected only via the flag came back, and the control run without it did not know the word. B5-04 unblocked and shipped. See [spikes/S-04/RESULTS.md](./spikes/S-04/RESULTS.md); `spikes/S-04/probe.sh` is re-runnable on a CLI bump (R-02) |
| S-05 | Does the workspace's seeded `settings.json` widen a turn's tools past `--allowedTools`? (provisioning seeded the agent's allowlist into the project's shared workspace — B5-04's bug class, unfixed for tools) | **EXECUTED 2026-07-17** — the seed was **inert, by luck**: a settings file *does* grant tools past the flag via `permissions.allow` (measured), but the key the Hub wrote, `allowedTools`, 2.1.207 ignores. Seed and `SessionSeed.settings` removed, live workspaces remediated; tool enforcement now rests on the flag by construction. See [spikes/S-05/RESULTS.md](./spikes/S-05/RESULTS.md); `spikes/S-05/probe.sh` is re-runnable on a CLI bump (R-02) |

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
17. **Increment 2 — real substrate + real Claude, COMPLETE**: B2-01 real `SubstrateExecPort` + offline conformance suite (GitHub #29); B2-02 real session provisioning (GitHub #30); B2-03 real `claude-cli` adapter + B2-04 real-vs-fake contract test (GitHub #31); B2-05 composition-root wiring + token hygiene (GitHub #32) + agentSeed wire fix and **live end-to-end acceptance passed on the deployment host** (GitHub #33). Two-level sidebar + contrast pass on owner UX feedback (GitHub #34).
18. **Increment 3 — hardening, in progress**: B3-01 cancellation (kill-outcome race fix + FR-21 post-cancel sweep, live-verified, GitHub #35); B3-02 boot-reconciliation hardening (provisioning heal, boot sweeps, idempotence, live-verified, GitHub #36); B3-03 SSE resilience (stall watchdog + proactive wake + heartbeat, first frontend tests, GitHub #37); B3-04 backup pipeline (snapshot sink port, VACUUM INTO → gzip → R2/S3, freshness gauge, restore drill, GitHub #38); B3-06 error taxonomy + timeouts + lagging budget (GitHub #41); B3-07 observability floor (structured logs + correlation ids + metrics, GitHub #42). UX follow-ups: back-arrow + archive projects/conversations + distinct icons (GitHub #40). B3-05 live restore drill green against the real R2 bucket (2026-07-16). **Increment 3 COMPLETE.**
19. **Increment 4 — restore (owner-driven), COMPLETE**: B4-01/B4-02 `startSession` + the `archived → ready` transitions, with FR-44 pinned — a restore whose session is gone upstream returns `409 session_gone` and leaves the project archived, never a fresh workspace wearing the old name (GitHub #50); SSE cold-connect fix (GitHub #51); B4-03 archived view + restore + confirmations that state what actually happens (GitHub #54).
20. **Increment 5 — repo in project (owner-driven), COMPLETE**: ADR-006 (GitHub #52) and its spec — FR-45/46/47 + SEC-11 (GitHub #53); B5-01/02/03 the workspace belongs to the project, `Project.repo` reaches the seam, and the per-repo PAT reaches the seam **and nowhere else** (GitHub #55) + icon padding (GitHub #56); B5-04 per-turn role instructions, unblocked by spike S-04 verifying `--append-system-prompt` against the pinned CLI rather than assuming it.

## Quality gates

**All gates passed** — the owner approved the drafts (docs 01–18) on
2026-07-15. Implementation is underway: Increments 1–5 complete (doc 17).

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
| ADR-001..005 resolved; later ADRs at least drafted | all five accepted; ADR-006 accepted and shipped, ADR-007..010 accepted (2026-07-17 correction) since | **passed** |
| MVP-phase risk mitigations accepted | 16 (closed/accepted per doc) | **passed** (owner, 2026-07-15) |

## Changelog

- **2026-07-19** — **Budget cap made optional (owner decision, ADR-003
  amendment).** `Caps.budgetUsd` is now nullable and **off by default** — on a
  Claude subscription a dollar figure is a lagging estimate that only trips
  false alarms, not real billing. `--max-turns` + the wall-clock timeout remain
  the always-on runaway bounds; the budget cap is opt-in per role. Amends FR-17,
  R-06, and the B3-06 entry above.

- **2026-07-19** — **Message footer: timestamps + copy (owner decision, doc 11
  §15).** Each message shows a relative time (absolute on hover); assistant
  messages get a copy-the-whole-message button, sharing one `CopyButton` with the
  code blocks. (Scroll-to-latest and one-click Retry already existed.)

- **2026-07-19** — **Sidebar look & function refinements (owner decision, doc 11
  §14).** From a sidebar UX review: a visible "+ Create project" button (was
  Enter-only/undiscoverable), the workspace choice made visible (label +
  single-option summary), the project switcher always offers "All projects"
  (no dead-end) as a `role="menu"`, read-only Sessions/Specialists sections
  divided off and no longer faking hover/click affordance with truncated names,
  and a more present archive control. First `<Sidebar>` component tests (via the
  #89 harness) cover the create button and the switcher. **Follow-up (same day):
  a visual hierarchy** — projects render bolder/roomier so the top-level entity
  stands out, and conversations become a lighter, distinct nested list (muted,
  smaller, a leading dot that lights up when active) instead of sharing the
  projects' row skin. Composer bottom padding also scoped away from desktop
  (`env(safe-area-inset-bottom)` was leaking a gap on some desktop browsers).
  **Also**: reclaimed the dead space below the composer (`.app` had no
  `grid-template-rows`, so its row could size to content and leave a gap on a
  short conversation — now `minmax(0, 1fr)`) and tightened the composer footer;
  provisioning projects show a spinner in their status badge; and archive now
  confirms in an in-app dark-theme modal instead of the native `window.confirm`
  (Escape or an outside click cancels; Cancel is the default focus).

- **2026-07-18** — **User-facing error surface (owner decision, doc 11 §13).**
  Action failures (create/archive project or conversation, specialist bind/chat)
  that used to `.catch(() => {})` silently now raise a dismissible, screen-reader-
  announced toast. Deliberate inline messages (send-error banner, FR-44 restore
  notice, quiet discovery degradation) are unchanged.

- **2026-07-18** — **Modern composer (owner decision, doc 11 §12).** The message
  composer became a rounded full-width field with compact icon controls inside
  it (send morphs to queue while a run is active; cancel appears only then), and
  auto-grows with the draft — so on a phone the controls no longer shrink the
  input. Presentation only; send/queue/cancel behavior is unchanged (§6). Also
  from the frontend code review: a11y + visual fixes (#79), 401 credential
  recovery for REST and SSE (#82), workspace-picker dedup + typed SSE frames
  (#83), and state-teardown/composer-error/type-alias cleanups (#84).

- **2026-07-17** — **Conversation-view UX refinements (owner decisions, doc 11
  §9/§10/§11).** Working the live Phase-1 UI, the owner asked for a series of
  reading/interaction improvements, recorded as spec sub-sections so the code
  citations resolve: **§9** — composer pinned to the bottom with a scrollable
  thread (mobile + desktop), first conversation auto-selected on project open,
  and conversations auto-titled from their first message with inline rename;
  **§10** — assistant responses rendered as Markdown (GFM, safe by default),
  user messages plain; **§11** — syntax-highlighted code blocks with a language
  label + copy button, adjustable conversation text size ("Aa", persisted), no
  iOS zoom on composer focus, and readability polish. Also: the Hub's own
  generic sessions are hidden from the sessions list (ADR-007).

- **2026-07-17** — **N2 complete: create-on-behalf half (doc 19 §7, FR-49).**
  Upstream #420 (admin-only `ownerUserId` on `POST /api/sessions`) shipped and
  was verified at `1a5af57`. A new deployment variable `SEAM_OWNER_USER_ID`
  turns on create-in-the-owner's-account: when set, the Hub creates project
  sessions **in the owner's admin account** on their behalf, so they appear in
  the owner's own Shared Terminal sidebar and are usable manually — recorded
  as `ownership: 'owner'` and treated exactly like a bound session (archive/
  restore never stop or start them, ADR-007). Unset keeps the pre-#420
  self-owned (`legacy-technical`) behavior. `createSession` now returns the
  owner id it created for; a 429 (charged to the **owner's** quota, not the
  Hub's) surfaces as a provisioning error naming the cap
  (`{error, cap}`/`{error, quota}`). With this, N2's two paths — bind an
  existing session, or create one in the owner's account — are both live, and
  acceptance scenarios 1 and 2 are demonstrable end-to-end.

- **2026-07-17** — **N2 project binding, bind-existing half (doc 19 §7,
  FR-49).** Upstream #416 (operate-tier exec) and #418 (`external_ref`)
  shipped and were verified at `c2db7f7` before consuming them. A project
  now binds an existing owner-account session — the Hub validates it
  upstream, records `{bindingMode: 'existing', ownership: 'owner',
  ownerAccountId}` (migration 004; existing rows backfill
  `created`/`legacy-technical`, never reassigned), back-links the session
  via `external_ref = agenthub:project:<id>` (also written at create), and
  creates **nothing**. Lifecycle authority follows ownership: archive/
  restore never stop or start an `owner` session (it is the owner's to
  control, ADR-007) — restore of a bound project whose session was deleted
  outside the Hub still surfaces `409 session_gone` (FR-44 generalized).
  API: `POST /api/projects` takes exactly one of `sessionTemplateId` |
  `sessionId`, and refuses `repo` on the bind path (the session already
  carries its workspace). UI: the create form offers "Bind session: …"
  (unbound owner sessions, listed first) and "New session: …" (templates).
  The create-new-in-owner-account half waits on shared-terminal#420.

- **2026-07-17** — **N1 session discovery (doc 19 §7, FR-48).**
  `SubstrateExecPort` grows `listSessions`/`getSession`; the real port
  prefers `GET /api/admin/sessions` (the only listing with owner
  attribution, ADR-007) and degrades a 403 to the own-sessions listing with
  an explicit `scope: 'own'` — a partial view is surfaced as partial, never
  presented as the estate. `envVars`/container details are dropped at the
  port boundary (SEC-04/05, pinned by a conformance test). New Hub route
  `GET /api/sessions` annotates each session with the project bound to it;
  the projects home lists sessions with name/owner/state. Contract doc gains
  the discovery surface verified at `0cd4ed5`. Terminal deep link waits on
  shared-terminal#419; binding is N2.

- **2026-07-17** — **Model correction (owner directive): projects operate on
  real, owner-visible sessions.** The corrected mental model: a Hub project
  corresponds to a Shared Terminal session **owned by the owner's admin
  account** — the same session where the owner works manually — never a
  hidden session in the Hub's technical account; run/event JSON remains an
  activity log, not a substitute for the interactive session. ADR-007..010
  accepted (ownership & binding; specialists + automatic routing +
  deterministic execution-target selection; Task with dev → QA →
  human-approval; code-sharing strategy ladder). Doc 19 carries the
  diagnosis (only two load-bearing code contradictions: provision-always-
  creates, and the immutable `Conversation.agentId`), the forward-only
  migration plan (004–008, no data loss, legacy sessions marked), and the
  N1–N6 increment backlog. Amendments: FR-01/19/30/40/45, new FR-48..53,
  SEC-06 rewritten, UC-01 bind-or-create, 06 glossary/invariants
  (I-2 per workspace, I-6 direct-mode-only, I-10 nullable-once-set),
  10 §2 asset table, Q-04 superseded, 18 §2/§3/§10 updated in place.
  Substrate re-verified at `0cd4ed5` (old pin predates the exec API);
  upstream asks filed: [#416](https://github.com/gatof81/shared-terminal/issues/416)
  operate-tier exec (the enabler),
  [#418](https://github.com/gatof81/shared-terminal/issues/418) `external_ref`,
  [#419](https://github.com/gatof81/shared-terminal/issues/419) session deep
  link, [#420](https://github.com/gatof81/shared-terminal/issues/420)
  create-on-behalf — sequenced **upstream-first** (owner decision). Preserved
  by construction: chat, streaming, runs, cancellation, adapters, store,
  backups, observability (doc 19 §6).

- **2026-07-17** — **B5-04 per-turn role instructions; Increment 5 done.**
  The last item ADR-006 left open, and the one it refused to assert a mechanism
  for. Spike [S-04](./spikes/S-04/RESULTS.md) settled it first: on the pinned
  2.1.207, a codeword injected only through `--append-system-prompt` came back,
  and the control run without the flag did not know it — the control is the
  load-bearing half, since a pass alone proves only that the model can say a
  word. Provisioning baked the **project's** instructions and the **default
  agent's** into one `CLAUDE.md`, so the workspace carried one role and every
  conversation in the project ran under it: QA inherited DEV's craft. Now the
  project's stay in the shared workspace (every role in the project shares
  them) and the agent's travel per turn. Snapshotted onto the run at send like
  caps and policy (I-8, migration 003), not read from live config at dispatch —
  a queued run survives a restart and a restart re-reads `agents.yaml`. The
  snapshot removes a failure mode rather than adding one: dispatch no longer
  touches live config, so a role deleted from the config cannot strand a run.
  `instructions_snapshot` is NULL only for pre-B5-04 rows and means
  *unrecorded*, never "no role" — agent configs are gitignored (SEC-10), so no
  truthful backfill exists, which is also why the snapshot is the only possible
  answer to "what did this run actually run under?".
- **2026-07-15** — **B3-07 observability floor**: a structured JSON logger
  (`observability/logger.ts`) tags every line with `ts`/`level`/`event` and
  a per-request correlation id propagated through the async chain via
  `AsyncLocalStorage` (echoed as `X-Request-Id`, joining to the seam's own
  id on the run row — OPS-04). The `Logger` field type admits only
  scalars, so logging a payload object is a **type error** — the
  no-payload-logging rule (SEC-04/05, 13 §5) is enforced by the compiler and
  pinned by a canary test. Process-local `CountingMetrics` (run-transition +
  seam-error counters, live active/queued gauges, DB/WAL size) surface on
  authenticated `/api/health`. Logger + metrics are injected ports (new
  `observability` module, boundary-clean); `main.ts` wires the real ones.

- **2026-07-15** — **B3-06 error taxonomy + timeouts + budget**: the run
  loop now enforces the caps and surfaces every 08 §6 code. A Hub
  wall-clock backstop sits over the seam's own `maxDurationMs` cap and
  kills a hung stream → `run_timeout` (also classified from a seam
  `exit reason:"timeout"`). A lagging budget estimate accumulates
  per-message token usage (surfaced as a new `usage` adapter item from
  the stream-json mapping) and trips `budget_exceeded` on crossing
  `caps.budgetUsd` — prices configurable, conservative defaults (a
  runaway cap, not a billing figure; the estimate lags by up to one model
  call, ADR-003; **amended 2026-07-19 — `budgetUsd` is now optional, off by
  default; the always-on bounds are `--max-turns` + wall-clock, see the entry
  below**). Seam 409/429 classifies as `exec_refused`, anything
  unreachable as `seam_unavailable`. Timeout/budget kills resolve as
  `failed` (not `cancelled`) and run the FR-21 sweep for escaped children.

- **2026-07-15** — **B3-04 backup pipeline**: a snapshot-sink port with two
  implementations — a local-file sink (offline/tests) and an R2 sink over
  the S3 API (SigV4 via aws4fetch, ADR-002's durability role). `BackupService`
  takes a consistent `VACUUM INTO` snapshot (never a raw WAL copy),
  gzips it, uploads it, and prunes by retention (newest N + one-per-day for
  M days); failures log loudly and never crash — the freshness gauge goes
  degraded on `/api/health` (OPS-02). Periodic (default 6 h) + clean-shutdown
  snapshots; a `restore-drill.mjs` (OPS-03) downloads the newest snapshot,
  decompresses it, and opens it as a store. `BACKUP_SINK=none|local|r2`
  fail-fast config. Offline tests cover the service/retention/gauge, the
  config matrix, the R2 wire shape (mock fetch), and a full VACUUM→gzip→
  restore round-trip; CI stays credential-free. **The live R2 restore drill
  runs once the bucket credentials land (B3-05).**

- **2026-07-15** — **B3-03 SSE resilience**: the client gains a stall
  watchdog — a phone that suspends the tab freezes the socket without a
  clean close, so the read never errors and the stream would hang forever;
  any byte (data or the server's ~25 s heartbeat) resets the watchdog, and
  a missed window aborts and reconnects. Proactive reconnect on
  tab-foreground (`visibilitychange`) and network `online` skips the wait.
  A backend test pins that idle streams keep emitting heartbeat comments.
  Adds the **first frontend test suite** (vitest, pure — injected
  fetch/timers/wake-target, no DOM) and wires `npm test` into the frontend
  CI job.

- **2026-07-15** — **B3-02 boot-reconciliation hardening**: projects
  caught mid-provisioning by a crash heal to `error` at boot (the
  provision promise died with the process; UC-01's failure path already
  defines retry). The FR-21 marker sweep now runs on both boot kill
  paths — the running→kill branch and the unknown branch, where it is
  the only orphan mitigation available. Sweep failure degrades to a
  warning; a reconcile-idempotence test pins that a second pass changes
  nothing and issues no execs. **Live-verified on the deployment host**
  (`kill -9` the Hub process group mid-run): the streaming run healed to
  `cancelled`, a project caught mid-provisioning healed to `error`, a
  healthy project was untouched, and the post-recovery turn completed
  with `--resume` continuity.

- **2026-07-15** — **B3-01 cancellation hardening** (Increment 3 starts):
  the kill-outcome race found by the live acceptance is closed — terminal
  resolution now AWAITS the in-flight kill round-trip instead of reading
  an outcome map the response may not have reached (reproduced offline
  with a kill-response gate on the fake port; that test fails without the
  fix). FR-21 post-cancel sweep implemented per ADR-003: a bounded
  follow-up exec scans process environs for the run's `HUB_RUN_ID`
  marker, TERM→KILLs escaped Bash-tool children, and the result lands in
  the same terminal transaction (`Run.sweepResult` + SSE notification);
  sweep failure degrades to a summary warning — the cancel stands.
  **Live-verified on the deployment host**: a cancel mid-Bash-tool-call
  recorded `killOutcome: terminated` (lost pre-fix) and the sweep found
  and killed the two escaped processes (tool shell + its 120 s `node`
  child — the exact S-01 escape), zero survivors.

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
