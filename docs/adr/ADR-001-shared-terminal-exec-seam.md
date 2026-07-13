# ADR-001 — Integration seam with shared-terminal: exec over HTTP

Status: proposed
Date: 2026-07-13

Substrate evidence cited at [shared-terminal](https://github.com/gatof81/shared-terminal) `main` @ `36be2f2`.

## Context

The Hub's Phase-1 runner must, against a shared-terminal session: start a
process (Claude CLI headless), stream its output as it happens, know its exit
code, and cancel it mid-flight without collateral damage. The substrate has
exactly these primitives — but **in-process only**:

- `streamExec(sessionId, {cmd, env, workingDir, signal, newProcessGroup, onProcessGroup}, onOutput)`
  (`backend/src/dockerManager.ts:1140-1200`) — argv-array exec (no shell
  interpolation), chunk streaming, opt-in `setsid` process group with race-free
  pgid reporting.
- `killExecProcessGroup(sessionId, pgid, graceMs)` (`dockerManager.ts:1349+`) —
  TERM → poll → KILL, returns `already-exited | terminated | killed`, `pgid >= 2`
  hard-enforced.
- Critically, `streamExec`'s `signal` option only destroys the output stream —
  *"destroying the stream does NOT kill the in-container process — Docker has no
  'kill exec' API"* (comment at `dockerManager.ts:1143-1155`). Real cancellation
  is `killExecProcessGroup` or nothing.

No HTTP endpoint exposes any of this (`backend/src/routes/`: auth, sessions
lifecycle, templates, groups, invites, admin only — see
[02-substrate-analysis.md §2](../02-substrate-analysis.md)). The Hub and the
substrate are separate repos whose only allowed coupling is the public HTTP API,
so this ADR decides what contract to propose upstream — or whether the MVP can
avoid asking for anything.

## Options

### Option 0 — Ask for nothing new (rejected)

Could the MVP run on today's API alone? The only ways to make a session execute
anything today:

1. **Bootstrap hooks** (`postCreate`/`postStart`, `backend/src/bootstrap.ts`) —
   fire only at create/start, exactly-once semantics for postCreate; a chat turn
   would require a stop/start cycle per message. Not an execution API.
2. **The terminal WS relay** (`/ws/sessions/...`) — drive `claude -p` in a tmux
   pane and scrape the terminal. This is a *human* surface: TTY semantics,
   echo, wrapping and escape sequences interleaved with the CLI's stream-json;
   no structured exit code; "cancellation" is synthesizing Ctrl-C keystrokes
   with none of `killExecProcessGroup`'s guarantees; and it occupies the very
   terminal the user is supposed to share with the agent (risk R-11). Fragile
   at every layer we care about.

Neither yields structured streaming, exit codes, or race-free cancellation.
Rejected on evidence, not taste.

### Option A — WebSocket endpoint (rejected)

A `/ws/exec/:sessionId` channel, following the existing `/ws/bootstrap/<id>`
house pattern. Bidirectional, so cancel could ride in-band.

- WS upgrades bypass the Express middleware chain entirely; the substrate
  carries dedicated CSWSH defence and a per-IP upgrade rate limiter for exactly
  this reason (`backend/src/index.ts:157-208`). A new WS surface re-walks that
  minefield for no benefit: the seam is machine-to-machine, likely localhost.
- In-band cancel is an anti-feature here: cancellation is an authoritative
  action with its own auth check and its own result
  (`already-exited|terminated|killed`) — it wants to be a request/response, not
  a frame in a stream (backend-as-authority principle).
- Correlation, auth, and rate limiting all come free on plain HTTP routes and
  are all custom on upgrade paths.

### Option B — Server-Sent Events (rejected)

SSE gives native auto-reconnect and `Last-Event-ID`.

- Those strengths target *browsers*; the consumer is the Hub backend, which
  gets nothing from `EventSource` it can't do with a fetch body stream.
- SSE framing (`event:`/`data:` lines, comment heartbeats) wraps what is
  already going to be JSON-per-line — ceremony without information.
- Cancel still needs a separate endpoint (SSE is one-way), so SSE's only
  differentiator over NDJSON is a reconnect protocol we deliberately do not
  need at the seam (see Reconnection below).

### Option C — NDJSON over chunked HTTP + explicit kill endpoint (chosen)

`POST /sessions/:id/exec` returns a chunked response streaming one JSON event
per line; a separate `POST .../exec/:execId/kill` maps 1:1 to
`killExecProcessGroup`; a `GET .../exec/:execId` reports status for recovery.

- Flows through the normal middleware chain: existing auth, rate limiting, and
  `requestId` context (`backend/src/requestContext.ts`) apply unmodified.
- Backpressure is TCP + Node stream flow control (pause the Docker stream when
  `res.write()` returns false) — no bespoke protocol.
- The kill endpoint surfaces the substrate's own cancellation semantics
  (`graceMs`, three outcomes) instead of hiding them behind stream teardown —
  which, per the `signal` comment above, would *not* kill the process.
- Maps 1:1 onto primitives the substrate already tests (smoke-test Phase 6).

## Decision

**Option C.** The full contract — paths, payloads, event schema, error
semantics — is drafted as a PROPOSAL in
[contracts/shared-terminal-exec-api.md](../contracts/shared-terminal-exec-api.md),
to be taken to the shared-terminal repo and implemented through its process.

Key decisions embedded in the contract, and their reversibility:

| Decision | Rationale | Reversible? |
|---|---|---|
| NDJSON transport | Above | Yes — the Hub isolates the seam behind a `SubstrateExecPort`; swapping transport touches one adapter |
| **No event replay at the seam (v1)** | If the stream drops, conversation state is safe regardless: the CLI's own transcript under `workspace/.st/claude-state` is the source of truth for continuity, and the next turn `--resume`s it. The Hub reconciles via `GET exec status` + `kill`, marks the run interrupted, and moves on. A replay buffer buys only activity-log completeness for a rare window, at the cost of server-side state and a resume protocol | Yes — additive (`?after=seq` + ring buffer) if the gap hurts in practice |
| **Auth: dedicated substrate account for the Hub** (existing `/auth/login`, JWT like any client) | Resolves Q-04 without new upstream auth surface. Scoping falls out of ownership: the Hub account only ever owns Hub-created sessions, so its blast radius is exactly those sessions. Doesn't die with a browser cookie; the Hub re-authenticates on expiry | Yes — a bearer/service-token scheme can replace it later without contract shape changes |
| **`X-Request-Id` emission required** | Correlation across the seam. The id already exists per-request via AsyncLocalStorage; non-emission is an acknowledged follow-up (*"No public header emission (X-Request-Id) — the id is log-internal"*, `requestContext.ts:29`) | Additive |
| Event schema versioned by `v` field + contract doc | Two repos, one owner; a version negotiation protocol would be over-architecture (R-10). The pinned CLI (2.1.207) already forces coordinated bumps | Yes |
| Separate `stdout`/`stderr` in events | Docker's multiplexed exec frames carry the distinction on the wire (`Tty:false`, `dockerManager.ts:1196-1200`); the CLI's stream-json rides stdout, diagnostics ride stderr — merging them would force the Hub to parse them apart heuristically | Schema-level; hard to change later, so decided now |

## Consequences

- **Upstream dependency created** (risk R-08): the contract must be accepted and
  implemented in shared-terminal. Mitigation stands: Increment 1 runs against a
  fake `SubstrateExecPort` adapter; the proposal goes upstream now so review
  overlaps Hub doc work.
- The Hub owns run-event persistence and recovery policy; the substrate stays a
  generic exec surface with no knowledge of runs, agents, or conversations —
  the seam stays product-agnostic, which is what keeps it proposable upstream.
- Q-04 closes (provisionally) as "dedicated machine account"; revisit only if
  the substrate grows first-class service tokens.
- `GET exec status` requires the substrate to keep a small in-memory exec
  registry (execId → pgid/state). Process-local is fine — single replica is its
  documented deployment shape; the *contract* stays replica-agnostic (ids, no
  sticky-connection assumptions) per R-13.
- Cancellation UX in the Hub inherits the substrate's `graceMs` window: a
  cancelled run may take up to grace + poll time to report `killed`.
- Open question Q-08 (zombie accumulation) is unaffected by transport choice
  but stays attached to this seam's usage pattern (many short execs per
  container lifetime); S-01 observes it.
