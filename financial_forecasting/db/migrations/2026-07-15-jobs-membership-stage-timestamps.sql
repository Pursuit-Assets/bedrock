-- Stage-entry timestamps for the later two funnel stages.
--
-- bedrock.jobs_contact_membership already stamps WHEN a contact entered the
-- first two stages (flagged_at, first_outreach_at) but has no equivalent for
-- 'active' (Qualified Lead) or 'handed_off' (Committed) — only a generic
-- updated_at that bumps on ANY field edit (owner, notes, …), so it can't tell
-- us when the stage itself changed.
--
-- The Outreach Dashboard scorecard counts FLOW ("how many contacts entered
-- Qualified Lead this period vs last period"), which needs a real stage-entry
-- timestamp per stage. These two columns close that gap. They're stamped going
-- forward by the stage-transition endpoint (routes/jobs.py update_jobs_membership
-- / _flag_contacts) only when the stage actually changes into that value — so
-- historical rows stay NULL (that history was never recorded) and the flow
-- counts for these two stages build up from now on.
--
-- Owned by bedrock_user (the app role) already; ALTER needs no extra GRANT.
-- Idempotent.

BEGIN;

ALTER TABLE bedrock.jobs_contact_membership
  ADD COLUMN IF NOT EXISTS active_at     timestamptz,   -- entered stage='active'      (Qualified Lead)
  ADD COLUMN IF NOT EXISTS handed_off_at timestamptz;   -- entered stage='handed_off'  (Committed)

CREATE INDEX IF NOT EXISTS idx_jcm_active_at     ON bedrock.jobs_contact_membership(active_at);
CREATE INDEX IF NOT EXISTS idx_jcm_handed_off_at ON bedrock.jobs_contact_membership(handed_off_at);

COMMIT;
