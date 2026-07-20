-- 009_task_step_workspace_access: the DelegatedWorkspaceAccess audit row (N5b-2,
-- ADR-010 §71).
--
-- A task step runs its specialist's turn in an isolated git worktree owned by
-- the project session (ADR-010 B), so concurrent tasks never collide in the
-- shared workspace. Each step records HOW it was granted that access — the
-- access mode (worktree-write / test-execution / ...), the branch and worktree
-- path, optional bounds, and an expiry — as one auditable, revocable snapshot,
-- consistent with `runs.caps_snapshot` / `policy_snapshot` / `target_decision`
-- (I-8) rather than a new mechanism. Stored as JSON so the typed shape
-- (DelegatedWorkspaceAccess) lives in the domain and evolves without a
-- migration.
--
-- Forward-only, no backfill: pre-N5b-2 steps ran in the project primary session
-- and carry NULL (a strategy-A step, no delegated worktree grant).

ALTER TABLE task_steps ADD COLUMN workspace_access TEXT;
