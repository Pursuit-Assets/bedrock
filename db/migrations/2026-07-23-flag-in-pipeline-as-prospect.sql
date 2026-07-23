-- Consistency fix (2026-07-23): any contact with a jobs pipeline membership must
-- be a jobs prospect. 12 curated Tristate SMB Leaders got memberships (restore
-- migration) but is_jobs_contact was never set, so they were in the pipeline yet
-- hidden from the Contacts jobs-scope view. Flag them. Idempotent.
UPDATE public.contacts c SET is_jobs_contact = true, updated_at = now()
WHERE NOT c.is_jobs_contact
  AND EXISTS (SELECT 1 FROM bedrock.jobs_contact_membership m WHERE m.contact_id = c.contact_id);
