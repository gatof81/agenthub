# ADR-013 — Decompose the Orchestrator god-class into collaborators behind a thin facade

Status: proposed
Date: 2026-07-21

> Drafted by the architect specialist (Enrique) from the architecture review's
> C4 finding; filed for the owner to accept. Implementation (the extractions) is
> left to the developer, gated on each touching PR.

## Context

`src/orchestrator/orchestrator.ts` is a single class of **~1,768 lines**
(`orchestrator.ts:176-1768`) that has accreted one responsibility per
increment without ever shedding an old one. It now owns, in one type:

- **Session discovery** — `listSessions` (`orchestrator.ts:252`).
- **Project/session provisioning & lifecycle** — `createProject`
  (`:298`), `bindExisting` (`:355`), `provision` (`:458`), `archiveProject`
  (`:542`), `restoreProject` (`:574`), `restoreConversation` (`:632`).
- **Specialist sessions** — `bindSpecialistSession` (`:402`),
  `ensureSpecialistSessionRunnable` (`:1256`).
- **Conversations** — `createConversation` (`:651`),
  `createSpecialistConversation` (`:681`).
- **Send / dispatch / pump** — `send` (`:699`), `pump` (`:746`),
  `idle` (`:762`).
- **The run loop** — `resolveRunSession` (`:1121`),
  `resolveAutomaticTarget` (`:1176`), `executeRun` (`:1281`, ~340 lines
  on its own), `finalize` (`:1627`), `sweep` (`:1715`).
- **Cancellation** — `cancelRun` (`:968`).
- **Boot reconciliation** — `reconcile` (`:1007`, ~90 lines).
- **Task supervision plumbing** — `startTask` (`:778`), `approveTask`/
  `rejectTask`/`finalizeApproval` (`:812`), `requestTaskChanges` (`:836`),
  `runTaskStep` (`:895`), `awaitRunTerminal` (`:936`),
  `finalizeTaskKickoff` (`:948`).

Those zones share nothing but the class instance. The cohesion cost is
concrete: eight mutable maps of run/task state are declared as private
fields (`orchestrator.ts:190-214` — `inFlight`, `cancelRequested`,
`timedOut`, `budgetTripped`, `pendingKills`, `runCompletions`,
`taskDriving`) and mutated from unrelated zones — `cancelRun` writes
`cancelRequested`/`pendingKills`, `executeRun` reads and clears them,
`runTaskStep` registers `runCompletions` awaiters that `finalize` wakes
(`orchestrator.ts:1700-1704`). Any change to one zone is made against the
whole surface.

The testability cost is the load-bearing one. **There is no way to exercise
the run loop, cancellation, or reconciliation without constructing the entire
Orchestrator** — every collaborator it holds must be supplied
(`OrchestratorDeps`, `orchestrator.ts:87-133`: store, adapter, execPort,
agents, router, reportExtractor, workspaceManager, notifier, logger,
metrics, prices, timeouts). A test that wants to assert one
`executeRun` terminal-classification branch (`orchestrator.ts:1520-1622`)
must stand up provisioning, task supervision, and session resolution it does
not care about. The contrast is already in the tree: the **Supervisor** was
extracted as a separate collaborator (`supervisor.ts`) precisely so its loop
is "unit-tested with a fake runner and a fake extractor — no substrate, no
model" (`supervisor.ts:7-12`). That extraction is the proof this works here.

The module-boundary arrows enforced by `eslint-plugin-boundaries` operate at
**module granularity** — `src/orchestrator` is one element
(`eslint.config.js:25`), and its allow-list is
`orchestrator → {orchestrator, domain, store, runtime, config}`
(`eslint.config.js:47-55`). New files under `src/orchestrator/` are all type
`orchestrator` and may import one another (`{ type: 'orchestrator' }` is in
its own allow-list, `eslint.config.js:50`). The module already contains
sibling collaborators that import each other — `router.ts`, `selector.ts`,
`reportExtractor.ts`, `workspaceManager.ts`, `supervisor.ts`
(`orchestrator.ts:34-38`). So **an intra-module split is invisible to the
07 §2 arrows** and cannot violate them by construction, provided each new
collaborator stays inside that allow-list (none needs `api` or the
`substrate` HTTP internals — they use the `SubstrateExecPort`/`RuntimeAdapter`
domain ports, `orchestrator.ts:28-31`).

## Options

1. **Do nothing.** Let the class keep growing per increment (N6b, and beyond,
   each add methods). Rejected: every new feature widens the shared-state
   surface and the un-testable blast radius. The file already crosses the
   threshold where a reviewer cannot hold it in one pass, and the run loop —
   the most correctness-critical code in the Hub (I-2/I-3, FR-04) — is the
   least isolable part of it.

2. **Big-bang rewrite** into a set of services in one PR. Rejected: the run
   loop carries hard-won, live-verified invariants — the kill-outcome race
   (`orchestrator.ts:200-203`, B3-01), the FR-21 sweep ordering inside the
   terminal transaction (`:1541-1558`), the `resolveRunSession`-outside-catch
   wedge fix (`executeRun`'s catch, `:1287-1316`, PR #103). A single large
   diff moving all of that at once maximizes the chance of silently dropping
   one, and the offline suite (doc 13 §6) would have to be rewritten wholesale
   in the same PR — no incremental safety net.

3. **Incremental extraction of named collaborators behind a thin Orchestrator
   facade.** Extract one cohesive zone at a time into a collaborator inside
   `src/orchestrator/`, each with its own fakeable dependencies and its own
   unit tests, leaving `Orchestrator` as a delegating facade that preserves
   the public method surface the `api` module calls. Follows the Supervisor
   precedent exactly.

## Decision

**Option 3.** Decompose `Orchestrator` into four collaborators, all inside
`src/orchestrator/`, with `Orchestrator` reduced to a thin facade that
constructs them, holds the shared references they need, and delegates its
public methods. The 07 §2 boundaries are preserved because the split is
intra-module.

### Collaborators

- **`ProvisioningService`** — project and specialist-session lifecycle that
  never touches the run loop. Takes `listSessions` (`:252`), `createProject`
  (`:298`), `provision` (`:458`), `bindExisting` (`:355`),
  `bindSpecialistSession` (`:402`), `archiveProject` (`:542`),
  `restoreProject` (`:574`), `restoreConversation` (`:632`). Depends on
  `store`, `execPort`, `adapter.awaitReady`, `notify`, `logger`. Owns the
  `provision_*` entries currently in `inFlight` (`:335-343`) as its own map.
  Testable against a fake `execPort` with no run-loop machinery present.

- **`SessionResolver`** — decides *where* a run executes, and only that.
  Takes `sessionMetaForConversation` (`:1109`), `resolveRunSession` (`:1121`),
  `resolveAutomaticTarget` (`:1176`), `ensureSpecialistSessionRunnable`
  (`:1256`), and the `selectExecutionTarget` integration (`:1225`). Depends on
  `store`, `execPort`, `router`, the selector. Returns a resolved `sessionId`,
  a fail signal, or a **"spawn a task" signal** — it must *not* own task
  spawning (today `resolveAutomaticTarget` calls `startTask` +
  `finalizeTaskKickoff` inline, `:1205-1213`); it returns the envelope
  decision and the facade routes it to `TaskCoordinator`. Testable with a fake
  router + store, asserting the ADR-008 decision persisted on the run
  (`:1239`) without executing a turn.

- **`RunLoop`** — the dispatch → execute → terminal engine, and the sole owner
  of `finalize`. Takes `pump` (`:746`), `executeRun` (`:1281`), `finalize`
  (`:1627`), `sweep` (`:1715`), `cancelRun` (`:968`), `excerpts` (`:1754`),
  and the run-healing half of `reconcile` (`:1018-1090`). Owns the run-state
  maps: the run half of `inFlight`, `cancelRequested`, `timedOut`,
  `budgetTripped`, `pendingKills` (`:190-203`). Depends on `adapter`,
  `execPort` (sweep only), `store`, `notify`, `logger`, `metrics`, prices,
  timeout grace. `finalize` stays the single terminal choke point
  (`:1627-1705`) and exposes a hook so it can wake a `TaskCoordinator` awaiter
  (the `runCompletions` wake, `:1700-1704`, becomes an injected callback).
  Testable with a fake `adapter` alone.

- **`TaskCoordinator`** — wraps the existing `Supervisor` and owns everything
  task-shaped. Takes `startTask` (`:778`), `approveTask`/`rejectTask`/
  `finalizeApproval` (`:812`), `requestTaskChanges` (`:836`), `approvableTask`
  (`:860`), `taskObjective` (`:873`), `taskSpecialists` (`:882`),
  `runTaskStep` (`:895`), `awaitRunTerminal` (`:936`), `finalizeTaskKickoff`
  (`:948`). Owns `taskDriving` and `runCompletions` (`:212-213`). Its
  `StepRunner` impl (`:234`) drives one step through `RunLoop.pump` +
  `finalize`'s wake hook — the same seam the `Supervisor` is already tested
  against. Testable with the existing fake `StepRunner`/`extractor` pattern.

`reconcile` (`:1007`) is **not** a fifth collaborator: its provisioning-heal
loop (`:1012-1017`) belongs to `ProvisioningService`, its run-heal loop
(`:1018-1090`) to `RunLoop`, and its queue-rebuild (`:1091-1098`) to
`RunLoop.pump`. The facade sequences the three in boot order.

### The facade

`Orchestrator` keeps its public method names (the `api` module depends on
them, 07 §2) and becomes ~150 lines of construction + delegation. It holds the
one genuinely shared reference — the terminal `finalize` choke point — and
wires the cross-collaborator callbacks: `SessionResolver`'s task signal →
`TaskCoordinator`; `RunLoop.finalize` wake → `TaskCoordinator`;
`TaskCoordinator`'s step runs → `RunLoop.pump`. `idle()` (`:762`) sums the two
in-flight sets across `RunLoop` and `TaskCoordinator`.

### Migration approach — extract at the hilt, not big-bang

No standalone refactor PR. Each collaborator is extracted **as the prep step
of the next PR that already touches its zone**, so the extraction ships with
tests that exercise the new feature:

- N6b (approve → PR) touches the task zone → extract **`TaskCoordinator`**
  first, as its prep. It is also the cleanest cut: `Supervisor` already
  isolates the hard part, and `taskDriving`/`runCompletions` are only touched
  by task code + the one `finalize` wake line.
- The next provisioning/binding change → extract **`ProvisioningService`**
  (already near-independent; no run-state maps).
- The next routing/selection change → extract **`SessionResolver`**.
- **`RunLoop`** is extracted last and most carefully, because it owns the
  invariant-dense core; by then the other three are gone and it is the
  residue, which shrinks the diff and the risk.

Each step is a one-PR, one-coherent-change move (working conventions) that
leaves the offline suite green and the facade's public surface unchanged.

## Consequences

- **Testability win (the point).** After each extraction the corresponding
  loop is unit-testable against narrow fakes, matching what `Supervisor`
  already demonstrates (`supervisor.ts:7-12`): `RunLoop` against a fake
  `adapter`, `SessionResolver` against a fake `router`, `ProvisioningService`
  against a fake `execPort` — none requiring the full `OrchestratorDeps`
  surface (`:87-133`).
- **Boundaries preserved by construction.** The split is intra-`orchestrator`
  (`eslint.config.js:25,47-55`); the arrows are module-granular and cannot be
  crossed by adding sibling files. No `eslint.config.js` change is needed. The
  shared-terminal seam contract (ADR-001) is untouched — collaborators still
  reach the substrate only through `SubstrateExecPort`/`RuntimeAdapter`.
- **Determinism preserved.** No new concurrency or I/O is introduced; the same
  maps and the same single `finalize` transaction (09 §3) move to owners. The
  offline, credential-free suite (doc 13 §6) stays offline.
- **Risk — the `finalize` seam.** `finalize` is reached from `executeRun`,
  `cancelRun`, `reconcile`, `SessionResolver`'s fail paths (`:1127`), and the
  task kickoff (`:957`), and it wakes task awaiters (`:1700`). It must live in
  exactly one owner (`RunLoop`) and be injected into the others as a callback;
  getting this wrong reintroduces the coupling under a new name. This is the
  single most important seam to get right and the reason `RunLoop` is
  extracted last.
- **Risk — shared mutable state leaks.** If map ownership is split imprecisely
  (e.g. `pendingKills` written by both `cancelRun` and `executeRun`,
  `:994,:1356`), a collaborator ends up reaching into another's state and the
  refactor buys nothing. Each map must have exactly one owning collaborator,
  with cross-access only through explicit methods.
- **Risk — invariant regression during a cut.** The live-verified fixes in the
  run loop (B3-01 kill race `:200-203`; FR-21 sweep-in-transaction
  `:1541-1558`; the #103 wedge fix `:1287-1316`) must survive extraction. The
  incremental approach bounds this: each PR moves one zone with the suite green,
  never all at once.
- **No behavior change.** This ADR changes structure only; the public API,
  the run state machine, and every FR/UC cited above are unchanged. If accepted,
  it authorizes the extractions as prep steps — it does not schedule a
  dedicated refactor increment.
