-- 008_tasks: the developer → QA → human-approval lifecycle (N5a, ADR-009).
--
-- A Task is coordinated work parented to a Project (18 §8), born from a
-- conversation message the router classified as a task (ADR-009). It carries a
-- state machine (taskStateMachine.ts) whose terminal success is `approved` —
-- never the implementer finishing, never QA passing alone. TaskSteps are
-- executed by specialists via the existing run machinery; a run links back to
-- its step through the new `runs.task_step_id`. Work products
-- (ImplementationReport/QaReport) extend the 18 §4 envelope; the body is stored
-- as JSON like the other snapshot columns (caps/policy/target_decision), so the
-- typed shape lives in the domain and evolves without a migration.
--
-- Split from the original 007 (which shipped the run target columns for N4a) —
-- see doc 19 §5. Forward-only, no backfill: there are no pre-N5a tasks.
--
-- FK note: the migration runner toggles `PRAGMA foreign_keys` OFF around each
-- migration and integrity-checks after (see migrations.ts, migration 006), so
-- these `REFERENCES` are declarations enforced at runtime, not during apply.

CREATE TABLE tasks (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id),
  -- soft references (NO FK), like `source_message_id` and `work_products.run_id`
  -- below: a task's originating conversation/message may be pruned, but the task
  -- (and its work products) stay as the record of what was done. A hard FK here
  -- would block that prune, contradicting the intent.
  source_conversation_id TEXT,
  source_message_id      TEXT,
  state                  TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX idx_tasks_project ON tasks(project_id);

CREATE TABLE task_steps (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  seq           INTEGER NOT NULL,           -- order within the task
  kind          TEXT NOT NULL,              -- 'implementation' | 'qa'
  specialist_id TEXT NOT NULL,              -- who executes it (config id, ADR-008)
  created_at    TEXT NOT NULL,
  UNIQUE (task_id, seq)
);
CREATE INDEX idx_task_steps_task ON task_steps(task_id);

CREATE TABLE work_products (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL REFERENCES tasks(id),
  task_step_id           TEXT REFERENCES task_steps(id),
  kind                   TEXT NOT NULL,     -- 'implementation_report' | 'qa_report'
  producer_specialist_id TEXT NOT NULL,
  run_id                 TEXT,              -- provenance (18 §4); no FK: runs may be pruned
  body                   TEXT NOT NULL,     -- JSON (the typed report shape)
  created_at             TEXT NOT NULL
);
CREATE INDEX idx_work_products_task ON work_products(task_id);

-- a run may belong to a task step (N5a); NULL for an ordinary conversation run
ALTER TABLE runs ADD COLUMN task_step_id TEXT;
