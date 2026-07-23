-- 012_task_pending_feedback: owner steering for a running task (ADR-014, I-14).
--
-- A conversation holds at most ONE active task; a work-shaped message sent
-- while it runs STEERS it instead of spawning a sibling. Mid-flight steering
-- cannot interrupt a running step (one CLI turn), so it queues here — a JSON
-- array of owner notes — and the supervisor drains it into the next developer
-- prompt (the same fold QA feedback uses). Persisted, not in-memory, so
-- steering survives a restart alongside the task it belongs to (UC-06 heals
-- the task; the notes ride with it).
--
-- Forward-only, no backfill: NULL means "no pending steering", same as '[]'.

ALTER TABLE tasks ADD COLUMN pending_feedback TEXT;
