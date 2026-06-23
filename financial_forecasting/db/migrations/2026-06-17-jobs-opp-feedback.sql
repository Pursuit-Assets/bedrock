-- Jobs pipeline — call-feedback round (opportunity-level additive columns)
-- ======================================================================
-- bedrock.jobs_opportunity is owned by bedrock_user, so the app role can apply
-- this directly. All columns are nullable/additive — existing rows unaffected.

BEGIN;

-- Closed-lost capture: a structured reason + free-text note, recorded when a
-- deal moves to closed_lost so we can analyze WHY deals die (by company type, etc.)
ALTER TABLE bedrock.jobs_opportunity ADD COLUMN IF NOT EXISTS closed_lost_reason text;
ALTER TABLE bedrock.jobs_opportunity ADD COLUMN IF NOT EXISTS closed_lost_note   text;

-- Lead prioritization: a manual 1–5 priority plus a computed suggestion the team
-- can override (auto-bumped by signals like C-suite contact / multiple contacts /
-- an open role at the company / builders applying).
ALTER TABLE bedrock.jobs_opportunity ADD COLUMN IF NOT EXISTS priority      int
    CHECK (priority IS NULL OR priority BETWEEN 1 AND 5);
ALTER TABLE bedrock.jobs_opportunity ADD COLUMN IF NOT EXISTS priority_auto int;

-- Segment / industry tag (Nick's VC-PE productization ask + general segmentation).
ALTER TABLE bedrock.jobs_opportunity ADD COLUMN IF NOT EXISTS segment text;

-- Warm-intro attribution: who at Pursuit opened the door (e.g. "Nick", a board
-- member, an event). Surfaced so warm/priority leads are obvious in meetings.
ALTER TABLE bedrock.jobs_opportunity ADD COLUMN IF NOT EXISTS intro_by text;

COMMIT;
