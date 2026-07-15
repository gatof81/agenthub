-- 001_init: Phase-1 schema, verbatim from docs/09-persistence.md §2.

CREATE TABLE projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('provisioning','ready','error','archived')),
  default_agent_id   TEXT NOT NULL,
  instructions       TEXT,
  session_id         TEXT,
  session_template_id TEXT,
  session_last_state TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE conversations (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  title              TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('active','archived')),
  runtime_session_id TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_conversations_project ON conversations (project_id, updated_at);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  run_id          TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_messages_conv ON messages (conversation_id, created_at);

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  message_id      TEXT NOT NULL UNIQUE REFERENCES messages(id),
  state           TEXT NOT NULL CHECK (state IN
    ('queued','starting','streaming','completed','completed_with_denials',
     'cancelled','interrupted','failed')),
  exec_id         TEXT,
  pgid            INTEGER,
  seam_request_id TEXT,
  caps_snapshot   TEXT NOT NULL,
  policy_snapshot TEXT NOT NULL CHECK (length(policy_snapshot) > 2),
  cli_version     TEXT,
  model           TEXT,
  kill_outcome    TEXT,
  sweep_result    TEXT,
  error_code      TEXT,
  error_detail    TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  ended_at        TEXT
);
CREATE INDEX idx_runs_conv ON runs (conversation_id, created_at);
CREATE INDEX idx_runs_active ON runs (state)
  WHERE state IN ('queued','starting','streaming');

CREATE TABLE run_events (
  id       TEXT PRIMARY KEY,
  run_id   TEXT NOT NULL REFERENCES runs(id),
  seq      INTEGER NOT NULL,
  type     TEXT NOT NULL CHECK (type IN
    ('started','output','tool_use','permission_denial','exit','error','unknown')),
  payload  TEXT NOT NULL,
  ts       TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE TABLE usage_records (
  run_id         TEXT PRIMARY KEY REFERENCES runs(id),
  total_cost_usd REAL,
  num_turns      INTEGER,
  usage          TEXT,
  source         TEXT NOT NULL CHECK (source IN ('result-event','cancelled-unknown','error-partial'))
);

CREATE TABLE sse_cursor (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  next_seq        INTEGER NOT NULL
);

CREATE TABLE run_summaries (
  run_id   TEXT PRIMARY KEY REFERENCES runs(id),
  summary  TEXT NOT NULL
);

CREATE TABLE meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
