-- Rename membership stage 'flagged' → 'assigned' (2026-07-21), Jac's call:
-- "assigned" is the first pipeline stage (a contact is assigned to someone
-- before outreach starts). Follows the qualified/converted precedent: DB
-- values rename, not a display alias. Columns flagged_at/flagged_by follow.
-- Idempotent.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='bedrock' AND table_name='jobs_contact_membership' AND column_name='flagged_at') THEN
    ALTER TABLE bedrock.jobs_contact_membership RENAME COLUMN flagged_at TO assigned_at;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='bedrock' AND table_name='jobs_contact_membership' AND column_name='flagged_by') THEN
    ALTER TABLE bedrock.jobs_contact_membership RENAME COLUMN flagged_by TO assigned_by;
  END IF;
END $$;

ALTER TABLE bedrock.jobs_contact_membership DROP CONSTRAINT IF EXISTS jobs_contact_membership_stage_vals;

UPDATE bedrock.jobs_contact_membership SET stage = 'assigned', updated_at = now() WHERE stage = 'flagged';

ALTER TABLE bedrock.jobs_contact_membership ADD CONSTRAINT jobs_contact_membership_stage_vals
  CHECK (stage = ANY (ARRAY['assigned'::text, 'initial_outreach'::text, 'qualified'::text,
                            'converted_to_opportunity'::text, 'on_hold'::text, 'not_a_fit'::text]));
