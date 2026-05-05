ALTER TABLE bedrock.award
  ADD COLUMN IF NOT EXISTS reporting_frequency TEXT,
  ADD COLUMN IF NOT EXISTS next_report_due DATE;
