# 11 — UX Specification (Phase 1)

**Status:** approved (owner, 2026-07-15) · **Last updated:** 2026-07-16

The model-relevant UX: device targets, information architecture, the surfaces
each device needs, and how the client consumes the event stream. This is a
*specification of behavior and structure*, not visual design — pixels, spacing,
and theming are implementation. Requirements: UX-01..UX-07
([04](./04-requirements.md)); flows: [05](./05-use-cases-and-flows.md);
streaming: [ADR-004](./adr/ADR-004-ui-streaming-transport.md).

## 1. Frontend framework (Q-06 resolved)

**Decision: React + Vite**, deployed static to Cloudflare Pages (target fixed
by ADR-002). Consumes the API + SSE per ADR-004; TypeScript throughout,
matching the backend (Q-09).

**Rationale:** the Mac productivity surface (UX-07) — command palette,
resizable multi-panel layout, inspector, drag & drop — maps 1:1 onto mature,
focused React libraries (`cmdk`, `react-resizable-panels`, `dnd-kit`,
TanStack Query/Router). As a library React needs a stack assembled around it,
but since the maintainer delegates implementation, that cost is the
implementer's and the ecosystem fills it; React also has the strongest
AI-assisted-development support, which directly affects velocity and defect
rate here.

**Considered and rejected:** **Angular (latest)** — genuinely strong,
batteries-included (a real advantage for a solo developer assembling nothing),
TS-first, and Pages-compatible; rejected only because its component ecosystem
for this specific productivity surface is thinner (more built by hand) and the
maintainer delegates coding, neutralizing Angular's structure advantage.
**SvelteKit / SolidJS** — leaner, but smaller productivity-component
ecosystems for the same reason. **Vanilla TS** — Q-06 already ruled out the
substrate's no-framework rule here; a multi-panel streaming productivity UI in
vanilla grows unmaintainable (the pre-separation vanilla-TS scope concern, now
closed — see the dropped-risks table in [16](./16-risk-register.md)).

The choice is reversible in principle (the API/SSE contract is
framework-agnostic) but not cheaply once built; recorded as a decision, not a
provisional.

## 2. Device targets (UX-07)

Two first-class web experiences, one backend. No native apps in Phase 1.

| | Mac (productivity) | iPhone (conversational) |
| --- | --- | --- |
| Primary use | deep work: drive projects, inspect runs, manual terminal | check in, steer, approve, read results |
| Layout | multi-panel (projects · conversation · activity inspector) | single-column, conversation-first |
| Terminal | secondary panel available (FR-31) | **never required** — no terminal surface at all |
| Input | keyboard-first: command palette, shortcuts, drag & drop | touch, dictation, share-sheet in |
| Notifications | in-app | push (Phase 2+, when approvals/long tasks land) |

The API must fully serve the iPhone experience **without** a terminal or
desktop session — a hard constraint on every surface, not a styling choice
(UX-07). FR-31 (open the terminal) is Mac-only and optional.

## 3. Information architecture

```text
Project (the workspace unit — ADR-005)
├─ Conversations[]            ← the dialogue list; each has an agent
│   └─ Messages[]             ← user + assistant turns
│       └─ Run                ← one per user message (FR-03)
│           ├─ live stream    ← message deltas (SSE)
│           ├─ Activity       ← commands · files · denials (projection)
│           ├─ Usage          ← cost / turns
│           └─ Summary        ← the RunSummary (FR-42), always present when terminal
├─ Session/terminal           ← shared by all the project's conversations (Mac)
└─ Agent(s)                   ← config-defined roles (Phase 1)
```

Navigation entry point is the **project**, matching the mental model
(ADR-005). A conversation is always viewed inside its project; the activity
inspector is a peel-back detail (UX-01/02), never imposed.

**Archive is the product's delete, and it is reversible (FR-43).** Two
consequences the UI owes the owner, both learned from him losing work to it:

- **Archived items stay reachable** — an archived view (projects and
  conversations, `?archived=true`) with a restore action. Without it,
  "reversible" is true only of the database, which is no comfort to the
  person looking at the screen.
- **The confirmation says what will actually happen** — that archiving a
  project stops its session and that it can be restored later. It must not
  imply an item merely "leaves the list" (reads as recoverable when it was
  not) nor claim permanence once FR-43 lands.

Restoring a project restarts its session; a project whose session no longer
exists upstream cannot be restored and says so (FR-44) rather than coming
back as an empty workspace wearing the old project's name.

## 4. Surfaces

### Mac

- **Project switcher** (command palette + sidebar): jump between projects;
  create project (triggers provisioning, UC-01) with agent + instructions.
- **Conversation panel**: the thread with streaming assistant output; queued /
  running / cancelled / interrupted / failed / completed-with-denials states
  visually distinct (UX-03); cancel available whenever a run is active
  (UX-04), showing the real kill outcome (FR-20).
- **Activity inspector** (side panel, expandable): per-run commands, files
  touched, denials, errors, duration, cost (UX-02); the RunSummary at top
  (FR-42) — objective, outcome, continuation.
- **Terminal panel** (secondary): the project's session terminal (FR-31),
  with an "agent working" indicator while a run is active (FR-32).
- **Command palette**: create project/conversation, send, cancel, jump,
  toggle panels — keyboard-first.

### iPhone

- **Conversation-first**: project list → conversation → thread. Provisioning
  and run states shown inline; the activity/summary is a tap-to-expand sheet,
  never a required panel.
- **Approvals** (Phase 2+, reserved): when a run enters `awaiting_approval`
  (05 reserved state), a push notification + inline approve/deny — the reason
  the state was reserved now.
- **No terminal.** Manual intervention on iPhone is out of scope by design;
  the owner uses Mac for that.

## 5. Event consumption (client contract)

- One SSE subscription per open conversation
  (`GET /api/conversations/:id/events`, ADR-004).
- **Reconnect:** resume with `Last-Event-ID`; the Hub replays only
  `run_events`-derived events (`message.delta`, `activity.item`). State/summary
  events (`run.state`, `project.state`, `run.usage`, `run.summary`) are **not**
  replayed — on reconnect the client re-reads current state from
  `GET /api/runs/:id`, `GET /api/conversations/:id`, `GET /api/projects/:id`
  (08 §3). The store is the source of truth; a client that missed everything
  rebuilds from REST (NFR-07).
- **Optimistic send:** the user message renders immediately; the run's `queued`
  or `starting` state arrives in the `202` and is confirmed by the first
  `run.state` event.
- iPhone backgrounding drops the SSE connection routinely — reconnect-from-REST
  must be seamless, not an error state (a mobile-first correctness requirement,
  not an edge case).

## 6. State presentation (UX-03)

| Run state | Presentation |
| --- | --- |
| `queued` | pending indicator; cancelable |
| `starting` / `streaming` | live spinner + streaming text; cancel visible |
| `completed` | normal answer |
| `completed_with_denials` | answer marked partial; denials listed in activity (FR-15) |
| `cancelled` | cancelled marker + what was killed/swept (FR-20/21); cost `unknown` (UX-06) |
| `interrupted` | transient — resolves via reconcile (UC-06); shown as recovering |
| `failed` | error surfaced with its taxonomy code (08 §6), re-send offered |

## 7. Deferred (later phases)

Native iOS app · rich multi-agent visualization (the team pipeline of Phase 4)
· Work Product viewers beyond the RunSummary · project document/memory
browsing UI (ADR-005 deferred list) · offline mode · theming/customization
depth. Phase 1 ships the two device experiences above and nothing past them.

**Direction, not scope:** the Phase-1 project view is the proto-dashboard —
as later phases add entities (tasks, approvals, Work Products, decisions),
the same entry surface evolves into a project overview/dashboard rather
than a conversation list ([18 §9](./18-agent-collaboration-model.md)). An
evolution of one surface, never a Phase-1 deliverable.

## 8. Open UX questions (non-blocking)

- ~~Exact command-palette action set~~ — **settled by B1-12 (2026-07-15)**, as
  planned, during implementation against the API surface (08 §1): send draft ·
  cancel active run · focus composer · toggle activity panel · new project ·
  new conversation · jump to project · jump to conversation.
- Push-notification channel design — deferred with approvals (Phase 2+); the
  model already emits the right events (SSE `run.state`), only a push sink is
  missing (noted in the backlog).
