-- 2026-05-18: pebble_access permission key + per-user override mechanism
--             + JP-only launch-dark seed
--
-- Wave 0 of the Pebble L2 Research Swarm plan, launch-dark cohort.
--
-- Why:
--     Pebble (existing + new L2 swarm) is landing on main as a
--     launch-dark feature: code is shipped, but only jp@pursuit.org
--     can access it. Even other admins (Jac, etc.) cannot see the
--     Pebble sidebar entry or hit any /api/pebble/* route.
--
--     Two existing facts in the permission system make this
--     non-trivial to express via the current permission_profile +
--     user_config tables:
--
--         1. routes/permissions.py:113-115 — Admin profile FORCES
--            every key in PERMISSION_KEYS to true via setdefault.
--            So simply adding a new permission key would auto-grant
--            it to every Admin, defeating the JP-only intent.
--
--         2. bedrock.user_config has no per-user override mechanism
--            today — it links org_user_id → profile_id, period.
--            Per-user grants require either a new profile per user
--            (proliferation) or a new override column.
--
--     This migration solves both:
--
--         A. Adds pebble_access: false to each of the 4 profiles
--            (Admin, RM, Executive, PM). pebble_access will be
--            explicitly excluded from the Admin auto-fill in
--            routes/permissions.py via a new ADMIN_AUTOFILL_EXCLUDED
--            constant (paired migration in that file).
--
--         B. Adds bedrock.user_config.permission_overrides JSONB
--            column defaulting to '{}'. get_user_permissions applies
--            overrides as the LAST layer (profile → admin-autofill →
--            overrides) so a per-user override can both grant
--            (pebble_access=true) and deny (pebble_access=false).
--
--         C. Seeds permission_overrides = {"pebble_access": true}
--            for jp@pursuit.org's user_config row, creating the
--            row if it doesn't exist yet.
--
--     This generalizes beyond launch-dark Pebble: any future
--     per-user grant or deny ("Jac needs view_projects=false during
--     audit period") uses the same column.
--
-- Future widening:
--     When Pebble opens up beyond JP, change the per-profile default
--     from false → true for the desired profiles (e.g. Admin) via a
--     follow-up migration. The user_config overrides continue to win
--     for any individual exception.
--
-- Related:
--     * routes/permissions.py PERMISSION_KEYS + get_user_permissions
--     * routes/pebble_proxy.py require_ask_perm
--     * pebble/main.py check_pebble_perm
--     * frontend-v2 useUserPermissions + AppShell sidebar
--     * ~/.claude/plans/glistening-crafting-matsumoto.md (the gate
--       discussion follows JP's 2026-05-18 directive: "Pebble is
--       accessible to jp@pursuit.org when logged in. Only JP can
--       access it, not even other admins.")
--
-- Idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- A. Add pebble_access to all 4 profiles, default false
-- ---------------------------------------------------------------------------
-- The jsonb_set with create_missing=true ensures the key lands even
-- if a profile somehow lacked it before. WHERE clause limits to known
-- production profile names so a hand-rolled experimental profile
-- isn't accidentally rewritten.
UPDATE bedrock.permission_profile
SET permissions = jsonb_set(
        COALESCE(permissions, '{}'::jsonb),
        '{pebble_access}',
        'false'::jsonb,
        true
    ),
    updated_at = now()
WHERE name IN ('Admin', 'Relationship Manager', 'Executive', 'Project Manager');

-- ---------------------------------------------------------------------------
-- B. Add permission_overrides JSONB column to user_config
-- ---------------------------------------------------------------------------
-- DEFAULT '{}' so the JOIN-and-merge in get_user_permissions never
-- sees NULL. NOT NULL for the same reason — simpler to reason about.
ALTER TABLE bedrock.user_config
    ADD COLUMN IF NOT EXISTS permission_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN bedrock.user_config.permission_overrides IS
    'Per-user permission overlay. Applied AFTER profile permissions and Admin auto-fill in routes/permissions.py:get_user_permissions. A key set here wins regardless of profile. Used for launch-dark gates and individual exceptions.';

-- ---------------------------------------------------------------------------
-- C. JP-only launch-dark seed
-- ---------------------------------------------------------------------------
-- Three steps:
--   1. Locate jp@pursuit.org in public.org_users (may not exist
--      on a fresh local dev DB).
--   2. Ensure a user_config row exists for that org_user_id.
--   3. Merge {"pebble_access": true} into permission_overrides.
--
-- Wrapped in a DO block so we can NOTICE-and-continue when
-- public.org_users isn't reachable (e.g. local dev without the
-- learning platform schema).
DO $$
DECLARE
    jp_org_user_id UUID;
BEGIN
    BEGIN
        SELECT id INTO jp_org_user_id
        FROM public.org_users
        WHERE LOWER(email) = 'jp@pursuit.org'
        LIMIT 1;
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'Skipped JP seed — restricted access to public.org_users';
            RETURN;
        WHEN undefined_table THEN
            RAISE NOTICE 'Skipped JP seed — public.org_users does not exist on this DB';
            RETURN;
    END;

    IF jp_org_user_id IS NULL THEN
        RAISE NOTICE 'jp@pursuit.org not in public.org_users yet — re-run this migration after first JP login, or insert manually.';
        RETURN;
    END IF;

    -- Upsert user_config row, merging pebble_access into existing overrides.
    INSERT INTO bedrock.user_config (org_user_id, permission_overrides)
    VALUES (jp_org_user_id, '{"pebble_access": true}'::jsonb)
    ON CONFLICT (org_user_id) DO UPDATE SET
        permission_overrides = COALESCE(bedrock.user_config.permission_overrides, '{}'::jsonb)
            || '{"pebble_access": true}'::jsonb,
        updated_at = now();

    RAISE NOTICE 'JP launch-dark gate seeded for jp@pursuit.org (org_user_id=%)', jp_org_user_id;
END $$;
