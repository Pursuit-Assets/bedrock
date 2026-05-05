-- Expand award_status CHECK to include 'Did Not Fulfill'.
-- Also supports PBC, Debt/Equity, Other Fee For Service backfill.

ALTER TABLE bedrock.award
  DROP CONSTRAINT IF EXISTS award_award_status_check,
  ADD CONSTRAINT award_award_status_check
    CHECK (award_status IN ('Active', 'Closing', 'Closed', 'Did Not Fulfill'));
