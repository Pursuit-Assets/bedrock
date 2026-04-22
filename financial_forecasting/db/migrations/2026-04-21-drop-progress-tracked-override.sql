-- ============================================================================
-- Migration: drop bedrock-side Progress-page visibility override
-- Date: 2026-04-21
-- Reverses: 2026-04-15-add-progress-tracked-override.sql
-- Feature: Settings → Progress Visibility tab (frontend removed in PR #139,
--          BUG-UI-19; backend router deleted in PR #158)
-- ============================================================================
--
-- Drops bedrock.progress_tracked_override, added 2026-04-15 to back the
-- Settings → Progress Visibility admin toggle. That toggle was removed from
-- the frontend in PR #139 (BUG-UI-19, 2026-04-21) and the backend router +
-- tests are removed alongside this migration in PR #158. Per verification in
-- PR #158, the only consumer was routes/progress_tracking.py (now deleted);
-- no other code reads or writes this table. init.sql never referenced it.
--
-- Idempotent — safe to run in any environment regardless of whether the ADD
-- migration was applied. IF EXISTS handles the missing-table case so systems
-- that never applied the ADD (e.g. segundo-db as of 2026-04-21 per JP) stay
-- unchanged; systems that did apply it (e.g. local dev) lose the table.
--
-- No CASCADE: the table has no dependent views, foreign keys, or triggers
-- (verified: the ADD migration created only the table itself + primary-key
-- index + three COMMENT ON statements, all of which drop implicitly with
-- the table). Omitting CASCADE is the safe default — if anything unexpected
-- were to reference this table, DROP would fail visibly rather than silently
-- take related objects with it.
--
-- Usage:
--     psql "$DATABASE_URL" -f db/migrations/2026-04-21-drop-progress-tracked-override.sql
--
-- Verify (after running):
--     \d bedrock.progress_tracked_override
--     --> "Did not find any relation named ..." on success.
--
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS bedrock.progress_tracked_override;

COMMIT;
