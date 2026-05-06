-- 2026-05-06: bedrock.search_audit
--
-- Layer 1 / security spec §2. Every search query — Find or Ask,
-- human or service — gets one row here.
--
-- Why:
--   * Compliance / data-access reviews — every query the team
--     makes is recoverable.
--   * Click-through analytics — drives ranking-quality dashboards.
--   * Anomaly detection — exfiltration patterns ("user reading
--     every contact in an hour") are visible to the batch job
--     described in security spec §4.
--   * Debug — "user said they searched X and got Y" is
--     reconstructible.
--
-- Schema decisions (security spec §2):
--   * query_text stored full at v1.0, length-capped 256 chars at
--     the API. Default dashboards key on query_text_hash; raw
--     query_text reads gated on `manage_users_roles` and
--     themselves audited via bedrock.search_audit_access_log
--     (already shipped in 2026-05-06-pebble-write-audit.sql).
--   * 90 days hot in this table; older rows archived to GCS
--     monthly via Parquet (separate retention job).
--   * Two attribution columns: user_email is the bearer (e.g.
--     pebble@internal for service callers); originating_user_email
--     is the human whose session triggered Pebble. Both required
--     when caller is service.
--   * org_id outer guard from day 1 even though Pursuit is single
--     tenant today.
--
-- Idempotent — safe to re-run.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS bedrock.search_audit (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    occurred_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Correlation. query_id groups one query → its results → its
    -- click. request_id is the per-HTTP-call idempotency key
    -- (Phase 0.7) so a retried search query shows up as one row,
    -- not duplicates.
    query_id                    UUID NOT NULL,
    request_id                  UUID NOT NULL,

    -- Attribution.
    user_email                  CITEXT NOT NULL,            -- bearer
    originating_user_email      CITEXT,                     -- delegated principal when bearer is service:*
    org_id                      TEXT NOT NULL DEFAULT 'pursuit',

    -- The query.
    mode                        TEXT NOT NULL CHECK (mode IN ('find','ask','past_research')),
    query_text                  TEXT NOT NULL,
    query_text_hash             TEXT NOT NULL,              -- sha256; default dashboard join key
    facets                      JSONB,
    types_requested             TEXT[] DEFAULT '{}',        -- entity_type filter; empty = all

    -- Backend served.
    backend_used                TEXT NOT NULL CHECK (backend_used IN
                                  ('postgres_fts','pgvector','sf_sosl',
                                   'sf_sosl_fallback','cache_hit','degraded_empty')),
    -- Per-backend latency breakdown for SLO drill-down.
    perm_resolution_ms          INT,
    backend_latency_ms          INT,
    latency_ms                  INT NOT NULL,               -- end-to-end including auth + serialize

    -- Result set.
    result_count                INT NOT NULL,                -- visible to user
    result_count_redacted       INT,                         -- before permission redaction; >= result_count
    response_status             SMALLINT NOT NULL,
    error_class                 TEXT,                        -- ExceptionClass when status >= 400

    -- Click attribution. Updated by /api/search/click; left NULL
    -- when no click happened. NULL is itself a metric (0-click
    -- queries = poor ranking signal).
    click_position              SMALLINT,
    click_entity_type           TEXT,
    click_record_id             TEXT,
    click_at                    TIMESTAMPTZ,

    -- Cost (Ask mode only). Mirrors pebble_daily_usage shape so
    -- per-user budget enforcement reads from one source.
    cost_usd                    NUMERIC(10, 6),
    tokens_in                   INT,
    tokens_out                  INT,

    -- Replay defense via UNIQUE on request_id, mirroring the
    -- pebble_write_audit pattern. Safe across the 24h replay
    -- window.
    UNIQUE (request_id)
);

-- Per-user history (drives /api/search/history and "user X did Y" lookups).
CREATE INDEX IF NOT EXISTS idx_search_audit_user_time
    ON bedrock.search_audit(user_email, occurred_at DESC);

-- Per-originating-user history when bearer is service:*. Lets us
-- ask "what has Pebble done on Jac's behalf today?"
CREATE INDEX IF NOT EXISTS idx_search_audit_origin_time
    ON bedrock.search_audit(originating_user_email, occurred_at DESC)
    WHERE originating_user_email IS NOT NULL;

-- Hash-keyed dashboards (no PII leak).
CREATE INDEX IF NOT EXISTS idx_search_audit_qhash_time
    ON bedrock.search_audit(query_text_hash, occurred_at DESC);

-- Click correlation.
CREATE INDEX IF NOT EXISTS idx_search_audit_qid
    ON bedrock.search_audit(query_id);

-- 0-click queries (ranking-quality signal).
CREATE INDEX IF NOT EXISTS idx_search_audit_no_click
    ON bedrock.search_audit(occurred_at DESC)
    WHERE click_position IS NULL;

-- Pebble-driven activity surface.
CREATE INDEX IF NOT EXISTS idx_search_audit_pebble
    ON bedrock.search_audit(originating_user_email, occurred_at DESC)
    WHERE user_email = 'pebble@internal';

-- Errors for ops dashboards.
CREATE INDEX IF NOT EXISTS idx_search_audit_errors
    ON bedrock.search_audit(occurred_at DESC, error_class)
    WHERE response_status >= 400;

COMMENT ON TABLE bedrock.search_audit IS
    'Audit row for every search query (Phase 1.3). Populated by routes/search.py via FastAPI BackgroundTask. UNIQUE(request_id) doubles as 24h replay defense.';
COMMENT ON COLUMN bedrock.search_audit.originating_user_email IS
    'When user_email is service:* (e.g. pebble@internal), this carries the human whose session triggered the workflow. Required for service callers; null for direct human searches.';
COMMENT ON COLUMN bedrock.search_audit.result_count_redacted IS
    'Count BEFORE permission redaction. result_count_redacted >= result_count always. Delta is the leak surface — a high-delta-low-result query may indicate a permission misconfig.';

-- Grants
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bedrock_user') THEN
        GRANT SELECT, INSERT, UPDATE ON bedrock.search_audit TO bedrock_user;
        -- UPDATE granted because click attribution post-update on existing
        -- rows is the click endpoint's job (only the click_* columns).
        -- DELETE intentionally NOT granted — retention via separate role.
    END IF;
END $$;
