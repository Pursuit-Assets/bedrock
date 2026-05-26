-- 2026-05-06: bedrock.pebble_write_audit + bedrock.search_audit_access_log
--
-- Phase 0.1 + 0.7 of the Pebble 1.0 plan (tasks/pebble-search-spec.md).
--
-- Why:
--     When Pebble (or any service-to-service caller using
--     X-Internal-Key) writes through Bedrock's API, today's audit
--     trail collapses to a single synthetic user "service:pebble"
--     across logger.info lines and SF "LastModifiedById" — the
--     originating end-user is unrecoverable. Three independent
--     reviews (security/UX/architecture adversaries) flagged this
--     as a 1.0 blocker.
--
--     bedrock.pebble_write_audit captures every internal-key write
--     with the originating user, request id, route, payload hash,
--     and response status. UNIQUE(request_id) doubles as the
--     idempotency / replay-defense store for X-Request-Id (Phase
--     0.7) — a duplicate request_id within 24h yields a 409 from
--     the API rather than a duplicate write.
--
--     bedrock.search_audit_access_log captures admins reading
--     other users' search history when query_text is revealed.
--     Lives separately from the search_audit table itself so that
--     RTBF / DSAR purges of search_audit cannot also erase the
--     accountability trail of who looked at what.
--
-- Related:
--     * tasks/pebble-search-spec.md (decisions §3, §4)
--     * tasks/pebble-search-spec-security.md §1.5, §2, §10.4
--     * tasks/pebble-overhaul-plan.md §0.1, §0.7
--     * financial_forecasting/auth.py:require_auth_or_internal
--       (enforces X-Originating-User; this table receives the
--       audit row from each write route)
--
-- Idempotent — safe to re-run.
--
-- Apply as bedrock owner:
--     psql "$DATABASE_URL" -f 2026-05-06-pebble-write-audit.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS bedrock.pebble_write_audit (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    occurred_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Idempotency / replay defense. Required on every internal-key
    -- write; UNIQUE means a 24h replay returns 409 from INSERT.
    request_id                  UUID NOT NULL,

    -- Routing / classification.
    route                       TEXT NOT NULL,                   -- e.g. "/api/opportunities/update-stage"
    http_method                 TEXT NOT NULL CHECK (http_method IN
                                  ('POST', 'PUT', 'PATCH', 'DELETE')),

    -- Subject. nullable so an early-failure audit row (e.g. invalid
    -- payload) still gets written for forensics.
    sf_object_type              TEXT,                            -- 'Opportunity' | 'Account' | 'Contact' | 'Task' | 'Payment' | 'Award' | 'Project'
    sf_object_id                TEXT,

    -- Attribution. originating_user_email is the human whose
    -- session triggered the workflow; service_user is "service:pebble"
    -- (or future siblings). Both required.
    originating_user_email      CITEXT NOT NULL,
    service_user                TEXT NOT NULL DEFAULT 'service:pebble',

    -- What was sent. payload_hash = sha256 of canonical JSON; full
    -- payload kept for 90 days where the route opts in (sensitive
    -- routes pass NULL to suppress).
    payload_hash                TEXT,
    payload                     JSONB,

    -- What came back.
    response_status             SMALLINT NOT NULL,
    response_summary            JSONB,                           -- e.g. {"award_created": true, "stage": "..."}
    error_class                 TEXT,                            -- ExceptionClass name when status >= 400

    -- Side-effect attestation. ensure_for_opp + future event-bus
    -- subscribers write back here so a forensic reader can see the
    -- full chain from one INSERT (vs. correlating across 3 tables).
    side_effects                JSONB,                           -- e.g. {"award_created": true, "activity_logged": true}

    -- Latency for ops dashboards.
    latency_ms                  INT,

    -- Multi-tenant outer guard. Single value today, present so
    -- search_audit / pebble_audit share an enforcement pattern.
    org_id                      TEXT NOT NULL DEFAULT 'pursuit',

    -- Replay defense: the duplicate-request_id detector relies on this.
    UNIQUE (request_id)
);

CREATE INDEX IF NOT EXISTS idx_pebble_write_audit_user_time
    ON bedrock.pebble_write_audit(originating_user_email, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_pebble_write_audit_object
    ON bedrock.pebble_write_audit(sf_object_type, sf_object_id, occurred_at DESC)
    WHERE sf_object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pebble_write_audit_errors
    ON bedrock.pebble_write_audit(occurred_at DESC)
    WHERE response_status >= 400;
CREATE INDEX IF NOT EXISTS idx_pebble_write_audit_route_time
    ON bedrock.pebble_write_audit(route, occurred_at DESC);

COMMENT ON TABLE bedrock.pebble_write_audit IS
    'Audit row for every internal-key write through Bedrock (Phase 0.1). UNIQUE(request_id) doubles as 24h replay defense (Phase 0.7).';
COMMENT ON COLUMN bedrock.pebble_write_audit.originating_user_email IS
    'Mandatory. The human whose session triggered the workflow. Sourced from X-Originating-User header. require_auth_or_internal rejects calls without it.';
COMMENT ON COLUMN bedrock.pebble_write_audit.request_id IS
    'Mandatory. UUIDv7 from X-Request-Id header. Replay window = 24h via UNIQUE constraint; deduplicate at the route via INSERT...ON CONFLICT (request_id) DO NOTHING RETURNING id.';

-- ---------------------------------------------------------------------------
-- Admin access log for revealing search_audit.query_text
-- ---------------------------------------------------------------------------
-- search_audit itself comes in a later migration (Layer 1). This table is
-- separate so RTBF/DSAR purges of search_audit cannot also erase
-- accountability.
CREATE TABLE IF NOT EXISTS bedrock.search_audit_access_log (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    accessed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    admin_email         CITEXT NOT NULL,
    target_user_email   CITEXT NOT NULL,
    revealed_query_text BOOLEAN NOT NULL,
    reason              TEXT NOT NULL,
    request_id          UUID NOT NULL,
    org_id              TEXT NOT NULL DEFAULT 'pursuit'
);

CREATE INDEX IF NOT EXISTS idx_search_audit_access_admin
    ON bedrock.search_audit_access_log(admin_email, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_audit_access_target
    ON bedrock.search_audit_access_log(target_user_email, accessed_at DESC);

COMMENT ON TABLE bedrock.search_audit_access_log IS
    'Append-only log of admins viewing other users search history with query_text revealed. Survives RTBF purges.';

-- ---------------------------------------------------------------------------
-- Grants — bedrock_user owns these tables and writes through the API.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bedrock_user') THEN
        GRANT SELECT, INSERT ON bedrock.pebble_write_audit TO bedrock_user;
        GRANT SELECT, INSERT ON bedrock.search_audit_access_log TO bedrock_user;
        -- UPDATE intentionally NOT granted on pebble_write_audit:
        -- audit rows are append-only (immutability matters for forensics).
        -- DELETE limited to a separate retention job role, added when
        -- the 90d cleanup script lands.
    END IF;
END $$;
