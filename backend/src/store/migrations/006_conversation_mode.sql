-- 006_conversation_mode (N3b-2, doc 19 §5): a conversation can be direct with
-- a SPECIALIST and have no project (ADR-008). Two changes:
--   * project_id becomes NULLABLE (a specialist conversation has none).
--   * mode ∈ 'direct' | 'preferred-specialist' | 'automatic' (default 'direct';
--     only 'direct' is used until N4). I-10 becomes "project_id never changes
--     once set"; I-6 (agent_id immutable) survives in direct mode.
--
-- SQLite cannot drop a column's NOT NULL in place, so the table is rebuilt.
-- Every existing conversation is a project conversation → project_id stays,
-- mode backfills to 'direct'. FK to projects is kept (nullable FKs are fine).

CREATE TABLE conversations_new (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT REFERENCES projects(id),
  title              TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  mode               TEXT NOT NULL DEFAULT 'direct'
                       CHECK (mode IN ('direct','preferred-specialist','automatic')),
  status             TEXT NOT NULL CHECK (status IN ('active','archived')),
  runtime_session_id TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

INSERT INTO conversations_new
  (id, project_id, title, agent_id, mode, status, runtime_session_id, created_at, updated_at)
SELECT id, project_id, title, agent_id, 'direct', status, runtime_session_id, created_at, updated_at
  FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

CREATE INDEX idx_conversations_project ON conversations (project_id, updated_at);
CREATE INDEX idx_conversations_agent ON conversations (agent_id, updated_at);
