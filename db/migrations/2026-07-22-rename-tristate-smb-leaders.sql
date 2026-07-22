-- Rename tag fast_local_influence → tristate_smb_leaders (2026-07-22, Jac).
-- Label "Tristate SMB Leaders". Renames the slug on contacts.tags too so the
-- stored value matches the catalog. Idempotent.

UPDATE public.contacts
SET tags = array_replace(tags, 'fast_local_influence', 'tristate_smb_leaders'), updated_at = now()
WHERE 'fast_local_influence' = ANY(tags);

UPDATE bedrock.contact_tag_catalog
SET slug = 'tristate_smb_leaders', label = 'Tristate SMB Leaders'
WHERE slug = 'fast_local_influence';
