-- 005_specialist_sessions: a specialist's optional personal session
-- (ADR-008, N3b-1, doc 19 §7). The specialist itself is config (agents.yaml,
-- SEC-10) — only its session binding is state, and there is at most one per
-- specialist, so specialist_id is the primary key.
--
-- Ownership fields mean exactly what they do for a project (ADR-007,
-- migration 004): 'owner' sessions are the owner's to control (the Hub never
-- stops/starts them), 'legacy-technical' ones the Hub owns. A personal
-- session is bound (existing) or created on-behalf (#420) in the owner's
-- account, back-linked via external_ref = agenthub:specialist:<id>.
--
-- No backfill: there were no specialist sessions before this migration.

CREATE TABLE specialist_sessions (
  specialist_id      TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  owner_account_id   TEXT,
  session_ownership  TEXT NOT NULL,
  binding_mode       TEXT NOT NULL,
  last_known_state   TEXT,
  status             TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
