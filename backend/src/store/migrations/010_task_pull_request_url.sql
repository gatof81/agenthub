-- 010_task_pull_request_url: the PR opened on approval (N6b, ADR-010).
--
-- When the owner approves a task, the project session pushes the task branch and
-- opens a pull request with its own repo credential (never a specialist's). The
-- resulting URL is recorded here so the task view can link to it. NULL until
-- approved, or when the PR could not be opened (best-effort — a PR failure never
-- un-approves the task) or the task ran in the project-primary fallback (no
-- branch to publish).
--
-- Forward-only, no backfill: pre-N6b tasks have no PR.

ALTER TABLE tasks ADD COLUMN pull_request_url TEXT;
