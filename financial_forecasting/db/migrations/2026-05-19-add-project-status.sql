-- 2026-05-19: add status to bedrock.project
--
-- Lifecycle pill on each project — three buckets:
--   Upcoming = work hasn't started; planning / discovery only
--   Active   = in flight; default for newly-created projects
--   Done     = shipped or closed; archived from default views
--
-- Default 'Active' for existing rows (most current projects are in
-- flight). Idempotent — safe to re-run.

ALTER TABLE bedrock.project
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Active';

-- Constrain the picklist. DROP-IF-EXISTS first so re-runs survive a
-- prior partial apply.
ALTER TABLE bedrock.project
    DROP CONSTRAINT IF EXISTS project_status_check;
ALTER TABLE bedrock.project
    ADD CONSTRAINT project_status_check
    CHECK (status IN ('Upcoming', 'Active', 'Done'));

CREATE INDEX IF NOT EXISTS idx_project_status
    ON bedrock.project(status)
    WHERE deleted_at IS NULL;
