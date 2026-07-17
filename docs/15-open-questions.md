# 15 — Open Questions

**Status:** approved (owner, 2026-07-15) · **Last updated:** 2026-07-14

Classification: `MVP-blocking` (must close before the affected increment) ·
`important` (shapes design; close before doc 07) · `future` (later phase) ·
`UX` · `security` · `infra`. Where a provisional decision is stated, it
proceeds unless vetoed.

| ID | Question | Class | Decision state |
| --- | --- | --- | --- |
| Q-01 | Runner process model | MVP-blocking | **Resolved (S-01, 2026-07-14): per-turn validated** — ~0.6 s to first event, stable session id across resumes |
| Q-02 | Runner default permission posture | MVP-blocking · security | **Resolved (owner sign-off 2026-07-14): curated allowlist** |
| Q-03 | Turn semantics & queuing | MVP-blocking | 1 message = 1 run; queue during a run |
| Q-04 | Seam auth: service token vs user JWT | MVP-blocking · security | Resolved by ADR-007 (supersedes ADR-001's provisional): owner-owned sessions, dedicated account as audited execution identity |
| Q-05 | Hub deployment & exposure | important · infra | **Resolved (owner, 2026-07-14): shared-terminal shape — see ADR-002** |
| Q-06 | Frontend framework | UX | **Resolved (owner, 2026-07-14): React + Vite** (Angular considered) — see doc 11 §1; served same-origin by the backend (ADR-002, amended 2026-07-17 from Cloudflare Pages) |
| Q-07 | Hub users & auth model | important | Single-user first; don't preclude delegation to substrate auth |
| Q-08 | Zombie accumulation vs `PidsLimit` | infra · upstream | **RESOLVED upstream (2026-07-14)**: `Init: true` shipped (shared-terminal#387), smoke Phase 9 pins it |
| Q-09 | Backend stack | important | **Resolved with doc 07 (2026-07-14): TypeScript/Node** — challenge window closed, no failing constraint produced |
| Q-10 | Claude auth inside the runtime | important · security | **Resolved (owner + S-01, 2026-07-14): subscription OAuth** — works headless via env var, cost fields populated |
| Q-11 | Intra-project run concurrency | important · UX | Provisional: serialized — one active run per project (ADR-005 trade-off); revisit only if it hurts in practice |

---

## Q-01 — Runner process model `MVP-blocking`

One `claude -p --resume <id>` process per turn, or a long-lived bidirectional
process per conversation?

**Provisional:** per-turn. Simpler lifecycle (spawn → stream → exit maps 1:1 to a
run), cancellation is just process-group kill, crash recovery is "no process, no
run", and continuity is the CLI's own `--resume` (substrate-guaranteed, see
[02 §1](./02-substrate-analysis.md)). Cost: per-turn startup latency — **S-01
measured it (2026-07-14): ~570–580 ms to first event, 3.7–4.5 s total for a
trivial turn (n=3), session id stable across resumes** —
[S-01 results](./spikes/S-01/RESULTS.md). **Resolved: per-turn.**

## Q-02 — Runner default permission posture `MVP-blocking` `security`

Headless runs freeze forever on the first tool prompt without explicit permission
flags (risk R-03; S-01 confirms). Something must be passed. Options:

1. **Curated `--allowedTools` allowlist** (e.g. read/edit/bash-subset), deny the
   rest. Safer against prompt injection (R-05); may abort mid-task on a
   disallowed tool.
2. **Full bypass** (`--dangerously-skip-permissions` or equivalent) inside the
   container sandbox. Maximum capability; but the sandbox has open egress and
   the workspace can hold PATs/.env — the container boundary is **not** a
   data-exfiltration boundary.
3. Curated allowlist per **autonomy level** (the product's own levels 0–3 mapped
   to flag sets) — the eventual end state; more design surface up front.

**Resolved (owner sign-off 2026-07-14): option 1 — curated `--allowedTools`
allowlist for the MVP**, with the documented path to option 3 (autonomy-level
flag sets) at doc-07 time. Option 2 stays off the table while egress is open
and workspaces can hold secrets. The concrete allowlist contents are a doc-08
deliverable, informed by S-01's `tool_use` corpus.

## Q-03 — Turn semantics `MVP-blocking`

**Provisional:** 1 message = 1 run. Messages arriving during an active run are
queued and dispatched sequentially after it finishes (no interleaving, no
mid-run injection in Phase 1). Cancellation cancels the active run; the queue
survives. UX for "queued" state lands in doc 11.

## Q-04 — Seam authentication `MVP-blocking` `security`

Does the Hub call shared-terminal with its own service credential or with the
user's JWT?

- **Service token:** clean machine-to-machine semantics; blast radius = whatever
  the token can touch, so it needs scoping (ideally: only sessions it created,
  or a dedicated substrate user). Survives user session expiry — background runs
  don't die at cookie expiry.
- **User JWT:** free scoping (user's own sessions) and audit attribution; but
  the Hub must store/refresh a browser-oriented credential, runs outlive
  cookies, and a Hub compromise leaks a full user credential.

**Provisionally resolved by [ADR-001](./adr/ADR-001-shared-terminal-exec-seam.md):**
the Hub authenticates as a **dedicated substrate account** via the existing
`/auth/login` (JWT like any client) and only ever owns Hub-created sessions —
scoping falls out of ownership, no new upstream auth surface. Revisit only if
the substrate grows first-class service tokens.

**Superseded by [ADR-007](./adr/ADR-007-session-ownership-and-binding.md)
(owner, 2026-07-17):** sessions belong to the **owner's admin account**; the
dedicated account remains only as an admin-flagged **execution identity**
operating them through the substrate's audited operate tier (the upstream
asks are shared-terminal #416/#418/#419/#420). The service-token revisit clause
stands — scoped tokens are the recorded future narrowing of the admin flag.

## Q-05 — Hub deployment `important` `infra`

Separate repos ≠ separate hosts. Co-locating the Hub on the substrate host and
talking over localhost avoids exposing the seam publicly and keeps latency nil.
**Resolved (owner, 2026-07-14), recorded in
[ADR-002](./adr/ADR-002-hub-persistence.md):** the Hub mirrors
shared-terminal's topology — long-lived Node backend co-located on the
substrate host behind the Cloudflare tunnel, the backend serving the SPA
same-origin (Cloudflare Pages was the original placement, amended 2026-07-17 —
see ADR-002 Consequences), seam over localhost, SQLite local + R2 backups for
persistence (ADR-002 final after the S-03 gate fired on D1 latency). A Workers-based backend was
considered and set aside (long-lived streams + process state would demand
Durable Objects and a public seam). Hostname/exposure details stay out of this
repo (public-repo hygiene, R-09).

## Q-06 — Frontend framework `UX` `future`

Greenfield decision — shared-terminal's "no framework" rule does not apply here.
**Resolved (owner, 2026-07-14): React + Vite**, built static and served
same-origin by the backend (Cloudflare Pages originally, amended 2026-07-17 —
[ADR-002](./adr/ADR-002-hub-persistence.md) Consequences). Rationale
and the considered alternatives (Angular latest, SvelteKit, SolidJS, vanilla)
are in [11-ux-specification.md §1](./11-ux-specification.md): the Mac
productivity surface (command palette, resizable panels, inspector, drag &
drop) maps 1:1 onto mature React libraries, and React has the strongest
AI-assisted-development support — decisive since implementation is delegated.

## Q-07 — Hub users & auth `important`

Own user model, or delegate to the substrate's (JWT, invites)? Single-user is
the reality for the foreseeable future. **Provisional:** design Phase 1 as
single-user with an auth boundary thin enough to swap; do not build a user
system. Interacts with Q-04 (if the Hub owns a substrate account, Hub users and
substrate users are decoupled anyway).

**Resolved for browser auth by [ADR-011](./adr/ADR-011-browser-auth-cloudflare-access.md)
(owner, 2026-07-17):** public exposure at `<hub-hostname>` made the thin
boundary real. The backend verifies the signed Cloudflare Access JWT
(`Cf-Access-Jwt-Assertion` — aud + iss + JWKS signature + expiry) for browser
traffic and retains the bearer token for localhost/programmatic; Access owns
the allow policy, so the Hub stays single-user without its own user store. A
full Hub-owned login remains future work (ADR-011 Option 4).

## Q-08 — Zombie accumulation vs `PidsLimit` `infra` `upstream`

Verified at `36be2f2`: container PID 1 is `tail -f /dev/null`
(`entrypoint.sh:410`), no `Init: true` in container create — PID 1 does not reap
orphans. If cancelled runs leave zombies, do they accumulate against
`PidsLimit: 1024` (`dockerManager.ts:444`) over a long-lived container?
`killExecProcessGroup` is zombie-aware for *liveness checks*, but reaping is the
parent's job; orphaned zombies re-parent to PID 1 and stay.

**Confirmed by S-01 (2026-07-14)** — each group-killed run left exactly one
unreaped `claude` zombie under PID 1 (evidence:
[S-01 results](./spikes/S-01/RESULTS.md)) — and **RESOLVED upstream the same
day**: shared-terminal confirmed the accumulation independently (3 permanent
zombies per group kill in its test workload — the counts differ from S-01's
"1 per kill" because each measured a different process tree: S-01's probe
left only the `claude` process unreaped, upstream's test counted every
zombie descendant; both observed the same phenomenon, and `Init: true`
moots the number) and shipped `Init: true` (docker-init as PID 1,
[#387](https://github.com/gatof81/shared-terminal/pull/387)), pinned by its
smoke-test Phase 9. Deployed; pre-fix containers recycle once. Consequence:
FR-22 (the Hub-side cancel-count guard) retired before ever being built —
see [04 §2](./04-requirements.md).

## Q-09 — Backend stack `important`

**Resolved (doc 07, 2026-07-14): TypeScript/Node.** Matches the substrate's
ecosystem (shared idioms, one toolchain), the CLI being orchestrated is
itself Node, stream-json parsing and SSE plumbing are native strengths, and
the team is one person — ecosystem consistency compounds. The challenge
window closed with [07-architecture.md](./07-architecture.md); no challenger
produced a concrete failing constraint.

## Q-10 — Claude auth inside the runtime `important` `security`

API key (`ANTHROPIC_API_KEY`, pay-as-you-go, headless-friendly, per-key spend
caps) vs OAuth/subscription state persisted under `.st/claude-state`
(subscription pricing, but browser-interactive setup and credentials-on-disk in
plaintext on the host). Interacts with R-06 (spend control) and the substrate's
plaintext-state constraint ([02 §4](./02-substrate-analysis.md), constraint 1).
**Resolved (owner directive + S-01 validation, 2026-07-14): subscription
OAuth.** S-01 ran headless with `CLAUDE_CODE_OAUTH_TOKEN` as a plain env var:
no onboarding blocker on a fresh state dir, and result events still populate
`total_cost_usd`/`usage` (notional dollars), so `UsageRecord` (A3) works
unchanged. Residuals: the token is a credential in container env (threat-model
input for doc 10); spend control is subscription rate limits, not per-key
caps, so R-06's per-run caps carry the load; killed runs emit no result event
→ their usage is recorded as unknown ([S-01 results](./spikes/S-01/RESULTS.md)).

## Q-11 — Intra-project run concurrency `important` `UX`

With Projects as the aggregate (ADR-005), all of a project's conversations
share one workspace — so runs serialize per project (FR-19, I-2), and two
conversations of the same project cannot execute simultaneously. For a single
user this is the correct semantics (it is what makes R-11's races
impossible), and the queue keeps the UX honest (UX-03). **Provisional:
accept serialization.** Revisit only with concrete pain — the escape hatches
(secondary sessions per project, or per-conversation worktrees) are known but
are Phase-2+ material, not MVP.
