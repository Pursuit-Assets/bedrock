-- Jobs-relevance classification for outreach metrics.
-- Each staff email/meeting gets labelled jobs | not_jobs | unclear so outreach
-- metrics can count ANY staff member's jobs-related activity (not just the core
-- team). Classification is content-intent based (see services/activity_classifier.py).
-- Idempotent.

BEGIN;

-- 1. Verdict columns on the activity row.
ALTER TABLE bedrock.activity
  ADD COLUMN IF NOT EXISTS jobs_relevance            text,
  ADD COLUMN IF NOT EXISTS jobs_relevance_reason     text,
  ADD COLUMN IF NOT EXISTS jobs_relevance_confidence real,
  ADD COLUMN IF NOT EXISTS jobs_relevance_model      text,
  ADD COLUMN IF NOT EXISTS jobs_relevance_at         timestamptz;

DO $$ BEGIN
  ALTER TABLE bedrock.activity
    ADD CONSTRAINT jobs_relevance_vals
    CHECK (jobs_relevance IS NULL OR jobs_relevance IN ('jobs','not_jobs','unclear'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Metric filter: only the jobs-relevant, live rows.
CREATE INDEX IF NOT EXISTS activity_jobs_relevance_idx
  ON bedrock.activity (jobs_relevance) WHERE deleted_at IS NULL;
-- Backfill / nightly worklist: rows still needing classification.
CREATE INDEX IF NOT EXISTS activity_unclassified_idx
  ON bedrock.activity (type) WHERE jobs_relevance IS NULL AND deleted_at IS NULL;

-- 2. Editable staff-function map (org_users has no role field). Soft prior only —
--    content always overrides it in the classifier.
--    tier: jobs (places builders) | pbd (fundraising/partnerships/program) | both (LT/cross-functional, no lean)
CREATE TABLE IF NOT EXISTS bedrock.staff_function (
  email      text PRIMARY KEY,
  tier       text NOT NULL CHECK (tier IN ('jobs','pbd','both')),
  note       text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO bedrock.staff_function (email, tier, note) VALUES
  ('avni@pursuit.org',             'jobs', 'Employer partnerships / jobs'),
  ('damon.kornhauser@pursuit.org', 'jobs', 'Employer partnerships / jobs'),
  ('ericawong@pursuit.org',        'pbd',  'Program & development'),
  ('guilherme@pursuit.org',        'pbd',  'Development / fundraising'),
  ('guilherme.barros@pursuit.org', 'pbd',  'Development / fundraising'),
  ('jp@pursuit.org',               'pbd',  'Development / fundraising'),
  ('andrew@pursuit.org',           'pbd',  'Development / partnerships / grants'),
  ('trent@pursuit.org',            'pbd',  'Grants / compliance'),
  ('devika@pursuit.org',           'both', 'Jobs + PBD'),
  ('nick@pursuit.org',             'both', 'CEO — does everything'),
  ('joanna@pursuit.org',           'both', 'Leadership team'),
  ('joanna.patterson@pursuit.org', 'both', 'Leadership team'),
  ('david@pursuit.org',            'both', 'Leadership team')
ON CONFLICT (email) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock.staff_function TO bedrock_user, jobs_dev;

COMMIT;
