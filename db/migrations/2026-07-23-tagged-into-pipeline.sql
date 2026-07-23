-- Put the tagged network into the jobs pipeline (2026-07-23, Jac): every contact
-- carrying a catalog tag OTHER than 'influence'/'tristate_smb_leaders' (which are
-- aspirational/BD, not worked-pipeline) that has no membership yet gets one at
-- stage 'assigned' (in pipeline, not yet contacted). Existing memberships are
-- left untouched (never downgrades a contacted/converted contact). Idempotent.
INSERT INTO bedrock.jobs_contact_membership (contact_id, stage, activation_reason, assigned_at, updated_at)
SELECT DISTINCT c.contact_id, 'assigned', 'algorithm', now(), now()
FROM public.contacts c
WHERE coalesce(c.tags,'{}'::text[]) && ARRAY(
        SELECT slug FROM bedrock.contact_tag_catalog
        WHERE active AND slug NOT IN ('influence','tristate_smb_leaders'))
  AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_contact_membership m WHERE m.contact_id = c.contact_id)
ON CONFLICT (contact_id) DO NOTHING;
