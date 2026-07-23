# ADR-014 — One active task per conversation; messages steer it

Status: accepted (owner, 2026-07-23)
Date: 2026-07-23

## Context

The task envelope (ADR-009) classifies **each message independently**: every
turn the router labels `task` in a project conversation spawns a **new**
supervised dev → QA task. The 2026-07-22 production incident showed the
pathology: one conversation produced **four sibling tasks** — the original
request, then three retries of "can you implement it with the brief?" — each
spawning a full kickoff + worktree + dev → QA loop, all four failing (the
underlying causes were #123 and #124). The owner experienced this as noise: the
conversation was one piece of work, but the system kept minting parallel
containers for it.

Two structural facts make sibling tasks in one conversation worthless anyway:

- **They never actually run in parallel.** I-2 serializes runs per workspace,
  so a second task spawned from the same conversation only queues behind the
  first. The user gains no concurrency — only duplicated kickoffs, worktrees
  and cost.
- **The conversation is already the task's chat surface.** Step runs are
  hosted by the originating conversation; the task affordance hangs on the
  kickoff turn (N5b-2b). A second task in the same thread splits one dialogue
  across two containers.

Owner direction (2026-07-23): a conversation should hold **one** task; if the
user mixes topics inside it, that is the user's problem — the task binding
holds unless the user explicitly says otherwise.

## Options

1. **Do nothing** — keep per-message classification. Every work-shaped
   follow-up spawns a sibling task: spawn storms under retry behavior (the
   observed incident), duplicated cost, and a conversation whose tasks
   compete for the same workspace queue.
2. **A conversation IS a task, forever** — the strictest reading: one task
   per conversation, ever; further work requires a new conversation. Cleanest
   mental model, but after `approved` the conversation becomes a dead end,
   forcing conversation proliferation for every follow-up — and the sidebar
   becomes the task list, badly.
3. **One ACTIVE task per conversation; messages steer it** — while a
   conversation has a non-terminal task, no message may spawn a sibling;
   messages are either answered (questions) or folded into the running task
   (steering). After the task reaches a terminal state, the conversation is
   free again: the next work-shaped message starts the next task in the same
   thread. An explicit user request is the only way to split earlier.

## Decision

Option 3.

- **Invariant (new I-14): a conversation has at most one non-terminal task.**
  The envelope gate checks for an active task on the conversation before
  spawning; while one exists, nothing spawns a sibling.
- **Messages during an active task are classified `question` or `steer`**
  (the router's `question`/`task` output re-read under an active task —
  `task` means *steer the existing one*, never *create another*):
  - `question` → a normal turn; the conversation's agent answers with task
    context (status, reasoning, content questions). Read-only with respect
    to the task.
  - `steer` → owner input for the task, folded at the **next step boundary**
    (the next developer prompt carries it, the same way QA feedback and
    `changes_requested_by_user` notes are folded today). A running step is
    never interrupted mid-flight; cancel remains the explicit interrupt.
  - Steering a task in `awaiting_human_approval` re-enters the loop through
    the existing `changes_requested_by_user` path — the chat message becomes
    the note. The N6 approve/reject affordances remain the formal verdict.
- **Mixed topics do not split the task.** If the owner mixes unrelated asks
  into the thread, they ride along as steering (owner's explicit call: that
  is the user's problem, not the system's to second-guess). The escape hatch
  is **explicit, never inferred**: a user-visible affordance ("start a new
  task" — exact UI/marker is implementation) is the only early split.
- **After a terminal task** (`approved`/`rejected`/`failed`), the next
  work-shaped message starts a fresh task (new worktree/branch) in the same
  conversation. Parallel work remains available the honest way: separate
  conversations (separate projects if true concurrency is wanted — I-2).

Reversible: this is orchestration policy over existing state — no migration
(`tasks.source_conversation_id` already exists; enforcement is the envelope
gate plus a supervisor feedback fold).

## Consequences

- **Kills the spawn storm class.** Retries and follow-ups converge on the one
  task instead of minting siblings; kickoff spam disappears; cost per
  conversation drops to one worktree/loop at a time.
- **The conversation becomes the task's dialogue**, matching the owner's
  mental model and the UI that already exists (kickoff affordance, activity
  history).
- **Router contract change (ADR-012 amendment on acceptance):** under an
  active task the classification's `task` outcome is interpreted as `steer`.
  The router stays a proposer; the orchestrator's gate is what enforces I-14
  (01 §3 — the model never mints a task).
- **Supervisor gains a feedback fold:** pending owner steering is queued and
  injected at the next step boundary. Mid-step steering is deliberately NOT
  live-injected (a step is one CLI turn; interrupting it is `cancel`).
- **Risk accepted:** a genuinely new, unrelated ask typed into a busy
  conversation waits for the active task (or the user splits explicitly).
  That friction is chosen over the system guessing topic boundaries.
- Follow-ups: implementation increment (envelope gate + steer fold + UI
  affordance); ADR-012 §Decision amendment; doc 06 gains I-14; doc 05 UC
  update for the steering flow.
