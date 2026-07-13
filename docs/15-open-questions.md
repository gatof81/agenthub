# 15 — Open Questions

**Status:** draft — decisions requested · **Last updated:** 2026-07-13

Classification: `MVP-blocking` (must close before the affected increment) ·
`important` (shapes design; close before doc 07) · `future` (later phase) ·
`UX` · `security` · `infra`. Where a provisional decision is stated, it proceeds
unless vetoed — except **Q-02, which requires explicit sign-off**.

| ID | Question | Class | Provisional decision |
| --- | --- | --- | --- |
| Q-01 | Runner process model | MVP-blocking | One `claude -p --resume` process per turn |
| Q-02 | Runner default permission posture | MVP-blocking · security | **None — sign-off required** |
| Q-03 | Turn semantics & queuing | MVP-blocking | 1 message = 1 run; queue during a run |
| Q-04 | Seam auth: service token vs user JWT | MVP-blocking · security | Resolve inside ADR-001; lean: dedicated service credential |
| Q-05 | Hub deployment & exposure | important · infra | Co-located with the substrate, seam over localhost |
| Q-06 | Frontend framework | UX · future | Decide at doc 11, not before |
| Q-07 | Hub users & auth model | important | Single-user first; don't preclude delegation to substrate auth |
| Q-08 | Zombie accumulation vs `PidsLimit` | infra · upstream | Verify upstream; propose smoke phase + `Init: true` if confirmed |
| Q-09 | Backend stack | important | TypeScript/Node |
| Q-10 | Claude auth inside the runtime | important · security | Decide before Increment 2 |

---

## Q-01 — Runner process model `MVP-blocking`

One `claude -p --resume <id>` process per turn, or a long-lived bidirectional
process per conversation?

**Provisional:** per-turn. Simpler lifecycle (spawn → stream → exit maps 1:1 to a
run), cancellation is just process-group kill, crash recovery is "no process, no
run", and continuity is the CLI's own `--resume` (substrate-guaranteed, see
[02 §1](./02-substrate-analysis.md)). Cost: per-turn startup latency — **S-01
measures it**; if it's multi-second, revisit.

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

**No provisional decision — this is a security posture call requiring explicit
owner sign-off.** Recommendation to consider: option 1 for the MVP with a
documented path to option 3; never option 2 while egress is open and secrets can
be present in workspaces.

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

**Provisional lean:** dedicated service credential mapped to a substrate account
owned by the Hub, with scoping stated as a contract requirement. Full analysis
and decision inside ADR-001 (it shapes the contract's auth section).

## Q-05 — Hub deployment `important` `infra`

Separate repos ≠ separate hosts. Co-locating the Hub on the substrate host and
talking over localhost avoids exposing the seam publicly and keeps latency nil.
How is the Hub's own UI exposed (same Cloudflare tunnel, new hostname)?
**Provisional:** co-located, seam on localhost; exposure decided with doc 12/14.
No real deployment identifiers in this repo (public-repo hygiene).

## Q-06 — Frontend framework `UX` `future`

Greenfield decision — shared-terminal's "no framework" rule does not apply here.
Deliberately **not decided now**; decided in the UX phase (doc 11) with actual
UI requirements on the table.

## Q-07 — Hub users & auth `important`

Own user model, or delegate to the substrate's (JWT, invites)? Single-user is
the reality for the foreseeable future. **Provisional:** design Phase 1 as
single-user with an auth boundary thin enough to swap; do not build a user
system. Interacts with Q-04 (if the Hub owns a substrate account, Hub users and
substrate users are decoupled anyway).

## Q-08 — Zombie accumulation vs `PidsLimit` `infra` `upstream`

Verified at `36be2f2`: container PID 1 is `tail -f /dev/null`
(`entrypoint.sh:410`), no `Init: true` in container create — PID 1 does not reap
orphans. If cancelled runs leave zombies, do they accumulate against
`PidsLimit: 1024` (`dockerManager.ts:444`) over a long-lived container?
`killExecProcessGroup` is zombie-aware for *liveness checks*, but reaping is the
parent's job; orphaned zombies re-parent to PID 1 and stay.

**Action:** verify upstream (S-01 can observe `/proc` after cancellations as a
side measurement). If confirmed, propose in the substrate repo: an extra
smoke-test phase + evaluate `Init: true`. Until then, treat as residual risk of
R-04.

## Q-09 — Backend stack `important`

**Provisional: TypeScript/Node.** Matches the substrate's ecosystem (shared
idioms, one toolchain), the CLI being orchestrated is itself Node, stream-json
parsing and WS/SSE plumbing are native strengths, and the team is one person —
ecosystem consistency compounds. Challenge window closes when doc 07 is written;
a challenger needs a concrete failing constraint (e.g. a measured need Node
can't meet), not taste.

## Q-10 — Claude auth inside the runtime `important` `security`

API key (`ANTHROPIC_API_KEY`, pay-as-you-go, headless-friendly, per-key spend
caps) vs OAuth/subscription state persisted under `.st/claude-state`
(subscription pricing, but browser-interactive setup and credentials-on-disk in
plaintext on the host). Interacts with R-06 (spend control) and the substrate's
plaintext-state constraint ([02 §4.1](./02-substrate-analysis.md)).
**Decide before Increment 2** (first real-Claude increment). S-01 runs on a
spend-capped API key regardless.
