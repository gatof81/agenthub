-- 007_run_execution_target: the routing decision recorded on the run it was
-- made for (ADR-008, automatic mode, N4a).
--
-- In automatic mode a run has no immutable conversation.agentId: the router
-- proposes a specialist and the deterministic execution-target selector chooses
-- the session (ADR-008 Option 3). "Who ran, where, and why" therefore lives on
-- the run, not the conversation — the same place instructions_snapshot and the
-- caps/policy snapshots already live (I-8). Without this column that decision is
-- visible only while the run is in flight and is lost on reload; persisting it
-- is what makes the run inspector the durable audit surface automatic mode needs
-- (doc 19 §7 N4a; split out of the original 007 so it lands ahead of N5's tasks).
--
-- Both columns NULLABLE, and NULL is meaningful — never a default nobody chose:
--
--   * target_session_id — the session the selector chose. NULL for a DIRECT run,
--     which derives its session structurally from the conversation (project
--     primary, or the pinned specialist's) with no selector in the loop.
--   * target_decision — the ExecutionTargetDecision as JSON
--     ({specialistId, selectedSessionId, reason, alternativesConsidered,
--     workspaceStrategy}). NULL for a direct run, for the same reason.
--
-- No backfill: a direct run made no execution-target decision, so there is
-- nothing truthful to record for it. NULL says "no selector ran", never "the
-- selector chose nothing" — inventing a decision for historical direct runs
-- would fabricate an audit record (the 003 discipline).

ALTER TABLE runs ADD COLUMN target_session_id TEXT;
ALTER TABLE runs ADD COLUMN target_decision TEXT;
