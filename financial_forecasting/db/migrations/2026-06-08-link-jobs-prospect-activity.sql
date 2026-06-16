-- ============================================================================
-- Link synced (gmail/calendar) + manual activity to jobs prospects
-- ============================================================================
-- The jobs Performance dashboard's "Engaged" / "Outreach" / "Calls" metrics
-- need to reflect activity captured by the nightly Gmail/Calendar sync, scoped
-- to employer PROSPECTS (public.contacts WHERE is_jobs_contact). Synced rows
-- leave participant_public_contact_id NULL, so we resolve it by email match.
--
-- This index makes the "distinct engaged prospects" count a fast indexed join
-- instead of a 20s full-scan email match. The link itself is (re)populated by
-- services/jobs_activity_link.relink_jobs_prospect_activity(), run once as a
-- backfill and again after every nightly interaction sync.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_activity_participant_public_contact
    ON bedrock.activity (participant_public_contact_id)
    WHERE participant_public_contact_id IS NOT NULL;
