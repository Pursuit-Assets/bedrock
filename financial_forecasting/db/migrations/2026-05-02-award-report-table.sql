-- 2026-05-02: bedrock.award_report — scheduled reports per award.
--
-- Why a separate table (rather than just reporting_frequency on award):
-- - Real grant lifecycles have N reports with distinct due dates, statuses,
--   and submission audit trails (interim, annual, final).
-- - "3 of 4 reports submitted" only makes sense as discrete rows.
-- - A frequency string can't capture overdue vs upcoming vs done.
--
-- The award.reporting_frequency field stays as a "schedule template" — a
-- Generate-schedule action on the award page can stamp out award_report
-- rows from frequency + period_end_date.

CREATE TABLE IF NOT EXISTS bedrock.award_report (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    award_id UUID NOT NULL REFERENCES bedrock.award(id) ON DELETE CASCADE,
    due_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending',
    submitted_at TIMESTAMPTZ,
    submitted_by_email TEXT,
    notes TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT award_report_status_check
        CHECK (status IN ('Pending', 'Submitted', 'Approved', 'Skipped'))
);

CREATE INDEX IF NOT EXISTS award_report_award_id_idx
    ON bedrock.award_report(award_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS award_report_due_date_idx
    ON bedrock.award_report(due_date) WHERE deleted_at IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'award_report_set_updated_at'
    ) THEN
        CREATE TRIGGER award_report_set_updated_at
            BEFORE UPDATE ON bedrock.award_report
            FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();
    END IF;
END$$;
