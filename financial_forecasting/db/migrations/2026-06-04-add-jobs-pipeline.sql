-- Phase 2: Jobs Pipeline
-- Tracks employer leads through the full placement lifecycle.

CREATE TABLE IF NOT EXISTS bedrock.jobs_opportunity (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Account
    account_id          TEXT NOT NULL,          -- SF Account ID
    account_name        TEXT,                   -- denormalized for display

    -- Pipeline
    stage               TEXT NOT NULL DEFAULT 'lead_submitted',
    -- Valid stages:
    --   lead_submitted | initial_outreach
    --   active_in_discussions | active_opportunity_confirmed | active_builder_interview
    --   closed_won | closed_lost
    --   on_hold_not_selected | on_hold_not_interested | on_hold_not_responsive

    deal_type           TEXT,
    -- Valid types (set on closed_won; meaningful on others for context):
    --   ft | pt_contract | capstone | volunteer | workshop | pilot

    -- Role details
    title               TEXT,
    description         TEXT,
    salary_expected     INT,                    -- annualized, USD

    -- Outreach
    source              TEXT,
    -- staff_network | board | past_partner | reactive_posting | alumni | volunteer | other
    touch_count         INT NOT NULL DEFAULT 0,
    follow_up_date      TIMESTAMPTZ,            -- for on_hold stages

    -- People
    owner_email         TEXT,
    sf_contact_ids      TEXT[] DEFAULT '{}',    -- employer-side SF contact IDs
    builder_ids         TEXT[] DEFAULT '{}',    -- Pursuit builder/fellow IDs submitted

    -- SF promotion (set when promoted to PBC opportunity)
    sf_opportunity_id   TEXT,

    -- Airtable migration dedup
    airtable_id         TEXT UNIQUE,

    -- Timestamps
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at           TIMESTAMPTZ,

    -- Soft delete
    deleted_at          TIMESTAMPTZ,
    deleted_by          TEXT,

    CONSTRAINT jobs_opportunity_stage_check CHECK (stage IN (
        'lead_submitted', 'initial_outreach',
        'active_in_discussions', 'active_opportunity_confirmed', 'active_builder_interview',
        'closed_won', 'closed_lost',
        'on_hold_not_selected', 'on_hold_not_interested', 'on_hold_not_responsive'
    )),
    CONSTRAINT jobs_opportunity_deal_type_check CHECK (deal_type IN (
        'ft', 'pt_contract', 'capstone', 'volunteer', 'workshop', 'pilot', NULL
    ))
);

CREATE TABLE IF NOT EXISTS bedrock.jobs_stage_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id  UUID NOT NULL REFERENCES bedrock.jobs_opportunity(id) ON DELETE CASCADE,
    from_stage      TEXT,
    to_stage        TEXT NOT NULL,
    changed_by      TEXT,
    note            TEXT,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Link activity rows to a jobs opportunity
ALTER TABLE bedrock.activity
    ADD COLUMN IF NOT EXISTS jobs_opportunity_id UUID REFERENCES bedrock.jobs_opportunity(id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_jobs_opp_account     ON bedrock.jobs_opportunity(account_id);
CREATE INDEX IF NOT EXISTS idx_jobs_opp_stage        ON bedrock.jobs_opportunity(stage);
CREATE INDEX IF NOT EXISTS idx_jobs_opp_owner        ON bedrock.jobs_opportunity(owner_email);
CREATE INDEX IF NOT EXISTS idx_jobs_opp_deleted      ON bedrock.jobs_opportunity(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_stage_history_opp ON bedrock.jobs_stage_history(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_activity_jobs_opp     ON bedrock.activity(jobs_opportunity_id) WHERE jobs_opportunity_id IS NOT NULL;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION bedrock.jobs_opportunity_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_opportunity_updated_at ON bedrock.jobs_opportunity;
CREATE TRIGGER trg_jobs_opportunity_updated_at
    BEFORE UPDATE ON bedrock.jobs_opportunity
    FOR EACH ROW EXECUTE FUNCTION bedrock.jobs_opportunity_updated_at();
