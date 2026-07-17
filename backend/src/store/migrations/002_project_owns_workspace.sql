-- 002_project_owns_workspace: the workspace moves from the agent to the
-- project (ADR-006, FR-45). Verbatim from docs/09-persistence.md §2.
--
-- `workspace_template_id` is NOT the same field as `session_template_id`,
-- which is why it gets its own column rather than reusing it:
--
--   * workspace_template_id — what the project DECLARES. Exists from create,
--     before any session does.
--   * session_template_id   — what the live session was actually created
--     from (SessionBinding). NULL until provisioning succeeds.
--
-- They coincide today and would tempt a merge, but they answer different
-- questions and drift the moment a project's declaration is edited after
-- provisioning: the binding must keep saying what is actually running.
-- Collapsing them also breaks the "empty session binding on create"
-- invariant (UC-01), which is how the distinction was noticed.
--
-- `repo_auth` is ABSENT BY DESIGN, not by omission (FR-47, SEC-11): the
-- fine-grained PAT lives solely in the seam's encrypted session config, so
-- the Hub cannot leak a credential it never holds. Adding an auth column
-- here for symmetry would defeat SEC-11 — do not.

ALTER TABLE projects ADD COLUMN workspace_template_id TEXT;
ALTER TABLE projects ADD COLUMN repo_url TEXT;
ALTER TABLE projects ADD COLUMN repo_ref TEXT;
ALTER TABLE projects ADD COLUMN repo_target TEXT;

-- Backfill: existing projects adopt the template their session was actually
-- built from, so they keep the exact workspace they already have. Nothing
-- re-provisions and no session is touched. Rows that never provisioned stay
-- NULL, which the unprovisioned-project path already tolerates.
UPDATE projects SET workspace_template_id = session_template_id
 WHERE workspace_template_id IS NULL AND session_template_id IS NOT NULL;
