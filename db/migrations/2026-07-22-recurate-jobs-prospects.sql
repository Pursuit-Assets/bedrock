-- Re-curate is_jobs_contact (2026-07-22, Jac's call): the flag was blanket-set
-- by the linkedin_import (32k) and sf_mirror (13k) bulk loads, so 90% of all
-- contacts read as "jobs prospects". Redefine a jobs prospect as a contact with
-- a real jobs signal:
--   1. a jobs pipeline stage (jobs_contact_membership), OR
--   2. any curated CRM tag (the tagging exercise — bedrock.contact_tag_catalog), OR
--   3. jobs-classified activity — proxy for the deliberately-flagged/assigned
--      contacts whose membership was cleared 2026-07-22 (those 70 rows were
--      deleted and are not individually recoverable), OR
--   4. a link to a jobs opportunity.
-- Un-flags ~41k import-noise contacts. Fully reversible: the signal is
-- recomputable, and pre-change flagged ids are backed up to
-- ~/Desktop/is_jobs_contact_backup_pre_cleanup.csv. Idempotent.

UPDATE public.contacts c
SET is_jobs_contact = false, updated_at = now()
WHERE c.is_jobs_contact
  AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_contact_membership m WHERE m.contact_id = c.contact_id)
  AND NOT (coalesce(c.tags, '{}'::text[]) && ARRAY(SELECT slug FROM bedrock.contact_tag_catalog))
  AND NOT EXISTS (SELECT 1 FROM bedrock.activity a
                  WHERE a.participant_public_contact_id = c.contact_id AND a.deleted_at IS NULL
                    AND coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs')
  AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_opportunity o
                  WHERE o.deleted_at IS NULL
                    AND ('pub:' || c.contact_id::text = ANY(o.sf_contact_ids)
                         OR (c.airtable_id IS NOT NULL AND 'airtable:' || c.airtable_id = ANY(o.sf_contact_ids))));
