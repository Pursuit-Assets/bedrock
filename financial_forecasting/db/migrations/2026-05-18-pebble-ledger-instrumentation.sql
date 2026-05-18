-- 2026-05-18: pebble_harness_log cache-aware columns + pebble_tool_call_log
--
-- Wave 0 of the Pebble L2 Research Swarm plan
-- (~/.claude/plans/glistening-crafting-matsumoto.md §4.12).
--
-- Why:
--     The plan replaces estimate-based budget enforcement with a
--     real-time ledger. The Anthropic SDK response.usage object
--     returns four token counts, not two:
--         input_tokens, output_tokens,
--         cache_creation_input_tokens, cache_read_input_tokens
--     Today pebble_harness_log only captures the first two. The
--     cache_creation tokens are priced at 1.25× the normal input
--     rate; cache_read tokens are priced at 0.10× — a 10x cost cut
--     when re-using a stable system-prompt prefix across calls.
--     Without recording them, the ledger over-reports cost on
--     cache hits and under-reports on cache creation, and the
--     cockpit's "Cache: 74%" hit-rate display is impossible.
--
--     pebble_tool_call_log captures non-LLM tool calls (FEC,
--     ProPublica, OpenCorporates HTTP fetches) which today
--     bypass ModelClient entirely and are therefore invisible
--     to the cost surface. Free APIs cost $0 USD but the count
--     and rate-limit-remaining matter for runaway detection
--     (Meta-Observer §4.4 needs tool-call counts to compute
--     "tool-call burn rate vs allocated cap").
--
--     New columns on pebble_harness_log — session_id, purpose,
--     cluster, tier, provider — let the cockpit query
--     "what did session X spend by cluster" without parsing
--     pebble_research_sessions.agents_log_json (which is
--     opaque blob today).
--
-- Related:
--     * ~/.claude/plans/glistening-crafting-matsumoto.md §4.5, §4.12
--     * pebble/model_client.py:197-201, :263-266, :279-286
--     * pebble/storage/db.py:92-141 (log_harness_outcome,
--       increment_daily_usage)
--     * pebble/harness.py:549-559 (HarnessResult.tokens_used)
--
-- Idempotent — safe to re-run. ADD COLUMN IF NOT EXISTS guards
-- against re-application.
--
-- Apply as bedrock owner:
--     psql "$DATABASE_URL" -f 2026-05-18-pebble-ledger-instrumentation.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Extend pebble_harness_log with cache-aware token columns + run context
-- ---------------------------------------------------------------------------
-- Defaults to 0 on existing rows so historical analytics don't break.
ALTER TABLE bedrock.pebble_harness_log
    ADD COLUMN IF NOT EXISTS cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS provider                    TEXT,
    ADD COLUMN IF NOT EXISTS model_id                    TEXT,
    ADD COLUMN IF NOT EXISTS session_id                  UUID,
    ADD COLUMN IF NOT EXISTS purpose                     TEXT,
    ADD COLUMN IF NOT EXISTS cluster                     TEXT,
    ADD COLUMN IF NOT EXISTS tier                        TEXT,
    ADD COLUMN IF NOT EXISTS redo_attempt                SMALLINT NOT NULL DEFAULT 0;

-- Run-level rollup queries hit this index first.
CREATE INDEX IF NOT EXISTS idx_pebble_harness_session_time
    ON bedrock.pebble_harness_log(session_id, created_at)
    WHERE session_id IS NOT NULL;

-- Cluster-level slicing for cockpit per-tile cost breakdown.
CREATE INDEX IF NOT EXISTS idx_pebble_harness_cluster_time
    ON bedrock.pebble_harness_log(cluster, created_at DESC)
    WHERE cluster IS NOT NULL;

-- Purpose-level rollup: "how much did synthesis cost across all runs today"
CREATE INDEX IF NOT EXISTS idx_pebble_harness_purpose_time
    ON bedrock.pebble_harness_log(purpose, created_at DESC)
    WHERE purpose IS NOT NULL;

COMMENT ON COLUMN bedrock.pebble_harness_log.cache_creation_input_tokens IS
    'Anthropic SDK response.usage.cache_creation_input_tokens. Priced at 1.25x normal input rate. 0 for OpenRouter / non-Anthropic providers.';
COMMENT ON COLUMN bedrock.pebble_harness_log.cache_read_input_tokens IS
    'Anthropic SDK response.usage.cache_read_input_tokens. Priced at 0.10x normal input rate. Drives the cockpit cache-hit-ratio display.';
COMMENT ON COLUMN bedrock.pebble_harness_log.session_id IS
    'The Pebble research run that owns this call. NULL for legacy rows pre-2026-05-18.';
COMMENT ON COLUMN bedrock.pebble_harness_log.purpose IS
    'Logical role of this call in the swarm: doer | verifier | probe | capacity | propensity | affinity | synthesis | meta_observer | replan | escalation | quorum.';
COMMENT ON COLUMN bedrock.pebble_harness_log.cluster IS
    'Cluster name when call originated inside one: cluster_a_financial | cluster_b_affiliations | cluster_c_public_profile | cluster_d_network | cluster_e_giving_trends | cluster_f_org_intel. NULL for orchestrator-level calls.';
COMMENT ON COLUMN bedrock.pebble_harness_log.tier IS
    'Research tier the run was committed to: T1 | T2 | T3 | T4.';
COMMENT ON COLUMN bedrock.pebble_harness_log.redo_attempt IS
    'Doer/Verifier loop iteration. 0 = fresh attempt, 1 = first redo, 2 = second redo. Caps from TierBudget.';

-- ---------------------------------------------------------------------------
-- pebble_tool_call_log — non-LLM tool calls (HTTP to FEC/ProPublica/etc.)
-- ---------------------------------------------------------------------------
-- These don't pass through ModelClient so they're missing from
-- pebble_harness_log. Meta-Observer needs the count + rate-limit
-- visibility for runaway detection; cockpit shows tool-call burn
-- vs budgeted cap per cluster. Cache hits on bedrock.pebble_api_cache
-- are marked so the cache-hit-ratio extends to data sources, not
-- just LLM calls.
CREATE TABLE IF NOT EXISTS bedrock.pebble_tool_call_log (
    id                       BIGSERIAL PRIMARY KEY,
    occurred_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Owning run.
    session_id               UUID NOT NULL,

    -- Logical tool path. e.g.:
    --   'fec.search_contributions'
    --   'propublica.download_990_xml'
    --   'opencorporates.search_officers'
    --   'sec.search_cik'
    --   'web_search.search_person'
    tool                     TEXT NOT NULL,

    -- Cluster + agent attribution. Same conventions as
    -- pebble_harness_log.cluster.
    cluster                  TEXT,
    agent_name               TEXT,

    -- $ cost. 0 for free APIs (FEC, EDGAR, USAspending, ProPublica,
    -- Federal Register, Wikipedia, FINRA). Populated for paid tiers
    -- (OpenCorporates paid plan, Serper). Drives the cockpit's
    -- "tool cost" sub-bucket.
    cost_usd                 NUMERIC NOT NULL DEFAULT 0,

    -- Execution outcome.
    success                  BOOLEAN NOT NULL,
    elapsed_ms               INTEGER NOT NULL,
    bytes_returned           INTEGER,

    -- Cache hit on bedrock.pebble_api_cache. When TRUE, cost_usd
    -- is 0 regardless of provider rate.
    cache_hit                BOOLEAN NOT NULL DEFAULT FALSE,

    -- Rate-limit budget at time of response. Lets Meta-Observer
    -- detect approaching rate-limit exhaustion (e.g. ProPublica
    -- 1-XML-per-minute).
    rate_limit_remaining     INTEGER,
    rate_limit_reset_at      TIMESTAMPTZ,

    -- Error class for failures (HTTPError, Timeout, RateLimitError, ...).
    error_class              TEXT,

    -- Audit attribution. Required.
    originating_user_email   TEXT NOT NULL,

    -- Multi-tenant outer guard (matches pebble_write_audit pattern).
    org_id                   TEXT NOT NULL DEFAULT 'pursuit'
);

-- Hot path: per-session rollup for cockpit + ledger.
CREATE INDEX IF NOT EXISTS idx_pebble_tool_session
    ON bedrock.pebble_tool_call_log(session_id, occurred_at);

-- Per-tool analytics ("ProPublica failure rate this week").
CREATE INDEX IF NOT EXISTS idx_pebble_tool_kind_time
    ON bedrock.pebble_tool_call_log(tool, occurred_at DESC);

-- Failure / rate-limit forensics.
CREATE INDEX IF NOT EXISTS idx_pebble_tool_failures
    ON bedrock.pebble_tool_call_log(occurred_at DESC)
    WHERE success = FALSE;

CREATE INDEX IF NOT EXISTS idx_pebble_tool_user_time
    ON bedrock.pebble_tool_call_log(originating_user_email, occurred_at DESC);

COMMENT ON TABLE bedrock.pebble_tool_call_log IS
    'Per-call log for non-LLM tool invocations (HTTP fetches to FEC, ProPublica, OpenCorporates, etc.). Complement to pebble_harness_log which only captures LLM calls. Append-only; retain at least 90 days for cost forensics.';
COMMENT ON COLUMN bedrock.pebble_tool_call_log.cache_hit IS
    'TRUE when the call short-circuited via bedrock.pebble_api_cache. cost_usd is 0 when TRUE regardless of provider rate.';
COMMENT ON COLUMN bedrock.pebble_tool_call_log.rate_limit_remaining IS
    'Rate-limit budget at time of response (from provider response headers). Lets Meta-Observer detect approaching exhaustion before it triggers throttling.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bedrock_user') THEN
        GRANT SELECT, INSERT ON bedrock.pebble_tool_call_log TO bedrock_user;
        GRANT USAGE, SELECT ON SEQUENCE bedrock.pebble_tool_call_log_id_seq TO bedrock_user;
        -- pebble_harness_log already has grants from init.sql; no change needed.
    END IF;
END $$;
