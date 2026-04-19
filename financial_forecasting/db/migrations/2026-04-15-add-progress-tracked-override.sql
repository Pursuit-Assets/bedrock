-- ============================================================================
-- Migration: bedrock-side Progress-page visibility override
-- Date: 2026-04-15
-- Feature: Settings → Progress Visibility tab
-- ============================================================================
--
-- Creates a Bedrock-owned table keyed by Salesforce User Id that admins use
-- to hide specific users from the Progress page Individual Progress table
-- (e.g. service accounts like Slackbot, or ex-employees still marked
-- IsActive=true in Salesforce). Sparse: no row = default behavior =
-- tracked. Toggling off writes `is_tracked = false`; toggling back on
-- updates the same row — we do not DELETE so the audit of who changed
-- what and when is preserved.
--
-- Keyed by sf_user_id (not public.org_users.id) so it works for SF service
-- accounts that never log into Bedrock and therefore have no org_users
-- row. Completely Bedrock-owned; no schema change to platform-owned
-- public.org_users is required.
--
-- Idempotent — safe to re-run.
--
-- Usage:
--     psql "$DATABASE_URL" -f db/migrations/2026-04-15-add-progress-tracked-override.sql
--
-- Rollback:
--     DROP TABLE bedrock.progress_tracked_override;
--   (Removing the table reverts the default behavior — every SF user is
--    tracked. No cross-table cleanup needed.)
--
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS bedrock.progress_tracked_override (
    sf_user_id       TEXT PRIMARY KEY,
    is_tracked       BOOLEAN NOT NULL,
    updated_by_email TEXT,
    updated_at       TIMESTAMPTZ DEFAULT now(),
    created_at       TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE bedrock.progress_tracked_override IS
    'Admin-managed override controlling which Salesforce users appear on '
    'the Progress page Individual Progress table. Sparse (no row = default '
    'behavior = tracked). Bedrock-owned; no dependency on public.org_users '
    'so it covers SF service accounts that never log into Bedrock.';

COMMENT ON COLUMN bedrock.progress_tracked_override.sf_user_id IS
    '18-char Salesforce User Id. Not a foreign key because service accounts '
    'may not exist in public.org_users.';

COMMENT ON COLUMN bedrock.progress_tracked_override.is_tracked IS
    'TRUE = user appears on the Progress page Individual Progress table. '
    'FALSE = hidden. Absence of a row is equivalent to TRUE.';

COMMENT ON COLUMN bedrock.progress_tracked_override.updated_by_email IS
    'Email of the admin who most recently toggled this row. Populated on '
    'every UPSERT. Null only for pre-audit rows (shouldn''t exist in '
    'practice — the single code path that writes this table always '
    'supplies actor email).';

COMMIT;

-- ============================================================================
-- Verification (read-only — safe anytime):
-- ============================================================================
--
-- Confirm table exists with the expected shape:
--   \d bedrock.progress_tracked_override
--
-- List current overrides:
--   SELECT sf_user_id, is_tracked, updated_by_email, updated_at
--   FROM bedrock.progress_tracked_override
--   ORDER BY updated_at DESC;
--
-- Count users who are currently hidden from the Progress page:
--   SELECT COUNT(*) FROM bedrock.progress_tracked_override WHERE is_tracked = false;
