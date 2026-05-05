-- 2026-04-30: introduce bedrock.award — thin lifecycle entity layered over
-- closed-won Philanthropy opportunities.
--
-- Context:
--     The redesigned Bedrock UI surfaces post-award management (status,
--     period, payment progress, linked project, tasks) as a first-class
--     concept distinct from the pipeline. Today, "won" is a Salesforce
--     Opportunity stage with no Bedrock-side lifecycle layer; reporting
--     and grant period live on bedrock.grant_requirements (nonprofit only)
--     and payments live on Salesforce. We do not duplicate any of that —
--     this table holds only the post-won lifecycle bits that don't
--     belong on Salesforce Opportunity.
--
--     1:1 with Opportunity (enforced via UNIQUE INDEX on opportunity_id
--     where deleted_at IS NULL). PBC/ISA opps are out of scope; only
--     Philanthropy RecordType awards are auto-created (enforced in the
--     backend handler, not the schema).
--
-- Related:
--     * tasks/bedrock-redesign-data-model.md — full plan
--     * services/awards_service.py (forthcoming) — auto-create handler
--     * scripts/backfill_awards.py (forthcoming) — one-shot backfill
--     * bedrock.activity gets an award_id column (separate migration)
--
-- Idempotent — safe to re-run.
--
-- Apply as bedrock owner:
--     psql "$DATABASE_URL" -f 2026-04-30-add-award-table.sql

CREATE TABLE IF NOT EXISTS bedrock.award (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    opportunity_id  TEXT NOT NULL,
    award_status    TEXT NOT NULL DEFAULT 'Active'
                    CHECK (award_status IN ('Active', 'Closing', 'Closed')),
    award_date      DATE,
    period_end_date DATE,
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    deleted_by      TEXT
);

-- Enforce 1:1 with Opportunity, ignoring soft-deleted rows so a
-- soft-deleted award doesn't block re-creation if needed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_award_opp_active
    ON bedrock.award(opportunity_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_award_not_deleted
    ON bedrock.award(id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_award_status
    ON bedrock.award(award_status)
    WHERE deleted_at IS NULL;

-- updated_at trigger — uses the existing helper installed by the project
-- migration (init.sql / 2026-* migrations).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_award_updated_at'
    ) THEN
        CREATE TRIGGER trg_award_updated_at
            BEFORE UPDATE ON bedrock.award
            FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();
    END IF;
END $$;
