-- ============================================================================
-- Migration: grant manage_owner_goals permission to Admin + Executive profiles
-- Date: 2026-04-19
-- Feature: Wall of Progress — "Edit target" (Settings → Targets)
-- ============================================================================
--
-- Background:
-- ----------
-- The `manage_owner_goals` permission gates PUT/DELETE on /api/owner-goals/*
-- (financial_forecasting/routes/owner_goals.py:106, 147). This permission was
-- never added to any of the four seeded profile JSONBs in init.sql:
--
--   * Admin         — absent; happened to work at runtime because of the
--                     permissions.py:113-115 setdefault auto-grant loop that
--                     iterates PERMISSION_KEYS for admins only.
--   * Executive     — absent; NO runtime auto-grant fires for non-admins, so
--                     Execs received 403 whenever they tried to edit a target,
--                     contradicting the UI label "Manage Revenue Targets (Exec)".
--   * Relationship  — absent; correct behavior (RMs should not edit targets).
--     Manager
--   * Project Mgr   — absent; correct behavior (PMs should not edit targets).
--
-- This migration makes the Admin + Executive grant explicit in the JSONB so
-- the behavior does not depend on the runtime setdefault and so it is visible
-- to admins inspecting the Settings → Permission Profiles page.
--
-- The companion change to init.sql adds the same key to both profile seeds
-- going forward — but because init.sql uses `ON CONFLICT (name) DO NOTHING`,
-- existing rows on an already-seeded database do not pick up the new key.
-- Run this migration once against the shared segundo-db.
--
-- Precedent incident: 2026-04-17 pair-review with Jac surfaced that JP's
-- target writes never reached the shared DB. Root cause was a DATABASE_URL
-- localhost fallback (fixed in db.py in this same PR) compounded by the
-- permission-key mismatch this file addresses. Full trace:
-- tasks/notes-2026-04-17-jac-review.md and tasks/mvp-launch-sprint.md B1.
--
-- Idempotent — safe to re-run. `||` merges onto the existing JSONB, so the
-- key is overwritten with the same value on a second run.
--
-- Usage:
--     psql "$DATABASE_URL" -f db/migrations/2026-04-19-add-manage-owner-goals-permission.sql
--
-- Rollback:
--     UPDATE bedrock.permission_profile
--     SET permissions = permissions - 'manage_owner_goals'
--     WHERE name IN ('Admin', 'Executive');
--
-- ============================================================================

BEGIN;

UPDATE bedrock.permission_profile
SET permissions = permissions || '{"manage_owner_goals": true}'::jsonb
WHERE name IN ('Admin', 'Executive');

COMMIT;

-- ============================================================================
-- Verification (read-only — safe anytime):
-- ============================================================================
--
-- Confirm Admin + Executive now grant the permission:
--   SELECT name, permissions->>'manage_owner_goals' AS manage_owner_goals
--   FROM bedrock.permission_profile
--   ORDER BY name;
--
-- Expected output:
--   name                  | manage_owner_goals
--   ----------------------+-------------------
--   Admin                 | true
--   Executive             | true
--   Project Manager       | (null)
--   Relationship Manager  | (null)
--
-- Absence of the key on Project Manager + Relationship Manager is correct —
-- `perms.get("manage_owner_goals", False)` at permissions.py:214 treats
-- absence as false. No migration needed to make that explicit.
