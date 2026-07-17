# 17 — Phase-1 Backlog

**Status:** approved (owner, 2026-07-15) · **Last updated:** 2026-07-17

The actionable work items for the Phase-1 MVP, grouped by the three increments
of [12-mvp-implementation-plan.md](./12-mvp-implementation-plan.md), each
traceable to its requirement, domain element, or use case. This is the
implementation checklist — the last specification artifact. Items are scoped
to be individually testable (doc 13); nothing here introduces a decision not
already in the spec.

Legend: **Traces** = the FR/NFR/SEC/OPS/UX, module (07 §2), UC, or invariant an
item satisfies. **Done when** = its acceptance signal (usually a test).

## Increment 1 — fake runtime, end-to-end

Goal: the full spine offline and deterministic (12 §Increment 1).

| ID | Item | Traces | Done when |
| --- | --- | --- | --- |
| B1-01 | `HubStore` SQLite engine + DDL + migration runner | 09 §1/§2/§4, NFR-01/03 | contract suite green on SQLite + fake; migration apply-from-scratch/version-gap/abort tests pass (13 §4) |
| B1-02 | In-memory `HubStore` fake | NFR-03, 06 §4 | identical contract-suite results incl. guarded-update rejections (I-2/I-3) |
| B1-03 | Domain types + run state machine + guarded transitions | 05, 06, I-1..I-11 | illegal transitions rejected; per-project serialization (I-2) enforced |
| B1-04 | Orchestrator: send → queue → dispatch → ingest → terminal | UC-02/03, 09 §3 | each transition one transaction; queue FIFO per project (FR-04) |
| B1-05 | `RunSummary` mechanical derivation | FR-42, 06 §RunSummary | summary present on every terminal run incl. cancelled (unknown cost) |
| B1-06 | Fake `SubstrateExecPort` (S-01 fixture replay + kill) | A1, NFR-04, 06 §4 | replays started/output/exit; honors kill |
| B1-07 | Fake `RuntimeAdapter` (fixture stream-json → RunEvents) | ADR-003 mapping, A1 | emits the ADR-003 event set from fixtures |
| B1-08 | API: projects/conversations/messages/runs routes | 08 §1, FR-01/03/40/41 | route + auth-gateway coverage test (13 §5) |
| B1-09 | SSE projection + `Last-Event-ID` replay | 08 §3, ADR-004, NFR-07 | reconnect-with-gap test green (13 §4) |
| B1-10 | React + Vite frontend slice (project → conversation → send → stream → activity → summary → cancel) | 11, UX-01..06 | Mac layout drives the fake end-to-end; iPhone single-column renders the same data |
| B1-11 | Module-boundary lint | 07 §2, R-10 | dependency-arrow violations fail CI |
| B1-12 | Command palette (create project/conversation, send, cancel, jump, toggle panels; action set settled against 08 §1 per 11 §8) | 11 §4, UX-07 | palette actions drive the same flows as the pointer UI against the fake backend |

**Increment-1 done:** create project (fake session) → send → fixture-driven
run streams → activity + summary → cancel, entirely offline, deterministic in
CI with no credentials present (13 §6).

## Increment 2 — real substrate + real Claude

Goal: swap both fakes behind unchanged ports (12 §Increment 2). Unblocked —
exec API live upstream, Q-02/Q-10 decided.

| ID | Item | Traces | Done when |
| --- | --- | --- | --- |
| B2-01 | Real `SubstrateExecPort` (HTTP: exec/status/kill, `X-Request-Id` capture) | ADR-001 contract, OPS-04 | conformance suite matches the fake's wire expectations |
| B2-02 | Real session provisioning (template → create → agentSeed → start/stop) | FR-30, ADR-005, 02 §1/§3 | port provisions a session from a template with instructions seeded, bootstrap-failure and quota paths typed (conformance suite, offline); the end-to-end "project provisions a real session" flow is exercised when B2-05 wires the real port into the composition root |
| B2-03 | Real `claude-cli` `RuntimeAdapter` (stdin prompt, allowlist, `--resume`, env) | ADR-003, SEC-07, Q-02 | command construction pinned (ADR-003 shape; S-01 traps — variadic allowlist, empty `--resume`, empty policy — guarded by tests); a live real turn rides the B2-05 end-to-end acceptance |
| B2-04 | Real-vs-fake adapter contract test | R-12, 13 §2 | both produce identical `AdapterItem` streams from S-01 fixtures (RunEvent sequencing is the orchestrator's, downstream of the adapters) |
| B2-05 | OAuth token wiring + `HUB_RUN_ID` marker; real port + adapter wired into the composition root | SEC-07, ADR-003, 07 §2 | token never persisted/logged (13 §5); marker present in exec env; **a project provisions a real session end-to-end** (the acceptance deferred from B2-02) — **met 2026-07-15**: live acceptance on the deployment host (real provisioning → real turn, $0.059, summary → `--resume` recall → cancel → archive) |

**Increment-2 done:** a real project runs a real Claude turn end-to-end, real
cost in the summary, `--resume` continuity, activity from live `tool_use`.

## Increment 3 — hardening

Goal: survive the failure modes (12 §Increment 3, UC-06/07/08).

| ID | Item | Traces | Done when |
| --- | --- | --- | --- |
| B3-01 | Cancellation + post-cancel sweep (`HUB_RUN_ID` scan) | FR-20/21, ADR-003 | escaping Bash-tool child is swept; outcome authoritative over `reason`; fix the kill-outcome race found by the Increment-2 live acceptance (kill round-trip vs stream end — the fake's synchronous kill masks it) — **met 2026-07-15, live-verified on the deployment host**: cancel mid-Bash-tool-call recorded `killOutcome: terminated` and the sweep found the two escaped processes (tool shell + its 120 s `node` child — the exact S-01 scenario), killed both, zero survivors |
| B3-02 | Boot reconciliation (two-transaction) + queue rebuild | FR-23, UC-06, 09 §3 | crash-point tests heal to a legal state — **met 2026-07-15, live-verified on the deployment host** (`kill -9` the Hub process group mid-run): the streaming run healed to `cancelled` (`killOutcome: terminated`), a project caught mid-provisioning healed to `error`, a healthy project was untouched, and the conversation stayed usable — the post-recovery turn completed with `--resume` continuity. B3-02 adds the mid-provisioning heal, the FR-21 sweep on both boot kill paths (running→kill and the unknown/orphan branch), sweep-failure degradation, and a reconcile-idempotence test |
| B3-03 | SSE resilience (reconnect + REST recovery, mobile backgrounding) | 11 §5, NFR-07 | backgrounding reconnect is normal, not an error — **met 2026-07-15**: client stall watchdog (a frozen background socket that never errors is aborted and reconnected once the heartbeat gap is missed), proactive reconnect on tab-foreground/network-online, heartbeat resets liveness; server emits periodic heartbeat comments on idle streams. New frontend test suite (vitest) covers the watchdog/wake/close paths; a backend test pins idle-stream heartbeats |
| B3-04 | Backup pipeline (`VACUUM INTO` → R2) + freshness gauge | OPS-01/02, R-16 | automated restore drill green (13 §4); freshness on `/api/health` — **met 2026-07-15**: snapshot sink port (local + R2/S3), `BackupService` (VACUUM INTO → gzip → put → retention), freshness on `/api/health`, clean-shutdown snapshot, `restore-drill.mjs` (OPS-03). The **full 13 §4 drill runs offline** (snapshot an in-flight run → restore → boot reconciliation heals it → a fresh turn runs) via the local sink, plus a mock-fetch R2 wire test. **The same drill against real R2 is B3-05 (pending bucket credentials)** |
| B3-05 | Restore drill (production, once before exit) | OPS-03 | a prod snapshot restores into scratch and takes a turn — **met 2026-07-16, against the real R2 bucket**: the production snapshot path ran on the deployment host (`VACUUM INTO` → gzip → signed put, ~1 s) and `restore-drill.mjs` pulled the newest snapshot back down, decompressed it, opened it as a `SqliteHubStore`, migrated clean and queried it (`RESTORE_OK`). Credentials are a scoped Object-Read-&-Write token, bucket-limited, in the gitignored deployment `.env` only (SEC-10). This drill is what surfaced B3-09 |
| B3-06 | Error taxonomy surfacing + timeouts + lagging budget | 08 §6, FR-17/25, ADR-003, R-06 | every code surfaces; caps enforced — **met 2026-07-15**: Hub wall-clock backstop over the seam's own cap kills a hung stream → `run_timeout` (also classified from a seam `exit reason:"timeout"`); lagging budget estimate from streamed per-message token usage trips `budget_exceeded` on crossing `caps.budgetUsd` (prices configurable, conservative defaults); seam 409/429 → `exec_refused` (with FR-33 session-state context) vs unreachable → `seam_unavailable`. Timeout/budget kills classify as `failed` (not `cancelled`) and run the FR-21 sweep. **Live-verified on the deployment host**: a real turn under a $0.001 cap tripped `budget_exceeded`; the `runtime_error` path (CLI exit 127) also surfaced correctly with its stderr |
| B3-07 | Observability floor (correlation ids, counters, health) | 14, OPS-04 | logs carry ids; no payloads logged (13 §5) — **met 2026-07-15**: structured JSON logger with a per-request correlation id propagated via `AsyncLocalStorage` (joins to the seam's `X-Request-Id` on the run row); the `Logger` type forbids arbitrary objects so payloads/secrets can't be logged (test: a canary prompt never appears in any log line); process-local `CountingMetrics` (run-transition + seam-error counters, live active/queued gauges, DB/WAL size) surfaced on authenticated `/api/health` |

| B3-08 | Runtime readiness probe before a project is `ready` | UC-01, R-02 | a fresh session never takes a turn before its runtime resolves — **met 2026-07-16**: root-caused the `claude: command not found` seen on fresh sessions to the session image's entrypoint swapping `~/.npm-global` (which holds the CLI) for a workspace symlink on every boot, unsynchronised with the session lifecycle — the seam's bootstrap-completion signals are true throughout that window (upstream citations: contracts doc §Gap, verified at shared-terminal `3f1b9e7`). `RuntimeAdapter.awaitReady` polls `command -v claude` through the seam until it resolves; provisioning binds the session id **before** the wait so a failed probe can't leak the container, and a runtime that never resolves fails the project instead of failing a billed turn. The durable fix is an upstream readiness marker (filed) |

| B3-09 | Production build + bounded shutdown snapshot | OPS-01/03, R-16 | the shipped artifact boots in CI; shutdown always logs its snapshot outcome — **met 2026-07-16**: found while running B3-05 that **there was no production build at all** (`start` was `tsx src/main.ts`, `tsconfig` was `noEmit`). Under `tsx` the clean-shutdown snapshot's first R2 request never completes, so SIGTERM hung the process forever and the OPS-01 snapshot was silently lost (A/B-isolated: local sink ✓ / R2 ✗; warm connection ✓ / cold ✗; plain `node` ✓ / `tsx` ✗). Adds `npm run build` (tsc + copy the migration SQL `tsc` ignores), `start` → `node dist/main.js`, and a CI smoke test that **boots** the artifact — compiling was never the property that mattered, which is why the build shipped broken. `BackupService.snapshotOnceBounded` bounds the shutdown snapshot and returns a verdict main.ts always logs (a wedged sink can no longer hang shutdown or fail silently) |

**Increment-3 done:** clean recovery from Hub restart, container recreate, and
seam outage; backup/restore drilled.

## Increment 4 — restore (owner-driven, 2026-07-16)

Goal: make archive honest. Archive is the product's delete and was specified
one-way (FR-40 had no restore); the owner lost projects and conversations to
it with no way back. FR-43/44 close that.

| ID | Item | Traces | Done when |
| --- | --- | --- | --- |
| B4-01 | `SubstrateExecPort.startSession` + restore in the orchestrator | FR-43, 02 §2 | restoring a project restarts its session and returns the **same** workspace; a restored project takes a turn with `--resume` continuity intact (the CLI transcripts live under the workspace, which survives the stop) — **met 2026-07-16**: `startSession` restarts the same session id (never re-provisions); the workspace survives because the bind is derived from the session id, not the container (`dockerManager.ts:440`, verified at shared-terminal `c35b6da`). A restored project passes `send()`, which rejects unless the project is ready — the acceptance, not a green label. `SessionGoneError` lives in `domain/ports.ts` so the orchestrator can catch it without importing substrate (07 §2) |
| B4-02 | API: `archived → ready/active` transitions + `?archived=true` listing | FR-43/44, 08 §1 | the reverse transition is accepted; a restore whose session is gone upstream returns `409 session_gone` and leaves the project archived (FR-44 — never a fresh workspace wearing the old name); restoring a conversation into an archived project is rejected (I-12) — **met 2026-07-16**: both transitions accepted; FR-44 pinned by test (the project stays `archived`, session id intact); the port's `SessionGoneError` is translated to `OrchestratorError('session_gone')` → `409`, while a transient seam failure propagates as itself (retryable ≠ gone). I-12 enforced in the orchestrator, not the route |
| B4-03 | UI: archived view + restore; truthful confirmations | FR-43, UX-08, 11 §3 | archived projects and conversations are reachable and restorable; the archive confirmation states that the session stops and the item can be restored later — **met 2026-07-17**: an `Archived` entry from both sidebar states (the project list and inside a project) opens a view listing archived projects and conversations, each with a restore action. A restore lands in the view the user returns to — a restored conversation would otherwise vanish from the archived list without reappearing in the sidebar, since `conversations` is only populated by opening a project. FR-44 gets a typed surface rather than a generic failure: `session_gone` reads "its workspace was deleted upstream — this project cannot be restored" (retrying never helps), and `project_archived` reads as a step order (I-12), not an error. Both confirmations flipped back from "cannot be restored" — true when written in #48, false once FR-43 landed |

**Increment-4 done:** nothing the owner archives is unreachable, and the UI
never claims more permanence — or less — than the system delivers.

## Increment 5 — repo in project (owner-driven, 2026-07-16)

Goal: make the two axes real. An agent is a role, reusable across projects; a
project is a workspace with a repository. This is what turns "ask QA-AGENT to
review the last PR of Agent Hub" from impossible into a sentence
(ADR-006, FR-45/46/47).

| ID | Item | Traces | Done when |
| --- | --- | --- | --- |
| B5-01 | Move `sessionTemplateId` from `Agent` to `Project`; add `repo_url`/`repo_ref`/`repo_target` (never `repo_auth` — the PAT stays in the seam, SEC-11); migration 002 | ADR-006, FR-45, 09 §1/§4 | provisioning reads the template from the project; the agent config no longer accepts one; existing projects adopt their default agent's template at migration, so nothing re-provisions — **met 2026-07-17**: `Agent` loses the field and **rejects** it at config load rather than ignoring it (a silently dropped template would provision the wrong workspace and look like a working config). Migration **002** exposed a distinction the store contract test caught: `workspace_template_id` (what the project DECLARES, from create) is not `session_template_id` (what the live session was BUILT from, NULL until provisioned) — they coincide today and drift once a declaration is edited, so they get separate columns. Verified against a real 001-era database: the binding is preserved and the declaration backfilled from it, so existing projects keep their exact workspace and nothing re-provisions |
| B5-02 | `Project.repo` → the seam's session config (clone at bootstrap) | FR-45, 02 §2 | a project created with a repo provisions a workspace with that repo cloned at the requested ref; a project without one provisions an empty workspace exactly as today — **met 2026-07-17**: `SessionSeed` carries `repo`; the real port folds it into the seam's config, with the project's repo overriding the template's (a template is a preset, not an authority). Caught here: B5-01 passed `repo` into `createSession` and it went **nowhere** — the field did not exist on the seed and TypeScript allowed it because spreads skip excess-property checks, so a green suite agreed. Pinned by a test: one agent, two projects, two different repos |
| B5-03 | Per-repo PAT plumbing (config → seam encrypted auth) | FR-47, SEC-11, 10 §2 | the PAT reaches the seam's encrypted session config and appears **nowhere** else: not in the Hub DB, not in logs, not in run events, not in the agentSeed — pinned by a canary test in the 13 §5 style — **met 2026-07-17**: `repoAuth` travels as its own value, never a field of `repo`, so no code path can pass the storable half and the secret half around as one object; it is folded in at the last moment before dispatch. The canary reads the **raw database file**, not the store's API — asserting through the API would only prove the API hides it — and also asserts the repo URL IS present, so a canary passing because nothing was written would fail |
| B5-04 | Per-turn role instructions | ADR-006 consequence, FR-11 pattern | a QA conversation and a DEV conversation in the **same** project each run under their own agent's instructions — **met 2026-07-17**: the blocking mechanism is now verified against the pinned 2.1.207, not assumed ([S-04](./spikes/S-04/RESULTS.md), re-runnable on a CLI bump per R-02) — a codeword injected only via `--append-system-prompt` came back, and the control run without the flag did not know it. The split the item turned on: the **project's** instructions stay in the workspace `CLAUDE.md` (every role in the project shares them), the **agent's** travel per turn. Provisioning baked both, so the default agent's craft became the workspace's and every conversation ran under it. Snapshotted onto the run like caps and policy (I-8, migration **003**) rather than read from live config at dispatch: a queued run survives a restart and a restart re-reads `agents.yaml`, so reading the role at dispatch would run the turn under what it says NOW. The snapshot also removes a failure mode instead of adding one — dispatch no longer touches live config, so "the agent vanished from the config" cannot strand a run. `instructions_snapshot` is NULL only for pre-B5-04 rows and means **unrecorded**, never "the role had none": nothing truthful could be backfilled, since agent configs are gitignored (SEC-10), which also makes the snapshot the only possible answer to "what did this run actually run under?" |

| B5-05 | Stop seeding the agent's tool allowlist into the project's workspace | ADR-006 consequence, SEC-02, I-7 | no workspace carries any role's allowlist; a turn's tools come from `--allowedTools` alone — **met 2026-07-17**: found while closing B5-04, the same bug one field over. Provisioning seeded `settings: {allowedTools: agent.allowedTools}`, so the shared workspace wore the *provisioning* agent's tools. [S-05](./spikes/S-05/RESULTS.md) measured it before anything was assumed: the seeded file lands in the CLI's **user-level** settings (`~/.claude` symlinks to `workspace/.st/claude-state`), and a settings file **does** widen a turn past `--allowedTools` — via `permissions.allow`. The Hub wrote `allowedTools`, which 2.1.207 ignores. **The seed was inert by luck, not design**, and a bump honoring that key would have armed it retroactively. Removed the seed *and* `SessionSeed.settings` (the field, not just the call) so re-seeding needs a port change with a spike behind it. Provisioning consequently no longer takes the `Agent` at all — with the allowlist gone, nothing about the workspace was the role's, which is ADR-006's whole point. Deployment-wide settings keep their home in the workspace **template**, whose `agentSeed` the seam preserves and which is the project's (FR-45), so nothing there wears a role's identity |

**Increment-5 done:** one `DEV-Agent` works on two different repositories, and
two different roles work on one repository, without either borrowing the
other's workspace, instructions, or tools — **met 2026-07-17** (B5-01..05).

**Known residual (accepted, owner 2026-07-17): projects provisioned before
B5-04 keep their baked `CLAUDE.md`.** That file lives in the workspace, inside
the container — not in the Hub's database — so B5-04 corrects what provisioning
*writes*, and cannot retroactively unwrite it. A pre-B5-04 project therefore
still carries its default agent's craft in the workspace, and a second role
opened in it reads that craft *plus* its own per-turn instructions. Accepted
rather than fixed: the affected projects are test fixtures, and the case the
increment exists for — a project created for a real repository — is provisioned
after this change and is clean from birth. Re-provisioning is the escape hatch
if a real pre-B5-04 project ever needs the correction; it costs the workspace.

## Cross-cutting (throughout)

| ID | Item | Traces |
| --- | --- | --- |
| BX-01 | Config from gitignored deployment config; `agents.example.yaml` in repo | SEC-10, 10 §5 |
| BX-02 | Security-derived test suite (route coverage, no-payload-logging, scrubbing, policy-non-empty, sanitizer gates) | 13 §5, 10 §6 |
| BX-03 | Secret handling (env-only, never in prompts/events/logs) | SEC-04/05, V-2 |

## Explicitly out of Phase 1

Everything on the ADR-005 deferred list (project memory/documents, multi-repo,
multi-terminal, per-project permissions) · Task entity · agent registry UI ·
routing/multi-agent · remote nodes · advanced memory · push notifications ·
autonomy levels ≥ 1 and approvals (the `awaiting_approval` state is reserved,
not built). Each is a later-phase item, tracked in [03](./03-scope-and-phases.md).
