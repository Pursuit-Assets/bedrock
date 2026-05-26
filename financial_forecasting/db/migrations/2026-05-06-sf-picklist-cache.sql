-- 2026-05-06: bedrock.sf_picklist_cache
--
-- Phase 0.9 of the Pebble 1.0 plan. Single source of truth for
-- Salesforce picklist values (Opportunity.StageName today; extends
-- to other picklists as needed) so that the eight independent
-- locations carrying renamed stage strings (`models.py`,
-- `frontend-v2/lib/stages.ts`, `funnelStages.ts`,
-- `StageProgression.tsx`, `Cleanup.tsx`, `crm_parser.py`,
-- `opportunities_extra.py:53`, `awards_service.ELIGIBLE_STAGES_BY_RECORD_TYPE`)
-- collapse into one fetch.
--
-- Why:
--     Per `feedback_sf_stages_sacred.md`: SF stages are sacred —
--     never hide/deprecate/reclassify them on the SF side. But
--     stages DO get renamed on the SF side (commit 58c360e was
--     "rename SF stages to match new picklist labels"), and when
--     they do, eight files in the Bedrock codebase need
--     hand-edits.  This cache is the canonical Bedrock-side
--     reflection of what's in SF — one fetch, everyone uses it.
--
-- Design:
--     One row per (object, picklist_field, record_type, value).
--     `record_type` is nullable — when null, the value is
--     available across all record types. Refreshed nightly via a
--     background job calling SF describeSObject. 24h TTL on
--     `services/sf_stages.py` reads.
--
-- Related:
--     * tasks/pebble-search-spec.md decision §6 (multi-tenant column)
--     * tasks/pebble-overhaul-plan.md §0.9
--     * services/sf_stages.py (next file)
--     * project_stage_schema_drift memory (eight-location problem)
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS bedrock.sf_picklist_cache (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Composite identity
    sf_object       TEXT NOT NULL,                   -- 'Opportunity' | 'Account' | ...
    field_name      TEXT NOT NULL,                   -- 'StageName' | 'Type' | ...
    record_type     TEXT,                            -- 'Philanthropy' | NULL = all
    value           TEXT NOT NULL,                   -- the actual SF picklist value

    -- Display + ordering. Mirror of SF metadata so we don't
    -- per-page-fetch. Order is important — the funnel display in
    -- frontend-v2/lib/funnelStages.ts encodes a left-to-right
    -- progression.
    label           TEXT NOT NULL,
    sort_order      INT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,

    -- Bucket annotations. Reporting semantics live as buckets ON
    -- TOP of stages — never replacing them. Encoded as a string
    -- array so we can have e.g.
    -- ['REVENUE_EARNING','OPEN_PIPELINE'] without joining a
    -- second table. The `bedrock` Python service exposes these
    -- as Set<str> to match the F1 buckets PR #134 contract.
    buckets         TEXT[] NOT NULL DEFAULT '{}',

    -- Probability for forecast math. Mirrors `models.py` static
    -- table; live picklist values without an entry default to
    -- the median bucket prob.
    probability     SMALLINT,

    -- Sync metadata. Used by `services/sf_stages.py` cache to
    -- decide refresh urgency.
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    refresh_after   TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),

    -- Multi-tenant outer guard.
    org_id          TEXT NOT NULL DEFAULT 'pursuit',

    UNIQUE (org_id, sf_object, field_name, record_type, value)
);

CREATE INDEX IF NOT EXISTS idx_sf_picklist_cache_lookup
    ON bedrock.sf_picklist_cache(sf_object, field_name, record_type, sort_order)
    WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_sf_picklist_cache_buckets
    ON bedrock.sf_picklist_cache USING GIN (buckets);
CREATE INDEX IF NOT EXISTS idx_sf_picklist_cache_stale
    ON bedrock.sf_picklist_cache(refresh_after)
    WHERE is_active = TRUE;

COMMENT ON TABLE bedrock.sf_picklist_cache IS
    'Canonical Bedrock-side reflection of Salesforce picklist values. services/sf_stages.py is the read API. Refreshed via nightly background job.';
COMMENT ON COLUMN bedrock.sf_picklist_cache.buckets IS
    'Reporting bucket annotations on top of SF stages. Examples: {"REVENUE_EARNING","OPEN_PIPELINE"}. Buckets layer on top of stages — never replace them.';
COMMENT ON COLUMN bedrock.sf_picklist_cache.record_type IS
    'NULL means "applies to all record types". Mirrors how SF stores per-RecordType picklist subset rules.';

-- Grants
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bedrock_user') THEN
        GRANT SELECT, INSERT, UPDATE ON bedrock.sf_picklist_cache TO bedrock_user;
    END IF;
END $$;
