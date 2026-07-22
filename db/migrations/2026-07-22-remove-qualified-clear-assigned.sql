-- Pipeline simplification (2026-07-21 evening, Jac):
-- 1. 'qualified' is no longer a contact stage — every qualified row moves to
--    converted_to_opportunity (converted_at falls back to qualified_at).
--    Where the contact's company has a live opportunity, link it.
-- 2. Current 'assigned' rows are cleared to blank (membership deleted) —
--    'assigned' stays a valid stage going forward (the entry stage when a
--    contact is assigned), but today's leftovers were bulk-flag noise.
-- Idempotent.

-- 1a. link converted/qualified contacts to their company's best live opportunity
UPDATE bedrock.jobs_contact_membership m
SET opportunity_id = o.id
FROM public.contacts c,
LATERAL (
  SELECT o.id FROM bedrock.jobs_opportunity o
  WHERE o.deleted_at IS NULL
    AND lower(trim(o.account_name)) = lower(trim(c.current_company))
  ORDER BY (o.stage LIKE 'active%') DESC, o.updated_at DESC NULLS LAST
  LIMIT 1
) o
WHERE c.contact_id = m.contact_id AND m.opportunity_id IS NULL
  AND m.stage IN ('qualified', 'converted_to_opportunity')
  AND coalesce(trim(c.current_company), '') <> '';

-- 1b. qualified → converted_to_opportunity
UPDATE bedrock.jobs_contact_membership
SET stage = 'converted_to_opportunity',
    converted_at = coalesce(converted_at, qualified_at, now()),
    updated_at = now()
WHERE stage = 'qualified';

-- 2. clear the 'assigned' leftovers to blank
DELETE FROM bedrock.jobs_contact_membership WHERE stage = 'assigned';

-- constraint: drop 'qualified' from the allowed values
ALTER TABLE bedrock.jobs_contact_membership DROP CONSTRAINT IF EXISTS jobs_contact_membership_stage_vals;
ALTER TABLE bedrock.jobs_contact_membership ADD CONSTRAINT jobs_contact_membership_stage_vals
  CHECK (stage = ANY (ARRAY['assigned'::text, 'initial_outreach'::text,
                            'converted_to_opportunity'::text, 'on_hold'::text, 'not_a_fit'::text]));
