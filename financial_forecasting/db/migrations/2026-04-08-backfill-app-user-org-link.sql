-- ============================================================================
-- Migration: backfill bedrock.app_user.org_user_id for existing rows
-- Date: 2026-04-08
-- Phase: B-3 of Claim 3 (staff identity unification, Option B)
-- ============================================================================
--
-- Run this ONCE after init.sql Phase B-1 schema migration has been applied
-- against segundo-db. It walks every existing bedrock.app_user row and writes
-- back the matching public.org_users(id) when one exists by case-insensitive
-- email match.
--
-- Idempotent: safe to re-run. Rows that are already linked are not touched.
-- Rows that have no match in public.org_users are left as NULL — Phase B-5's
-- soft-block UI banner surfaces them so admins can resolve manually.
--
-- Usage:
--     psql "$SEGUNDO_DB_URL" -f db/migrations/2026-04-08-backfill-app-user-org-link.sql
--
-- ============================================================================

BEGIN;

-- Step 1: backfill the org_user_id link
WITH matches AS (
    SELECT au.id AS app_user_id, ou.id AS org_user_id
    FROM bedrock.app_user au
    JOIN public.org_users ou ON LOWER(ou.email) = LOWER(au.email)
    WHERE au.org_user_id IS NULL
)
UPDATE bedrock.app_user au
SET org_user_id = m.org_user_id, updated_at = now()
FROM matches m
WHERE au.id = m.app_user_id;

-- Step 2: report
SELECT
    COUNT(*) FILTER (WHERE org_user_id IS NOT NULL) AS linked,
    COUNT(*) FILTER (WHERE org_user_id IS NULL) AS unlinked,
    COUNT(*) AS total
FROM bedrock.app_user;

-- Step 3: list any unlinked rows so the operator knows who needs platform onboarding
SELECT id, email, name, sf_user_id, is_active
FROM bedrock.app_user
WHERE org_user_id IS NULL
ORDER BY email;

COMMIT;

-- ============================================================================
-- Verification (read-only — safe to run anytime after the backfill):
-- ============================================================================
--
-- Cross-check that linked rows actually point at a real org_users row:
--   SELECT au.email AS bedrock_email, ou.email AS platform_email,
--          au.org_user_id, ou.id AS verified_id, ou.display_name
--   FROM bedrock.app_user au
--   LEFT JOIN public.org_users ou ON ou.id = au.org_user_id
--   WHERE au.org_user_id IS NOT NULL
--   ORDER BY au.email;
--
-- Spot any name drift between Bedrock and the platform:
--   SELECT au.email, au.name AS bedrock_name, ou.display_name AS platform_name
--   FROM bedrock.app_user au
--   JOIN public.org_users ou ON ou.id = au.org_user_id
--   WHERE au.name IS NOT NULL
--     AND au.name <> ''
--     AND au.name <> ou.display_name;
