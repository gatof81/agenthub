-- 011_task_step_runtime_session: per-step CLI continuation (#123).
--
-- A task step's runtime turn must never share the CONVERSATION's continuation
-- handle: the first step of a worktree task creates a CLI conversation scoped
-- to the worktree's working directory, and writing that id to the conversation
-- poisons every later turn — after the worktree is cleaned up on task terminal,
-- `--resume <id>` fails from any other directory and the conversation wedges
-- (runtime_error: "No conversation found with session ID"). It also bled CLI
-- context across roles: QA resumed the implementer's session.
--
-- Each step now records its OWN handle here; a later step resumes the latest
-- handle of the SAME task + specialist + kind (implementer attempt N continues
-- attempt N-1; QA cycle N continues QA cycle N-1; never cross-role).
--
-- Forward-only, no backfill: pre-011 steps have no recorded handle — their
-- next attempt simply starts a fresh CLI conversation.

ALTER TABLE task_steps ADD COLUMN runtime_session_id TEXT;
