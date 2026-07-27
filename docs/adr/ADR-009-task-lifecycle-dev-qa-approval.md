# ADR-009 — Task entity and the developer → QA → human-approval lifecycle

Status: accepted (owner, 2026-07-17)
Date: 2026-07-17

## Context

Today a task IS a run with bigger caps (06 §5); `awaiting_approval` is a
reserved state name (05), and doc 18 §8 fixed one forward constraint (a Task
parents to the Project). The correction directive (2026-07-17) pulls the Task
entity forward with a concrete requirement: work is **not complete when the
implementer finishes**. It is complete only after QA passes *and* the owner
approves. The directive is equally explicit about the anti-goal: build **one
concrete flow** (development → QA → human approval), not a generic workflow
engine — which is also doc 18 §6's standing rule (code first, extract the
template at the third proven pipeline).

## Options

1. **Do nothing** — keep task-as-run. Rejected: a run has no room for "QA
   rejected this, it went back to the implementer twice, and it now awaits
   the owner" — exactly the states the owner needs to see.
2. **Generic workflow engine** (steps, conditions, templates). Rejected by
   the directive and by 18 §6/§10 — zero executed pipelines cannot justify a
   BPM shape.
3. **A Task entity with one hardcoded flow** and typed work products,
   states explicit, loop included.

## Decision

Option 3.

- **Task**: `{id, projectId, sourceConversationId, sourceMessageId, state}` —
  parents to the Project (18 §8), created from a conversation message when
  the router classifies it as coordinated work (a conversation may also just
  answer; not every message creates a task).
- **TaskState**: `planning → implementing → qa_pending → qa_running →
  (changes_requested_by_qa → implementing)* → awaiting_human_approval →
  approved | changes_requested_by_user | rejected | failed`. Terminal
  success is `approved` — never the implementer finishing, never QA passing
  alone. 05's reserved `awaiting_approval` concept lands at the **task**
  level as `awaiting_human_approval`; the run-level reservation stays for
  autonomy-gated tool approval (a different mechanism: approving a result is
  not pre-authorizing dangerous commands).
- **TaskStep**: each step is executed by a specialist in a session chosen per
  ADR-008, producing runs (the existing run machinery unchanged underneath).
- **Work products** (extending the 18 §4 family envelope; `RunSummary` stays
  the first member): **ImplementationReport** `{objective, summary,
  filesChanged, commandsRun, testsRun, knownRisks, commitOrPatch?}` and
  **QaReport** `{requirementsReviewed, testsRun, passed, failed, regressions,
  verdict: passed | changes_required}`. The QA→implementer loop is driven by
  `QaReport.verdict`, and the supervisor hands each step a minimal context
  package (18 §5) — the brief plus the work products it must consume, never
  a transcript dump.
- **Chat shows a readable summary** of coordinated work (who did what, what
  passed, what awaits the owner) with links to the reports, diff, and
  terminal — the owner never has to navigate raw JSON events to learn what
  happened (the run inspector keeps the full detail).

## Consequences

- New store tables (`tasks`, `task_steps`, `work_products`) and API/UX
  surfaces (task view, approval actions) — doc 19 increments N5–N6; DDL in
  doc 09 when N5 lands.
- The supervisor (18 §3's Phase-4 function) arrives early but narrow: it
  coordinates exactly this flow. Generalization still waits for the third
  real pipeline (18 §6 unchanged).
- Approval semantics are explicit: `approved` records the owner's word on
  the *result*; command authorization stays with the allowlist/caps
  machinery (SEC-01/02) — two mechanisms, deliberately not merged.
- Doc 18 §8's "Task, ahead of its phase" is realized; 06 §5's
  deliberately-not-modeled list shrinks accordingly.

## Boot reconciliation of tasks (amended, N6)

UC-06 (doc 05) heals in-flight **runs** at boot. The same obligation extends to
**tasks**: a task's progress is driven by the supervisor's `supervise()` loop,
which lives in process memory — a crash kills it, and the Task row would
otherwise sit non-terminal **forever** (the kickoff already told the owner to
expect a result, but nothing remains to advance it). So on boot the reconciler
heals every task in a **transient** non-terminal state to `failed`, cleaning up
its worktree best-effort (ADR-010), after healing its runs.

The distinction that governs the healable set is **transient vs. resting**:

- **Transient** states are mid-flight and only make progress while the
  supervisor loop runs — `planning`, `implementing`, `qa_pending`, `qa_running`,
  `changes_requested_by_qa`, `changes_requested_by_user`. A crash strands them;
  boot heals them to `failed`.
- **Resting** states are waiting on input from outside the process and are **not**
  crash artifacts — they must survive a restart untouched. Today the only one is
  `awaiting_human_approval` (waiting on the owner's verdict). The reconciler
  leaves resting states alone.

Forward constraint: **any new non-terminal task state must be classified
transient or resting when it is added**, and the reconciler's healable set
updated accordingly — a state that is neither healed nor deliberately excluded
is a reconciliation gap.

## Convergence guards on the loop (amended, #124)

The loop's convergence assumed the implementation seat could actually
implement. In production the router's contextual pick for the kickoff message
was the design-only architect, whose hard constraint is *not* to write product
code; QA (correctly) requested changes every cycle, and the task burned all
its cycles to a generic `failed`. Two guards close that class:

- **Capability-gated dev seat.** A task's implementation steps only go to a
  specialist whose declared `capabilities` include `implementation` (a
  specialist declaring no capabilities is unconstrained — backward
  compatible). If the router's proposed specialist cannot implement, the
  orchestrator reroutes deterministically: the conversation's own specialist
  if capable, else the first capable one by stable id order; the QA specialist
  is never eligible (independence). No capable specialist at all → the message
  runs a normal turn instead of spawning a task doomed to loop. The reroute is
  logged (`task.dev_rerouted`); the step rows remain the audit trail.
- **No-progress cut.** After a `changes_required` verdict, a developer attempt
  that changes **no files** cannot alter the next QA verdict — the loop is
  re-reviewing the same tree. The supervisor fails the task immediately with a
  distinct reason (`no_progress`) instead of spending the remaining cycles.

The router still *proposes*; these guards are the orchestrator/supervisor
*disposing* (01 §3) — a model never places itself in the implementation seat.

## Seat precedence (amended, ADR-015)

ADR-015 supersedes the #124 amendment's precedence rule above. The
implementation seat is no longer "the router's pick, rerouted only when it
cannot implement" — the **conversation's own agent takes the seat first**
whenever it is implementation-capable (the entity that already holds the
context implements by default), then the router's proposal when capable, then
the first capable specialist by stable id order. The QA specialist is never
eligible, and "no capable specialist → normal turn" is unchanged. Rationale
and trade-offs in ADR-015.

## The design consult (amended, ADR-015)

The loop gains one optional, bounded step kind: **`design`** — the architect
consult ADR-015 decided, pulled by any of its three requesters via the same
deterministic `NEEDS_DESIGN: <question>` marker:

- **the implementer** — the marker in a developer step's output; the
  developer re-runs with the brief folded into the prompt;
- **QA** — the marker in a changes-required QA output (the failure is
  architectural); the consult runs immediately and its brief is carried into
  the NEXT cycle's first developer prompt;
- **the owner** — the marker in a steering note (ADR-014); the consult runs
  BEFORE the next developer run, so brief and note land in the same prompt.

The consult is one read-only step by the configured design specialist
(declared `architecture`/`design` capability), recording a **DesignBrief**
work product. At most one consult per QA cycle; no design specialist
configured or a failed consult run → a logged no-op, the loop proceeds. The
consult advises; it never gates: QA and owner approval remain the only gates.

## Outcome announcement (amended, 2026-07-27)

A task's resting and terminal outcomes are announced **in the source
conversation** — the same channel the kickoff spoke through — as a
standalone assistant message with no run (`messages.run_id` NULL):

- **`awaiting_human_approval`** — "passed QA and is awaiting your review";
  the owner learns a verdict is wanted without opening the task view.
- **`failed`** (a flow outcome or a supervise crash) — "failed — open the
  task view for the step-by-step trail".
- **boot heal** — a task reconciled to `failed` after a restart announces
  the interruption explicitly.

The note is best-effort (an announce failure never fails the task flow) and
is accompanied by a re-emitted kickoff-run state frame so connected clients
refetch — a repeated state frame is an idempotent projection (NFR-07), not a
new transition. The task view remains the detailed record; the note is the
doorbell.
