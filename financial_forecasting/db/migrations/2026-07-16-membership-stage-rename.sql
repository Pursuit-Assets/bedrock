-- Rename the jobs-pipeline membership stages to the team's vocabulary
-- (decision 2026-07-16): active -> qualified, handed_off -> converted_to_opportunity.
-- Also renames the (still-empty) stage-entry timestamp columns added earlier
-- today so names stay consistent. Coordinated with a same-day code deploy —
-- the previous release writes the old values and will fail stage edits
-- between this migration and the deploy.

BEGIN;

ALTER TABLE bedrock.jobs_contact_membership
  DROP CONSTRAINT IF EXISTS jobs_contact_membership_stage_vals;

UPDATE bedrock.jobs_contact_membership SET stage = 'qualified' WHERE stage = 'active';
UPDATE bedrock.jobs_contact_membership SET stage = 'converted_to_opportunity' WHERE stage = 'handed_off';

ALTER TABLE bedrock.jobs_contact_membership
  ADD CONSTRAINT jobs_contact_membership_stage_vals
  CHECK (stage IN ('flagged','initial_outreach','qualified','converted_to_opportunity','on_hold','not_a_fit'));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='bedrock'
             AND table_name='jobs_contact_membership' AND column_name='active_at') THEN
    ALTER TABLE bedrock.jobs_contact_membership RENAME COLUMN active_at TO qualified_at;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='bedrock'
             AND table_name='jobs_contact_membership' AND column_name='handed_off_at') THEN
    ALTER TABLE bedrock.jobs_contact_membership RENAME COLUMN handed_off_at TO converted_at;
  END IF;
END $$;

ALTER INDEX IF EXISTS bedrock.idx_jcm_active_at RENAME TO idx_jcm_qualified_at;
ALTER INDEX IF EXISTS bedrock.idx_jcm_handed_off_at RENAME TO idx_jcm_converted_at;

COMMIT;
