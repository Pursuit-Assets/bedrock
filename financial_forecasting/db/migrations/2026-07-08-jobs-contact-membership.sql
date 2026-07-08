-- Jobs contact activation: the per-contact jobs-pipeline membership.
--
-- Everyone is a contact (public.contacts). This table carves the viable jobs
-- working set out of the ~40k: a row here = "flagged for jobs activation", and
-- `stage` is the outreach funnel. Cold = no row. Replaces the jobs role of
-- is_jobs_contact + the contact_stage funnel values (which stay in place during
-- the transition — this table is additive and kept in sync; nothing is dropped
-- here). See tasks/jobs-contact-activation-spec.md.
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS bedrock.jobs_contact_membership (
  contact_id                       integer PRIMARY KEY,   -- → public.contacts.contact_id (soft ref)
  -- Funnel. Happy path: flagged → initial_outreach → active → handed_off.
  -- on_hold + not_a_fit are off-ramps reachable from any active stage.
  stage                            text NOT NULL DEFAULT 'flagged',
  owner_email                      text,                  -- jobs-team owner of this contact
  activation_reason                text,                  -- manual | scraper_job | strategic | algorithm
  activation_note                  text,
  -- WHO actually did the first outreach (may differ from owner — e.g. a connected
  -- staffer who made a warm intro). Stamped on the → initial_outreach transition.
  first_outreach_by                text,                  -- staff email
  first_outreach_at                timestamptz,
  first_outreach_intro_request_id  uuid,                  -- → bedrock.intro_request.id, if a warm intro
  opportunity_id                   uuid,                  -- set when stage='handed_off' (→ bedrock.jobs_opportunity)
  not_a_fit_reason                 text,                  -- when stage='not_a_fit'
  flagged_by                       text,
  flagged_at                       timestamptz NOT NULL DEFAULT now(),
  updated_at                       timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE bedrock.jobs_contact_membership
    ADD CONSTRAINT jobs_contact_membership_stage_vals
    CHECK (stage IN ('flagged','initial_outreach','active','handed_off','on_hold','not_a_fit'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE bedrock.jobs_contact_membership
    ADD CONSTRAINT jobs_contact_membership_reason_vals
    CHECK (activation_reason IS NULL OR activation_reason IN ('manual','scraper_job','strategic','algorithm'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_jcm_stage    ON bedrock.jobs_contact_membership(stage);
CREATE INDEX IF NOT EXISTS idx_jcm_owner    ON bedrock.jobs_contact_membership(owner_email);
CREATE INDEX IF NOT EXISTS idx_jcm_outreach ON bedrock.jobs_contact_membership(first_outreach_by);

-- Backfill ONLY the genuinely-worked contacts — those with a real outreach-funnel
-- contact_stage (lead / initial_outreach / active / on_hold), ~700 rows. We
-- deliberately do NOT backfill the ~46k is_jobs_contact=true contacts that have
-- no funnel stage: that flag became near-universal (its meaninglessness is why
-- we're replacing it), and treating all 46k as "flagged" would make every
-- account "Activating" and defeat the carve. Lifecycle stages
-- (candidate/dismissed/merged) are excluded by the funnel-stage filter.
-- The membership is the selective working set from day one; the team flags more
-- via the contacts page. Idempotent via ON CONFLICT.
INSERT INTO bedrock.jobs_contact_membership (contact_id, stage, activation_reason, flagged_at, updated_at)
SELECT c.contact_id,
       CASE lower(c.contact_stage)
         WHEN 'initial_outreach' THEN 'initial_outreach'
         WHEN 'active'           THEN 'active'
         WHEN 'on_hold'          THEN 'on_hold'
         ELSE 'flagged'                      -- 'lead'
       END,
       'manual',
       coalesce(c.updated_at, now()),
       now()
FROM public.contacts c
WHERE lower(coalesce(c.contact_stage,'')) IN ('lead','initial_outreach','active','on_hold')
ON CONFLICT (contact_id) DO NOTHING;

COMMIT;
