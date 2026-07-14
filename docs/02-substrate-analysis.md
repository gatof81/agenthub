# 02 — Substrate Analysis: shared-terminal

**Status:** draft — review · **Last updated:** 2026-07-13
**Verified against:** [gatof81/shared-terminal](https://github.com/gatof81/shared-terminal) `main` @ `36be2f2`.
Every claim below cites a file (and line where useful) at that commit. Re-verify after the substrate moves.

## 1. What shared-terminal provides

A session is a Docker container (Ubuntu 24.04 + Node 22 + tmux + Claude Code CLI)
whose workspace is a host bind mount — the only thing that survives container
recreation.

| Fact | Evidence @ `36be2f2` |
| --- | --- |
| Claude Code CLI pinned to **2.1.207**; bumps re-trigger the smoke test | `session-image/Dockerfile:273` (`ARG CLAUDE_CODE_VERSION=2.1.207`) |
| Workspace bind mount at `WORKSPACE_ROOT/<sessionId>` | `backend/src/dockerManager.ts:33,345` |
| Shared Docker network `sessions-net`, single-tenant assumption | `backend/src/dockerManager.ts:40`; upstream #291 |
| Resource limits per container: `Memory`, `NanoCpus`, `PidsLimit: 1024` | `backend/src/dockerManager.ts:430-444` |
| Container PID 1 is `tail -f /dev/null`; **no `Init: true`** in container create | `session-image/entrypoint.sh:410`; no `Init` key in `dockerManager.ts` create config |
| Async bootstrap on create: git identity → clone → dotfiles → agentSeed → postCreate (exactly-once via D1 `bootstrapped_at` gate); postStart on every start; streamed over `/ws/bootstrap/<id>` | `backend/src/bootstrap.ts` header + imports; `backend/src/bootstrap/agentSeed.ts` |
| CI builds the session image and runs an 8-phase Docker smoke test, standalone on any Docker host | `session-image/smoke-test.sh:88-254` (phases 1–8) |

### Claude CLI state survives container recreate (#371/#378)

The entrypoint symlinks `~/.claude` → `workspace/.st/claude-state` and
`~/.claude.json` → `workspace/.st/claude.json` (`session-image/entrypoint.sh:328-334`).
The `~/.claude.json` link is a **file symlink** — an empirical per-CLI-version
invariant, re-asserted by smoke-test Phase 4 on every version bump. `.st/` is
auto-gitignored, so `git add -A` in the workspace cannot commit credentials or
transcripts. `--resume` / `--continue` are verified end-to-end after kill +
recreate (smoke-test Phase 5), and a project-level `.claude/` in the workspace
coexists without collision (Phase 7).

**Consequence for the Hub:** conversation continuity across recreates is a solved,
CI-guarded substrate property. The Hub does not need to re-solve it — it needs to
not break it.

### Orchestration primitives (#373/#375) — internal only

`backend/src/dockerManager.ts`:

- `streamExec(sessionId, { cmd, newProcessGroup, onProcessGroup, env, workingDir, signal, … })`
  (`dockerManager.ts:1154-1269`): with `newProcessGroup` the command runs under
  `setsid`; the pgid arrives race-free via a sentinel line intercepted in the
  output stream (`:1230-1269`).
- `killExecProcessGroup(sessionId, pgid, graceMs)` (`dockerManager.ts:1349+`):
  SIGTERM the group → poll up to `graceMs` → SIGKILL survivors; returns
  `already-exited | terminated | killed`; zombie-aware liveness; `pgid >= 2`
  hard-enforced (a pgid of 1 would become `kill -- -1` and take down PID 1 —
  the comment at `:1363-1369` calls this out as load-bearing).
- Everything is additive: tmux and other execs survive a kill (smoke-test Phase 6).

## 2. Public API surface today

Route modules at `backend/src/routes/`: `auth.ts`, `sessions.ts`, `templates.ts`,
`groups.ts`, `invites.ts`, `admin.ts`. Auth is a JWT cookie (`backend/src/auth.ts`).

| Area | Endpoints (HTTP) |
| --- | --- |
| Auth | `POST /auth/login`, `/auth/logout`, `/auth/register`, `GET /auth/status` |
| Sessions | `GET/POST /sessions`, `GET/PATCH/DELETE /sessions/:id`, `POST /sessions/:id/start`, `POST /sessions/:id/stop`, `GET /sessions/:id/env`, `GET/PATCH /sessions/:id/ports`, `GET/POST /sessions/:id/tabs`, `PATCH/DELETE /sessions/:id/tabs/:tabId`, `GET /sessions/:id/bootstrap-log`, `GET /sessions/:id/observe-log` |
| Templates | `GET/POST /templates`, `GET/PATCH/DELETE /templates/:id` |
| Other | `/groups*`, `/invites*`, `/admin/*`, `GET /health` |
| WebSocket | `/ws/sessions/…` (terminal relay), `/ws/bootstrap/<id>` (bootstrap stream) |
| Port proxy | `p<port>-<sessionId>.<domain>`, private (cookie) or public (webhook), live-editable via `PATCH /sessions/:id/ports` |

## 3. What the Hub needs vs what exists

| Hub need (Phase 1) | Available via public API? |
| --- | --- |
| Create a session from a template; start/stop it | **Yes** — `/templates`, `/sessions`, `/sessions/:id/start\|stop` |
| Persistent workspace + Claude state continuity | **Yes** — substrate property (§1) |
| Seed agent config into the session (settings, CLAUDE.md) | **Yes** — agentSeed during bootstrap (create-time only) |
| Manual terminal access next to the chat | **Yes** — existing frontend / WS relay |
| **Execute a command in a session with streaming output and cancellation** | **No.** `streamExec` / `killExecProcessGroup` are in-process functions of the substrate backend; no HTTP endpoint exposes them. **This is the critical gap → ADR-001.** |
| Correlation across the seam | **Partial.** `requestId` (16-hex) exists per HTTP request and WS upgrade via AsyncLocalStorage, but is deliberately log-internal: *"No public header emission (X-Request-Id)"* (`backend/src/requestContext.ts:29`). Emitting it is a stated follow-up — the ADR-001 contract should require it. |
| Event replay / reconnection semantics for exec streams | **No** — to be defined in the ADR-001 contract. |

## 4. Constraints to design around

1. **Plaintext sensitive state on the host.** Transcripts and OAuth credentials
   live unencrypted under `workspace/.st/claude-state`, and survive soft delete
   (only `?hard=true` purges). Threat-model input, not a bug to fix here.
2. **Single backend replica.** Broadcasters and the idle sweeper are
   process-local by documented design. Hub-side contracts must stay
   replica-agnostic (ids + resumable streams), even if implementations are
   in-process.
3. **D1 is remote.** Every substrate DB query is an HTTP round-trip; hot paths
   keep query counts low. The Hub must not add chatty seam calls that fan out
   into D1 round-trips.
4. **Session config is bound at create** (exceptions: resources, ports).
   Agent-per-session seeding happens at bootstrap; changing an agent's seeded
   config implies recreate or an in-session mechanism (Hub design decision).
5. **Single-tenant network assumption** (`sessions-net`, #291). The Hub inherits
   it; nothing in Phase 1 may silently assume otherwise.
6. **CLI self-updates float.** The image pins 2.1.207, but the CLI can
   self-update into the workspace-persisted `.npm-global`, so the *effective*
   version per session can drift. The Hub runner must record the CLI version per
   run (risk R-02 in [16-risk-register.md](./16-risk-register.md)).
7. **PID 1 does not reap.** PID 1 is `tail -f /dev/null`
   (`session-image/entrypoint.sh:410`) and the container is created without
   `Init: true`. Whether zombies from cancelled runs accumulate against
   `PidsLimit: 1024` over a container's lifetime is an open upstream
   verification (Q-08 in [15-open-questions.md](./15-open-questions.md)).

## 5. Conclusion

The substrate covers session lifecycle, workspace persistence, Claude state
continuity, and safe in-process exec orchestration. The single missing piece for
the Hub's Phase 1 is **an HTTP contract over `streamExec`/`killExecProcessGroup`**
(streaming, cancellation, reconnection, correlation, versioning) — designed in
ADR-001 as a proposal to take upstream. Until that lands upstream, Hub development
proceeds against a fake substrate adapter (risk R-08).

## 6. Addendum — substrate updates since `36be2f2` (verified at `b37dc4d`, 2026-07-14)

The §5 gap is now closed upstream. Verified against `main @ b37dc4d`:

| Change | Evidence | Effect here |
| --- | --- | --- |
| **Exec API implemented and deployed** (#381 → #385): the three endpoints of ADR-001, canonical contract at `docs/EXEC_API.md` | `git log` #385; verified end-to-end by upstream | §3's critical gap closed; R-08 closed; [contracts/shared-terminal-exec-api.md](./contracts/shared-terminal-exec-api.md) now **tracks** the canonical doc and records the accepted deltas |
| `setsid -w` exit-code propagation for `newProcessGroup` execs | #386 | killed execs report the raw signal number; `reason` is the primary classifier |
| **`Init: true` on container create** — docker-init reaps zombies; smoke-test **Phase 9** pins it | #387; `dockerManager.ts` (`Init: true`), `smoke-test.sh` Phase 9 | §4 constraint 7 and Q-08 resolved; pre-fix containers recycle once |
| `X-Request-Id` emitted on exec-API responses, echoed in `started` | `EXEC_API.md` §Correlation | §3's correlation gap closed for the exec surface |
| Per-session resource caps enforced + **per-user quotas** (#202) with `GET /quotas` | #388/#389; `routes/sessions.ts` (`GET /quotas`) | Hub's service account can check headroom before creating sessions (input for docs 12/14) |
| **Backup/restore for the substrate itself** (#240 → #390): `npm run backup`/`restore`, deterministic per-table dumps + workspace tarballs, encryption-key guard; first production backup verified 2026-07-14 | upstream #390, `docs/DEPLOYMENT.md` there | Substrate data (sessions, workspaces incl. `.st/claude-state`) has an operated recovery story. The Hub's own SQLite backup (R-16, OPS-01..03) remains the Hub's job — the two pipelines are independent by design (separate repos, separate data) |

Facts elsewhere in this document remain cited at `36be2f2`; re-verification
happens per claim as later docs consume them.
