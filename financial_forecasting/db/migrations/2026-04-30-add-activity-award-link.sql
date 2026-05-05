-- 2026-04-30: add award_id to bedrock.activity for award-scoped activity logs.
--
-- Context:
--     The redesigned Bedrock UI shows activity timelines on Award detail
--     pages (payments received, reports submitted, manual notes). Today
--     bedrock.activity links to contact_id / opportunity_id / prospect_id
--     — none of which is the right home for an "award report submitted"
--     style log. We add award_id as an optional fourth FK, matching the
--     existing permissive shape (no "exactly one" constraint).
--
-- Related:
--     * tasks/bedrock-redesign-data-model.md §4.2
--     * 2026-04-30-add-award-table.sql (companion, must apply first)
--
-- Idempotent — safe to re-run.

ALTER TABLE bedrock.activity
    ADD COLUMN IF NOT EXISTS award_id UUID
    REFERENCES bedrock.award(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_activity_award
    ON bedrock.activity(award_id)
    WHERE award_id IS NOT NULL;
