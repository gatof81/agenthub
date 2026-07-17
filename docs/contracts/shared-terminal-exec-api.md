# shared-terminal Exec API — tracking document

> **TRACKING** — the canonical contract now lives upstream:
> [`docs/EXEC_API.md` in shared-terminal](https://github.com/gatof81/shared-terminal/blob/main/docs/EXEC_API.md),
> implemented, deployed, and verified end-to-end (shared-terminal #381 →
> #385/#386/#387, verified here at `main @ b37dc4d`). This file records what
> the Hub *consumes*, the deltas between the accepted merged contract and the
> original proposal from [ADR-001](../adr/ADR-001-shared-terminal-exec-seam.md)
> (the proposal's full text lives in this file's git history), and the
> Hub-side implementation notes those deltas imply. On upstream changes to
> `EXEC_API.md`, this file is updated in the same PR that adapts the Hub.

## Surface consumed by the Hub

| Endpoint | Use |
| --- | --- |
| `POST /sessions/:id/exec` → NDJSON stream (`started` / `output` / `dropped` / `exit` / `error`, versioned `v:1`) | one call per run turn (FR-10) |
| `GET /sessions/:id/exec/:execId` → `running \| exited \| unknown` | boot reconciliation (FR-23, UC-06) |
| `POST /sessions/:id/exec/:execId/kill {graceMs}` → `already-exited \| terminated \| killed` | cancellation (FR-20, UC-04) |

Auth: existing JWT, session ownership enforced (Hub uses its dedicated
account; SEC-06 as amended by ADR-007 — see the correction note below).
`X-Request-Id` emitted on every response and echoed in `started` — recorded
per run (OPS-04).

> **Correction note (2026-07-17, ADR-007) — RESOLVED upstream same day:**
> ownership-only exec was the verified behavior at `0cd4ed5` and the blocker
> for the corrected model.
> [shared-terminal#416](https://github.com/gatof81/shared-terminal/issues/416)
> shipped at `63da9cf` (upstream PR #422), verified at `c2db7f7`: all three
> exec routes now authorize via `assertCanOperate` (owner OR admin,
> `routes/exec.ts:96,360,403`) — non-admin non-owners still 403 — and a
> cross-user exec skips the owner's idle bump and lands in the observe/audit
> trail. The Hub's admin-flagged execution identity can run structured turns
> in owner-account sessions with **no Hub-side code change**.

## Deltas: merged contract vs the ADR-001 proposal

| Topic | Proposal said | Merged contract says | Hub consequence |
| --- | --- | --- | --- |
| Status of an unknown `execId` | `404` | **`200 {state:"unknown"}`** — after a substrate restart, "registry lost" and "never existed" are indistinguishable, so 404 would lie. Kill keeps `404` for unknown ids; registry entries age out after 1 h | UC-06's `unknown` branch handles both cases; never treat `unknown` as "run never happened" |
| `maxDurationMs` omitted | unspecified | **defaults to the 1 h cap — an exec is always bounded** | Hub still always sends its own tighter per-run timeout (FR-17); the seam backstop is defense in depth |
| Pre-`started` output overflow | not covered | new **`dropped` event** (`{v:1, type:"dropped", scope:"pre-start", bytes}`), non-terminal: the 256 KiB pre-start hold buffer overflowed and `bytes` were discarded — signaled, not silent | Ingestion persists it (FR-16 covers it as a typed event); activity view can mark truncation |
| `env` limits | flat 32 KiB | **session-config rules**: name charset, ≤ 64 entries, ≤ 4096 B/value, ≤ 64 KiB total | Runner env (OAuth token + per-run vars) fits comfortably; validate Hub-side before dispatch to fail fast |
| Kill vs natural-exit race | not covered | **kill `outcome` is authoritative** over the stream's `reason` when they disagree | Never retry or re-classify a run based on `reason` alone; record both, trust `outcome` |
| Exit code of a killed exec | implied 128+signal | **raw signal number** (e.g. `15` = SIGTERM; `setsid -w` propagation, upstream #386) | Use `reason` as the primary classification signal; `exitCode` is diagnostic |
| Caller-supplied `X-Request-Id` | MAY be adopted | **ignored**; the response header is always the substrate's own id | One id to record, no ambiguity |
| Operational limits | suggested values | **4 concurrent execs/session · 120/min per IP (start+kill; status unlimited) · `graceMs` ≤ 30000** | FR-19 serializes runs per session anyway (1 ≪ 4); reconciliation polling uses status freely |

## Hub-side implementation notes (B2-01, `RealSubstrateExecPort`)

Recorded when the real port landed; verified against the exec route source
at shared-terminal `main @ 6291397` (`backend/src/routes/exec.ts`).

- **stdin delivery.** The seam has no stdin channel (the exec schema is
  `cmd`/`env`/`workingDir`/`maxDurationMs`; one-shot stdin is distinct from
  the contract's "interactive stdin/PTY" non-goal but equally absent), while
  ADR-003 requires prompts to reach the CLI via stdin. The port bridges the
  gap with an injection-safe wrapper:
  `["bash","-c",'printf %s "$1" | "${@:2}"',"hub_stdin",<payload>,<argv...>]`
  — the payload travels as its own argv element (positional parameter, never
  shell-interpreted) and reaches the real command's stdin through a pipe;
  the process group is still rooted at the seam's `setsid` leader, so kill
  semantics are unchanged. Consequence: **the stdin payload counts against
  the seam's 32 KiB `cmd` cap** — the port rejects larger requests Hub-side
  before dispatch. A one-shot `stdin` field upstream would remove the bound;
  worth proposing if real prompts ever approach it.
- **Kill on 404.** The wire keeps `404` for execIds the registry does not
  hold (aged out, lost to a restart, never existed); the port collapses it
  into the `already-exited` outcome — the same tolerant no-op the fake
  answers, so the orchestrator sees one semantics from both implementations.
- **Auth.** `POST /api/auth/login` with the Hub's dedicated account (Q-04;
  note the substrate mounts its whole router — auth included — under
  `/api`, verified at `index.ts` `app.use("/api", …)`);
  the JWT exists only in the httpOnly `st_token` Set-Cookie (never in the
  login body, never logged). Cached in memory, single-flight login, one
  re-login + retry on `401` — safe for the exec POST because a `401` is
  rejected before anything runs.
- **Validation before dispatch** (fail fast per the delta table): env name
  charset / ≤ 64 entries / ≤ 4096 B value / ≤ 64 KiB total, `cmd` ≤ 32 KiB,
  `maxDurationMs` within 1..3600000.
- **`exit.reason` is always present** — natural exits default to
  `"exited"` (`routes/exec.ts:255-256` at `6291397`:
  `reason = registry.reason ?? "exited"`), matching the contract's event
  table (`exited | killed | timeout`, no optional marker). The Hub's fake
  port mirrors this so real-vs-fake adapter streams stay byte-identical
  (B2-04).

### Session provisioning (B2-02, UC-01)

Surface consumed beyond the exec API (session routes verified at the same
`main @ 6291397`):

| Endpoint | Use |
| --- | --- |
| `GET /api/templates/:id` → `{ name, config }` | templates are client-side presets: the Hub materializes the config itself |
| `POST /api/sessions` `{ name, config }` → `201` + `bootstrapping?: true` | create with `config.agentSeed = { settings, claudeMd }` (seed fields override the template's per-field); **both fields are byte-capped strings** (≤ 256 KiB each, `AgentSeedSpec`) — `settings` is the *serialized JSON* that becomes the settings file, so the port stringifies it (live-E2E finding, 2026-07-15); `429` = user quota  **The Hub also sends `config.repo`** when the project declares one (ADR-006, FR-45): `{ url, ref?, target?, auth }`, overriding whatever the template clones — a template is a preset, not an authority. `auth` is `{kind:"none"}` or `{kind:"pat", pat}`; the seam encrypts it on receipt via `encryptAuthCredentials` (`sessionConfig.ts:1138`, verified at `main @ c35b6da`), which is what lets the Hub hold a write-capable credential without storing plaintext (SEC-11). It is folded in only at dispatch and never joins the stored `repo` shape |
| `GET /api/sessions/:id` → `{ status: running \| stopped \| terminated \| failed, runtimeReady: boolean \| null }` | bootstrap hard-fail detection (`failed` also kills the container upstream). **`runtimeReady`** (shipped by shared-terminal#399, verified at `main @ c35b6da`, `routes/sessions.ts:483-493`) reports whether the boot sentinel is present, i.e. `docker exec` can resolve the image's binaries. **`null` is not `false`**: it means the question was not answered — the session is not `running`, or the check itself threw. Treat `null` as unknown and keep waiting, never as a verdict |
| `GET /api/sessions/:id/bootstrap-log` → `{ log: string \| null }` | **bootstrap-completion signal**: upstream persists the log when the bootstrap runner finishes, success or failure — non-null ⇒ done. Chosen over the `/ws/bootstrap/:id` channel to avoid a WebSocket client dependency; `null` cannot mean "never ran" because a seeded create always bootstraps. **Not a runtime-readiness signal** — that is `runtimeReady` on `GET /api/sessions/:id`; see below |
| `POST /api/sessions/:id/stop` | archive path (FR-30); `404` tolerated (already gone) |
| `POST /api/sessions/:id/start` | restore path (FR-43). **All claims below verified at `main @ c35b6da`** ([`c35b6da`](https://github.com/gatof81/shared-terminal/commit/c35b6da) = shared-terminal#399, 2026-07-16 — `main` head at the time of writing). On a session with no live container it respawns from the stored config (`dockerManager.ts:1023` `loadConfigForSpawn` → `:1029` `spawnWithConfig`), and the workspace bind is derived from the **session id**, not the container — `${WORKSPACE_ROOT}/${sessionId}:/home/developer/workspace` (`dockerManager.ts:440`). That is why the files, and the CLI transcripts symlinked under them, come back: the workspace is a host directory that outlives any container. **`404` is NOT tolerated** — unlike `stop`, where "already gone" satisfies the intent, here it defeats it: the row is gone (`sessionManager.ts` `assertOwnership` throws `NotFoundError`), so the session was hard-deleted and took its workspace; the port raises `SessionGoneError` and the project stays archived (FR-44). `409` = the session `failed` during postCreate (recreate to retry) |

The bootstrap wait polls (default 1 s, 180 s cap) and surfaces failure as a
typed provisioning error carrying a tail-capped bootstrap log. Session
`name` is a substrate-side display value generated by the port
(`hub-<hex>`); the Hub tracks sessions by id only.

### Session discovery (N1, FR-48, ADR-007)

Surface consumed by `listSessions`/`getSession`, verified at
`main @ 0cd4ed5`:

| Endpoint | Use |
| --- | --- |
| `GET /api/admin/sessions` → array of serializeMeta rows + `userId`, `ownerUsername` (`routes/admin.ts:113-158`; `requireAdmin` → `403 {error:"Admin privileges required"}`, `auth.ts`) | preferred listing: the only one with per-row owner attribution (ADR-007). Hard cap 500 rows upstream (`ADMIN_LIST_LIMIT = 500`, `sessionManager.ts:179`, applied in `listAll`'s `LIMIT` at `sessionManager.ts:498`). `403` (no admin flag) degrades the port to the own listing with `scope:'own'` — surfaced, never silent |
| `GET /api/sessions` → array of serializeMeta rows (caller's own, terminated excluded; `routes/sessions.ts:440-489`) | degraded own-scope listing; rows attributed to the configured `selfUsername` since the wire carries no owner for the caller's own rows |
| `GET /api/sessions/:id` (operate-tier since upstream PR #412, `routes/sessions.ts:501`) | single-session metadata; `404` → `null` at the port (gone is a state to surface, FR-44, never repair) |
| `PATCH /api/sessions/:id` `{externalRef: string \| null}` (shared-terminal#418, verified at `c2db7f7`, `routes/sessions.ts:770-800`) | session ↔ project back-link (N2): the Hub writes `agenthub:project:<id>` at bind/provision, `null` clears. The route's ONLY patchable field — unknown keys 400; ≤128 chars (`EXTERNAL_REF_MAX_LEN`, `routes/sessions.ts:68`); operate-tier. `externalRef` also rides `POST /api/sessions` as a TOP-LEVEL create field (not `config`) and appears in `serializeMeta`, so every listing carries it |

The port drops `envVars` and container details at the boundary — session env
can carry secrets and the shape flows to the Hub API/UI (SEC-04/05).

### Runtime readiness (B3-08) — gap found here, closed upstream

**The seam has no way to say "this session can run a command yet."** Verified
at `main @ 3f1b9e7`:

- The session image keeps `claude` in `~/.npm-global/bin`, and the entrypoint
  **replaces that directory with a workspace symlink on every boot** so
  self-updates persist: `session-image/entrypoint.sh:130` (`mv` it aside) then
  `:133` (`ln -sfn`). Between those lines the directory does not exist and
  every PATH lookup of `claude` fails. On a first boot the preceding `cp -a`
  (`:102`) copies the whole CLI install into the bind mount, widening the
  window to seconds.
- Nothing synchronises that window with the session lifecycle:
  `backend/src/dockerManager.ts:531` `await container.start()` returns when
  Docker starts the process, not when the entrypoint finishes, and the
  entrypoint runs concurrently with everything after.
- So both Hub-visible signals above can be true — bootstrap log persisted,
  status not `failed` — while the runtime is still unusable. Observed as
  `claude: command not found` on a fresh session's first turn.

The entrypoint already knows when it is done (`:405` logs `container ready`)
but nothing exposed it — so the Hub did not trust the seam here:
`RuntimeAdapter.awaitReady` probes the runtime itself before a project is
marked ready (B3-08). The probe lives in the runtime adapter, not this port
— only the adapter knows what its runtime needs on PATH.

**CLOSED UPSTREAM 2026-07-16** (filed as shared-terminal#393, shipped as
shared-terminal#399 = `c35b6da`, deployed). The seam now answers the question directly:
`GET /api/sessions/:id` carries **`runtimeReady`** (`routes/sessions.ts:483-493`),
backed by a boot sentinel the entrypoint writes as its last step —
`dockerManager.ts:164` states the contract: its presence means `docker exec`
can resolve the image's binaries. Verified at `main @ c35b6da`.

The Hub still probes: the seam's answer and the adapter's question are not
the same one — `runtimeReady` says the entrypoint finished, the probe says
*this runtime's* binary resolves, which is what a turn actually needs. But
the probe can now start from the seam's signal instead of polling blind, and
a session that never reports ready can fail fast rather than at the deadline.
Tracked as a follow-up to B3-08; the probe is correct as-is meanwhile.

## Related upstream closures

- **Zombies (Q-08): resolved.** Upstream confirmed accumulation (3 permanent
  zombies per group kill, measured) and shipped `Init: true` (docker-init as
  PID 1, #387), pinned by smoke-test **Phase 9**. Containers created before
  the fix need one recycle (handled in the deployment).
- Per-user quotas (#202): `GET /quotas` lets the Hub's service account check
  headroom before creating sessions — input for doc 12/14.

## Non-goals (v1, unchanged)

Event replay/resume · stdin/PTY (the terminal WS remains the interactive
surface) · multi-replica exec registry.
