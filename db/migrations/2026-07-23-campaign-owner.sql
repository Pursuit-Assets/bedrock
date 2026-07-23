-- Campaign owner (2026-07-23): a staff owner per tag campaign, stored on the
-- catalog row. Alumni cohorts share one owner (set on all alumni_* slugs).
-- Idempotent.
ALTER TABLE bedrock.contact_tag_catalog ADD COLUMN IF NOT EXISTS owner_email text;
