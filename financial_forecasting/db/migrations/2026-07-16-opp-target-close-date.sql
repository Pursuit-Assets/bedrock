-- Opportunities need an expected-close date (the fundraising side tracks
-- Close Date on every opp; jobs opps had only follow_up_date and the actual
-- closed_at). Drives pipeline reviews and week-over-week trending.
ALTER TABLE bedrock.jobs_opportunity
  ADD COLUMN IF NOT EXISTS target_close_date date;
