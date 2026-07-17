# ADR-007 — Session ownership moves to the owner's admin account; projects bind or create

Status: accepted (owner, 2026-07-17)
Date: 2026-07-17

## Context

A Hub project's substrate session is today an internal artifact: `provision()`
always creates a fresh session (`backend/src/orchestrator/orchestrator.ts:216`)
with a throwaway name (`hub-<hex>`, `backend/src/substrate/real.ts:303`) owned
by the Hub's dedicated substrate account (SEC-06; Q-04's provisional
resolution). The owner cannot see it in their own Shared Terminal account,
open its terminal, read its history, or continue an agent's work by hand. The
only view into the work is the Hub's own record of runs and events.

The owner's correction directive (2026-07-17) reverses this premise: **a
project corresponds to a real Shared Terminal session belonging to the
owner's admin account** — the same session where the owner develops the
project manually. The Hub must be able to bind an existing session or create
one *in the owner's account*, and the owner must be able to intervene before,
during, or after any agent execution. JSON records remain activity logs; they
do not replace the interactive session.

Substrate facts, verified at shared-terminal `0cd4ed5` (the Hub's previous pin
`36be2f2` predates the entire exec API — 28 commits behind):

- Listing: an account lists its own sessions (`GET /api/sessions`,
  `routes/sessions.ts:440-489`); an **admin** lists all sessions with owner
  attribution (`GET /api/admin/sessions`, `routes/admin.ts:113-158`).
- Metadata: `GET /api/sessions/:id` is operate-tier — owner OR admin — since
  upstream #412 (`routes/sessions.ts:501`).
- The admin-operate series (#410–#414) added `assertCanOperate` (owner OR
  admin, `sessionManager.ts:447-455`), admin terminal take-control with an
  audit trail (`session_observe_log.mode = observe|operate`), and operate
  gates on several REST routes.
- **Exec is still owner-only** (`routes/exec.ts:88,298,338`) — the one gate
  that blocks delegated execution. Upstream ask: shared-terminal#416.
- Creation is always caller-owned (`routes/sessions.ts:80,210-217`) — no
  create-on-behalf. Upstream ask: shared-terminal#420.
- No free-form session metadata (only `name` ≤64 chars) — upstream #418; no
  session deep link (SPA has no routing) — upstream #419.

## Options

1. **Do nothing** — keep dedicated-account, always-create sessions. Rejected
   by the directive itself: it produces invisible workspaces and a parallel
   copy of every project, which is the core defect being corrected. The
   evidence is concrete: the owner cannot open the very session where their
   project's work happens.
2. **The Hub authenticates as the owner's admin account.** Everything except
   metadata (#418) and deep links (#419) works today. But the Hub would hold
   the owner's own password, its actions would be indistinguishable from the
   owner's (no audit boundary), and a Hub compromise would surrender the
   whole account, not a delimited identity.
3. **Owner-owned sessions; the Hub's dedicated account becomes an
   admin-flagged *execution identity*.** Sessions belong to the owner's admin
   account; the Hub operates them through operate-tier semantics, each
   cross-user action audited (`mode='operate'`). Requires upstream #416
   (operate-tier exec) and, for the create-new flow only, #420
   (create-on-behalf). Bind-existing needs nothing new.

## Decision

Option 3, sequenced **upstream-first** (owner decision, 2026-07-17):
shared-terminal #416/#418/#419/#420 land before the Hub increments that need
them (doc 19 maps the dependencies; discovery needs none of them).

- `SessionBinding` becomes `ProjectSessionBinding`:
  `{sessionId, ownerAccountId, bindingMode: 'existing' | 'created',
  lastKnownState, templateId?}`. `bindingMode` records whether the Hub
  attached to a session the owner already had or created one (in the owner's
  account, via #420). **1 project ↔ 1 primary session** stands (ADR-005).
- Project creation offers both paths (UC-01 amended): select an existing
  admin-account session — the Hub registers the link and creates **nothing** —
  or ask the Hub to create one, owned by the owner's account.
- The dedicated account is demoted from *functional owner* to *execution
  identity*: it authenticates as itself, executes authorized operations on
  the owner's sessions, and owns nothing the owner cares about. SEC-06 is
  rewritten accordingly; Q-04's provisional resolution is superseded.
- Existing Hub-created sessions are marked **`legacy-technical-ownership`**
  at migration: they keep working through the old path, and each can be
  rebound or retired deliberately — never silently reassigned.
- **The owner controls the session lifecycle from outside the Hub.** FR-44's
  reasoning generalizes: a session the owner stopped, renamed, or deleted is
  a state to *observe and surface*, never to repair by silently provisioning
  a replacement. `lastKnownState` remains a UX cache; the substrate stays the
  authority.

Reversibility: the binding shape is additive and migrations are forward-only,
but demoting the technical account is a **security-posture decision** — going
back to hidden Hub-owned sessions would strand owner-account sessions, so
treat the direction as one-way.

## Consequences

- Upstream dependencies made explicit: #416 (exec — the enabler), #418
  (metadata), #419 (deep link), #420 (create-on-behalf). Until #416 ships,
  the Hub cannot execute in owner-owned sessions; increments are sequenced so
  discovery/binding UI work proceeds meanwhile.
- Threat model shifts (doc 10 §2): the technical account now carries the
  **admin flag**, whose reach is the whole session estate (drive terminals,
  stop/delete foreign sessions) — a larger credential than "owns only
  Hub-created sessions". Accepted with mitigations: every cross-user action
  audited upstream, the credential is distinct from the owner's and
  independently revocable, and scoped service tokens are the recorded future
  refinement (deliberately not requested yet).
- The Hub gains session-discovery surface: `SubstrateExecPort` grows
  `listSessions`/`getSession` (+ terminal URL once #419 ships), with the
  conformance suite extended against the contract double.
- Manual intervention becomes a designed-for condition, not an accident:
  runs already serialize per workspace (I-2), and the owner typing during a
  run remains accepted-and-documented behavior (FR-32, R-11) — now in a
  session the owner can actually see.
- The substrate contract doc and doc 02 re-pin to `0cd4ed5` (started here,
  completed in increment N1).
- Supersedes: SEC-06's dedicated-ownership clause, Q-04's provisional
  resolution, and ADR-005's implicit provision-on-create assumption
  (ADR-005's aggregate decision itself stands).
