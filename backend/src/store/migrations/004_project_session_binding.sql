-- 004_project_session_binding: the session belongs to the owner's admin
-- account (ADR-007, doc 19 §5). The binding records how the project got its
-- session and who functionally owns it.
--
--   * binding_mode      — 'existing' (bound to a session the owner already
--                         had, FR-49) | 'created' (provisioned by the Hub).
--   * owner_account_id  — substrate account owning the session. NULL means
--                         UNRECORDED (pre-correction rows), never "no owner":
--                         no truthful backfill exists — the Hub never stored
--                         which seam account it logged in as.
--   * session_ownership — 'owner' | 'legacy-technical'. Drives lifecycle
--                         authority: the Hub stops/starts only sessions its
--                         own identity owns; owner-account sessions are the
--                         owner's to control (ADR-007 — observed, never
--                         repaired or force-stopped).
--
-- Backfill: every existing row was provisioned by the Hub into its technical
-- account, so 'created' + 'legacy-technical' states exactly what happened.
-- Sessions are never reassigned by migration (ADR-007): a legacy project is
-- rebound deliberately or not at all.

ALTER TABLE projects ADD COLUMN binding_mode TEXT;
ALTER TABLE projects ADD COLUMN owner_account_id TEXT;
ALTER TABLE projects ADD COLUMN session_ownership TEXT;

UPDATE projects SET binding_mode = 'created' WHERE binding_mode IS NULL;
UPDATE projects SET session_ownership = 'legacy-technical'
 WHERE session_ownership IS NULL;
