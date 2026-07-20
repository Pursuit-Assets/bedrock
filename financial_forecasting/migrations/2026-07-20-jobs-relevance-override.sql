-- Human override for the jobs-relevance classifier (any staff can flip a row).
-- Metrics gate on coalesce(override, classifier verdict) — an override wins and
-- is never re-clobbered by the nightly classifier (which only fills NULLs).
ALTER TABLE bedrock.activity
  ADD COLUMN IF NOT EXISTS jobs_relevance_override text
      CHECK (jobs_relevance_override IN ('jobs','not_jobs')),
  ADD COLUMN IF NOT EXISTS jobs_relevance_override_by text,
  ADD COLUMN IF NOT EXISTS jobs_relevance_override_at timestamptz;
