# 09 — Persistence (Phase 1)

**Status:** approved (owner, 2026-07-15) · **Last updated:** 2026-07-14

The concrete storage design behind [ADR-002](./adr/ADR-002-hub-persistence.md)
(SQLite local + R2 snapshots): schema, invariant enforcement, transactions,
migrations, and the backup/restore procedure. Entities and invariants from
[06](./06-domain-model.md); payload rules from [08 §2](./08-api-and-event-contracts.md).

## 1. Engine configuration

`better-sqlite3` (synchronous API suits the single-process orchestrator;
transactions without callback plumbing), one database file on local disk
outside `WORKSPACE_ROOT` (OPS-05):

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;      -- fsync at checkpoints; NFR-01 latency
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

`synchronous = NORMAL` under WAL risks at most the last transactions on OS
crash — bounded, and R2 snapshots (plus the CLI's own transcripts for
conversation continuity, FR-24) cover the tail. Accepted trade-off.

## 2. Schema (DDL)

```sql
CREATE TABLE projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('provisioning','ready','error','archived')),
  default_agent_id   TEXT NOT NULL,
  instructions       TEXT,                        -- seeded via agentSeed (FR-41); sensitive → never logged
  session_id         TEXT,                        -- SessionBinding (ADR-005: one workspace per project)
  session_template_id TEXT,
  session_last_state TEXT,                        -- UX cache only (06 §2)
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE conversations (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),  -- immutable (I-10)
  title              TEXT NOT NULL,
  agent_id           TEXT NOT NULL,               -- immutable (I-6): no UPDATE path exposed
  status             TEXT NOT NULL CHECK (status IN ('active','archived')),
  runtime_session_id TEXT,                        -- --resume handle (FR-24), per conversation
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_conversations_project ON conversations (project_id, updated_at);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  run_id          TEXT,                           -- nullable; set for both roles in the normal flow (06 §2).
                                                  -- Deliberately NO FK: circular with runs.message_id (the user
                                                  -- message inserts before its run row); integrity enforced by
                                                  -- the HubStore send-message transaction (§3)
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_messages_conv ON messages (conversation_id, created_at);

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  message_id      TEXT NOT NULL UNIQUE REFERENCES messages(id),  -- I-1
  state           TEXT NOT NULL CHECK (state IN
    ('queued','starting','streaming','completed','completed_with_denials',
     'cancelled','interrupted','failed')),
  exec_id         TEXT,                           -- NULL through queued/starting (06)
  pgid            INTEGER,
  seam_request_id TEXT,                           -- X-Request-Id join (OPS-04)
  caps_snapshot   TEXT NOT NULL,                  -- JSON; written at creation (I-8)
  policy_snapshot TEXT NOT NULL CHECK (length(policy_snapshot) > 2),  -- I-7: non-empty JSON array
  cli_version     TEXT,                           -- write-once at init event (I-8)
  model           TEXT,
  kill_outcome    TEXT,
  sweep_result    TEXT,                           -- JSON (FR-21)
  error_code      TEXT,                           -- 08 §6 taxonomy
  error_detail    TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  ended_at        TEXT
);
CREATE INDEX idx_runs_conv ON runs (conversation_id, created_at);
CREATE INDEX idx_runs_active ON runs (state)
  WHERE state IN ('queued','starting','streaming');   -- reconciler + queue rebuild

CREATE TABLE run_events (
  id       TEXT PRIMARY KEY,                      -- idempotency key (I-4)
  run_id   TEXT NOT NULL REFERENCES runs(id),
  seq      INTEGER NOT NULL,
  type     TEXT NOT NULL CHECK (type IN
    ('started','output','tool_use','permission_denial','exit','error','unknown')),
  payload  TEXT NOT NULL,                         -- JSON, ≤ 64 KiB post-truncation (08 §2)
  ts       TEXT NOT NULL,
  UNIQUE (run_id, seq)                            -- I-4 ordering
);

CREATE TABLE usage_records (
  run_id         TEXT PRIMARY KEY REFERENCES runs(id),   -- 1:1 (I-5)
  total_cost_usd REAL,
  num_turns      INTEGER,
  usage          TEXT,                            -- JSON
  source         TEXT NOT NULL CHECK (source IN ('result-event','cancelled-unknown','error-partial'))
);

CREATE TABLE sse_cursor (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  next_seq        INTEGER NOT NULL                -- Last-Event-ID ordering (ADR-004).
  -- Replay scope: only run_events-derived SSE events (message.delta,
  -- activity.item) participate in Last-Event-ID replay — they are
  -- reconstructible from run_events rows. State/summary events (run.state,
  -- project.state, run.usage, run.summary) are NOT replayed: on reconnect
  -- the client re-reads current state via GET /api/runs/:id,
  -- GET /api/conversations/:id and GET /api/projects/:id (the doc 08 §3
  -- fallback). next_seq tracks the replayable subset.
);

CREATE TABLE run_summaries (
  run_id   TEXT PRIMARY KEY REFERENCES runs(id),  -- 1:1 with terminal runs (I-11)
  summary  TEXT NOT NULL                          -- JSON (06 §RunSummary shape, FR-42)
);

CREATE TABLE meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL );  -- schema_version, etc.
```

Invariants not expressible as constraints (I-2 single active run per project, I-3 legal
transitions, write-once `cli_version`) are enforced in the `HubStore`
transaction layer: state changes use `UPDATE runs SET state=? WHERE id=? AND
state=?` and assert exactly one changed row — the substrate's own
`d1Query`-era discipline, kept because it makes illegal transitions loud.

## 3. Transactions

| Operation | One transaction containing |
| --- | --- |
| Send message (UC-02) | insert user message + insert run(`queued`) |
| Dispatch | run `queued→starting` (guarded UPDATE) |
| Event ingestion | batch of `INSERT OR IGNORE` run_events + sse_cursor bump — batched per stream flush, not per event |
| Terminal transition | run state + assistant message upsert + usage_record insert + run_summaries insert (I-11) |
| Reconcile (UC-06) | **two transactions per run** (a network probe sits between them): (1) stage to `interrupted`; (2) resolve after the seam status probe. A crash between the two leaves the run in `interrupted` — the next boot's reconciler picks those up directly at step 2 |

All writes go through `HubStore`; the in-memory fake implements the same
interface with the same guarded-update semantics (NFR-03) so tests exercise
identical failure modes.

## 4. Migrations

Numbered forward-only SQL files (`001_init.sql`, …) applied at boot inside a
transaction; `meta.schema_version` gates each. No down-migrations (restore
from snapshot is the rollback story). A failed migration aborts startup —
never a half-migrated serving process.

## 5. Backup & restore (OPS-01..03, R-16)

**Snapshot:** on interval (default 6 h) and on clean shutdown:

1. `VACUUM INTO '<tmp>/hub-<utc-stamp>.sqlite'` — consistent copy without
   blocking writers (never a raw file copy of a live WAL database).
2. Compress + upload to the R2 bucket (S3 API, scoped token), object key
   `snapshots/<utc-stamp>.sqlite.gz`.
3. Update the freshness gauge; delete the temp file.
4. Retention: keep last 14 dailies + last 8 six-hourlies (R2 lifecycle rule
   as backstop).

**Freshness monitoring (OPS-02):** `GET /api/health` (authenticated) exposes
a `backup` object — `{ enabled, lastSnapshotAt, degraded }`; a snapshot older
than 2× the interval sets `degraded` — the operator-visible alert; failures
log loudly and never crash the process.

**Restore (OPS-03):** stop Hub → download + decompress snapshot → replace db
file (WAL/SHM absent) → start Hub → migrations no-op or roll forward → boot
reconciliation (UC-06) heals run states; conversations resume via the CLI's
own transcripts (FR-24). **Drill required once before Phase-1 exit**, restoring
a production snapshot into a scratch environment and sending one turn.

Accepted loss window = snapshot cadence (R-16 residual). The substrate's own
backup (shared-terminal #390) is independent and covers the session workspaces; the two
restores compose but never depend on each other.

## 6. Size & retention

- Payload cap enforced at ingestion (08 §2); message `content` capped at
  256 KiB (a full pasted file is plausible; beyond that, truncate with
  marker).
- No row deletion in Phase 1 — archive is a status, not a purge. Growth
  math: a heavy day ≈ 50 turns × ~25 events × ~2 KiB ≈ 2.5 MB/day; years of
  headroom before size management is a real problem (revisit with evidence,
  R-10).
- `VACUUM INTO` doubles as compaction; no separate VACUUM schedule needed.

## 7. Test obligations (feeds doc 13)

- `HubStore` contract suite runs against SQLite and the in-memory fake —
  identical results, including guarded-update rejections (I-2/I-3).
- Crash-point tests: kill the process between the §3 transactions and assert
  the reconciler heals to a legal state.
- Restore drill automated against a snapshot fixture.
- Idempotent ingestion: replay an S-01 fixture stream twice, assert
  identical row counts.
