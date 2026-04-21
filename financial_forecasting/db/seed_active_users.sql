-- Seed: Active Pursuit staff for the Projects owner picker.
-- Written against public.org_users (canonical staff identity per the
-- identity-consolidation work — see bedrock/init.sql and routes/permissions.py).
--
-- Two buckets:
--   1. SF-synced users — sf_user_id is NULL here; populated later by the SF
--      user sync once local OAuth works. The display_name-based matching in
--      scripts/migrate_owner_to_multi.py does not require sf_user_id.
--   2. Non-SF teammates — permanently no sf_user_id. JP-confirmed emails.
--
-- Idempotent via ON CONFLICT (email) DO UPDATE — re-running this keeps
-- display_name and is_active in sync with the canonical list below.
-- Safe to re-run in any environment.

INSERT INTO public.org_users (id, email, display_name, sf_user_id, is_active, created_at, updated_at)
VALUES
    -- SF Active users from the Pursuit SF owner picker (snapshot 2026-04-21)
    (uuid_generate_v4(), 'allie.mikalatos@pursuit.org',    'Allie Mikalatos',   NULL, true, now(), now()),
    (uuid_generate_v4(), 'andrew.tein@pursuit.org',        'Andrew Tein',       NULL, true, now(), now()),
    (uuid_generate_v4(), 'angie.lausche@pursuit.org',      'Angie Lausche',     NULL, true, now(), now()),
    (uuid_generate_v4(), 'dave.yang@pursuit.org',          'Dave Yang',         NULL, true, now(), now()),
    (uuid_generate_v4(), 'devika.gopal-agge@pursuit.org',  'Devika Gopal Agge', NULL, true, now(), now()),
    (uuid_generate_v4(), 'erica.wong@pursuit.org',         'Erica Wong',        NULL, true, now(), now()),
    (uuid_generate_v4(), 'guilherme.barros@pursuit.org',   'Guilherme Barros',  NULL, true, now(), now()),
    (uuid_generate_v4(), 'joanna.patterson@pursuit.org',   'Joanna Patterson',  NULL, true, now(), now()),
    (uuid_generate_v4(), 'nick.simmons@pursuit.org',       'Nick Simmons',      NULL, true, now(), now()),
    (uuid_generate_v4(), 'rebecca.qian@pursuit.org',       'Rebecca Qian',      NULL, true, now(), now()),
    (uuid_generate_v4(), 'victoria.mayo@pursuit.org',      'Victoria Mayo',     NULL, true, now(), now()),
    -- Non-SF teammates — JP-confirmed 2026-04-21
    (uuid_generate_v4(), 'johnny.nguyen@pursuit.org',      'Johnny Nguyen',     NULL, true, now(), now()),
    (uuid_generate_v4(), 'laura@pursuit.org',              'Laura Capucilli',   NULL, true, now(), now()),
    (uuid_generate_v4(), 'yoshi@pursuit.org',              'Yoshi Minami',      NULL, true, now(), now())
ON CONFLICT (email) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    is_active    = true,
    updated_at   = now();

-- Note: "Systems Admin" from the SF active list is intentionally excluded —
-- it is a service account and must not appear as a selectable project owner.
-- Note: JP Bowditch (jp@pursuit.org) is expected to already exist from the
-- first-user bootstrap in routes/permissions.py::get_user_permissions.
