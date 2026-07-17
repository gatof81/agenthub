# ADR-008 — Specialists as reusable identities; automatic routing and execution-target selection

Status: accepted (owner, 2026-07-17)
Date: 2026-07-17

## Context

Two Phase-1 simplifications block the corrected model (owner directive,
2026-07-17):

- `Conversation.agentId` is required and immutable (I-6,
  `backend/src/domain/types.ts:118`), fixed at creation
  (`orchestrator.ts:349`). The owner must pick who works before saying what
  they need — the opposite of the intended automatic mode, where the system
  decides whether a message is a question or a task, which capabilities it
  needs, and who performs it.
- Execution has no target selection: the session is hard-derived
  project → `sessionBinding` (`orchestrator.ts:546-549`). Doc 18 §2 reserved
  Run-level environment selection as an additive change; the correction pulls
  it forward as a first-class, deterministic function.

The directive also introduces standing, owner-visible **specialist sessions**
("Claudio — Software Developer", "Claudia — QA Specialist") in the owner's
admin account: reusable environments for general conversations and
non-project work. ADR-006 declared that an agent owns no session; doc 18 §10
rejected "permanent role × project session combinations". Both need a
carve-out that does not reintroduce what they rightly killed.

What already aligns: `Agent` is a stateless role template (ADR-006) — exactly
the directive's *Specialist* identity; role instructions travel per turn via
`--append-system-prompt` (B5-04, verified by spike S-04), which is what lets
several specialists share one project session; doc 18 §3 already decomposes
the Coordinator into orchestrator/router/supervisor.

## Options

1. **Do nothing** — keep pinned agents per conversation. Rejected: the owner
   should be able to write *"add per-municipality enrollment and verify it
   doesn't break public enrollment"* without naming specialists or wiring
   their hand-off; today that sentence has no interpreter.
2. **Router picks specialist AND session in one model call.** Rejected:
   environment choice is a resource/authority decision (ownership,
   availability, isolation, locks) — backend-as-authority (01 §3, SEC-01)
   forbids delegating it to a model.
3. **Split the decision:** a model-based **router** proposes (work type,
   capabilities, specialists, steps, completion criteria); a deterministic
   **execution-target selector** chooses the session from real metadata; the
   **orchestrator** validates and enforces. Specialist = identity; specialist
   session = optional, separate binding.

## Decision

Option 3.

- **Specialist** (the entity `Agent` becomes; config-defined as today,
  SEC-10): `{id, name, role, instructions, allowedTools, capabilities}`.
  Identity and behavior rules only — never credentials, repos, or workspaces
  (ADR-006 unchanged on that axis).
- **SpecialistSessionBinding** (new, optional): a standing session in the
  owner's admin account (ADR-007 ownership). A specialist and a session are
  not the same thing: a specialist may execute in a project's primary
  session, in its own personal session, or in a task worktree. (Shape
  refined at implementation — see the N3b-1 amendment in Consequences.)
- **ConversationMode**: `automatic` (default once increment N4 lands) ·
  `preferred-specialist` · `direct`. I-6's immutability survives only in
  `direct` mode; in `automatic` mode no immutable agentId exists — each
  task/step records which specialist actually ran (the audit moves from the
  conversation to the run, where `instructionsSnapshot`/`policySnapshot`
  already live).
- **Selection policy** (deterministic, auditable):
  - Work that modifies a project runs in that project's **primary session**
    (preferably in a task branch/worktree, ADR-010) — it has the real repo,
    unpublished manual changes, local config, and credentials.
  - A specialist session is chosen only for a concrete, recorded reason:
    required tooling the primary lacks, genuine isolation needs, the primary
    being busy *with* a safe parallel-work strategy, or work that does not
    touch the project workspace. Never merely because the worker is a
    specialist.
  - Every choice persists an **ExecutionTargetDecision** on the run:
    `{specialistId, selectedSessionId, reason, alternativesConsidered,
    workspaceStrategy}` — surfaced in the run inspector, not necessarily in
    the main chat.
- **The router proposes; the backend disposes.** Router output is a proposal
  validated against permissions, caps, budgets, queues, and locks before
  anything executes (18 §3's rule, unchanged). Direct mode stays first-class:
  no model call is interposed when the owner pins a specialist.
- **I-2 restated:** at most one active run per **workspace** (substrate
  session). Doc 18 §2 already said the lock follows the workspace; with
  specialist sessions there are simply more workspaces.

## Consequences

- Doc 06 changes: `Agent` → `Specialist` (shape extended with `role`,
  `capabilities`), `Conversation.agentId` → nullable + `mode`, new
  `SpecialistSessionBinding` and `ExecutionTargetDecision`; I-6 scoped to
  direct mode; I-2 re-expressed per workspace.
- Doc 18 amendments: §3's table gains the selector as an explicit fourth,
  deterministic function; §10's "permanent role × project sessions" rejection
  is qualified — **identity-scoped** personal sessions are allowed (this
  ADR), while per-(role × project) session forks stay rejected. The
  knowledge-isolation rule (18 §2) binds harder, not softer: a specialist
  session serving several projects must keep per-project runtime transcripts
  disposable or partitioned.
- Automatic mode adds a model call per message (cost + latency). Accepted:
  bounded by the same caps machinery as any run, and avoidable via direct
  mode.
- Specialist general conversations (no project) require
  `Conversation.projectId` to become nullable (owner decision, 2026-07-17 —
  chosen over implicit per-specialist "home projects"); I-10 becomes "never
  changes once set".
- The router/supervisor design work planned for Phases 3–4 (18 §3) is pulled
  forward into increments N4–N5 with deliberately narrow scope: one concrete
  flow (ADR-009), not a general planner.
- **`SpecialistSessionBinding` shape refined at N3b-1 (2026-07-17):**
  implemented as `{specialistId, sessionId, ownerAccountId, ownership,
  bindingMode, lastKnownState, status: available|busy|offline|error}`.
  `capabilities` was dropped from the binding — capabilities belong to the
  **Specialist** identity (N3a), not to a session; and `ownership`,
  `bindingMode`, and `lastKnownState` were added so a personal session binds
  and is lifecycle-scoped exactly like a project's (ADR-007, migration 004),
  which is what lets N3b-1 reuse the N2 machinery. `busy` is reserved until
  N3b-2, when specialist conversations execute.
