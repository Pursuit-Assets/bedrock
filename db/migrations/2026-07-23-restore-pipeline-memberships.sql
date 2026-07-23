-- Restore in-pipeline memberships (2026-07-23) that were wrongly deleted by the
-- over-aggressive revert. Two groups, both entered at stage 'assigned' = "in
-- pipeline, no jobs stage yet" (renders grey in the campaign funnel):
--   A. every contact with a catalog tag OTHER than influence/tristate_smb_leaders
--      (the worked tagged network), and
--   B. the curated Tristate SMB Leaders with a Pursuit signal (activity, SF link,
--      or another tag), excluding the two Hot Bread Kitchen contacts.
-- Only creates memberships where none exists (never touches real stages). Idempotent.

-- A. tagged network (minus influence/tristate)
INSERT INTO bedrock.jobs_contact_membership (contact_id, stage, activation_reason, assigned_at, updated_at)
SELECT DISTINCT c.contact_id, 'assigned', 'algorithm', now(), now()
FROM public.contacts c
WHERE coalesce(c.tags,'{}'::text[]) && ARRAY(
        SELECT slug FROM bedrock.contact_tag_catalog
        WHERE active AND slug NOT IN ('influence','tristate_smb_leaders'))
  AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_contact_membership m WHERE m.contact_id = c.contact_id)
ON CONFLICT (contact_id) DO NOTHING;

-- B. curated Tristate SMB Leaders (has a signal, not Hot Bread Kitchen)
INSERT INTO bedrock.jobs_contact_membership (contact_id, stage, activation_reason, assigned_at, updated_at)
SELECT DISTINCT c.contact_id, 'assigned', 'strategic', now(), now()
FROM public.contacts c
WHERE 'tristate_smb_leaders' = ANY(c.tags)
  AND lower(coalesce(c.current_company,'')) <> 'hot bread kitchen'
  AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_contact_membership m WHERE m.contact_id = c.contact_id)
  AND ( (SELECT count(*) FROM bedrock.activity a WHERE a.participant_public_contact_id=c.contact_id AND a.deleted_at IS NULL) > 0
        OR EXISTS (SELECT 1 FROM bedrock.sf_contact_link l WHERE l.public_contact_id=c.contact_id)
        OR EXISTS (SELECT 1 FROM unnest(c.tags) x WHERE x <> 'tristate_smb_leaders' AND x <> 'influence' AND x IN (SELECT slug FROM bedrock.contact_tag_catalog)) )
ON CONFLICT (contact_id) DO NOTHING;
