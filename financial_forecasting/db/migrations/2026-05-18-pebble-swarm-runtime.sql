-- 2026-05-18: pebble_meta_alerts + pebble_research_action_idempotency
--             + pebble_scratchpad.events_jsonl
--
-- Wave 0 of the Pebble L2 Research Swarm plan
-- (~/.claude/plans/glistening-crafting-matsumoto.md §4.4, §6).
--
-- Why:
--     The Meta-Observer (§4.4) watches a research run and intervenes
--     when a team goes off the rails — stall, runaway cost,
--     verifier-rejection spike, divergence between clusters, conflict
--     spike, low-novelty churn, prompt-injection signature hits,
--     cost-cap breach. Each action (warn / throttle / abort cluster /
--     replan / halt) is a structured event the cockpit renders in
--     the "Meta-Observer feed" panel AND a row the user can review
--     post-hoc to understand why a run looked unusual.
--
--     pebble_meta_alerts persists those events. Lives separately
--     from pebble_harness_log (which is per-LLM-call) and
--     pebble_conflict_log (which is per-claim-pair) so the cockpit
--     can render a clean "what did Meta-Observer do during this
--     run" timeline without joining across three tables.
--
--     pebble_research_action_idempotency backs the abort / abort-
--     cluster / continue-to-T4 control endpoints. The endpoint
--     mints a UUIDv7 X-Request-Id; duplicate requests within 24h
--     return 409 from a no-op insert rather than re-aborting a
--     cluster that's already been re-spawned by replan or
--     re-running a T4 expansion. Same pattern as
--     pebble_write_audit's UNIQUE(request_id) replay defense.
--
--     pebble_scratchpad.events_jsonl is the append-only event log
--     that the SSE stream replays from. Today's scratchpad_json
--     column holds a single state-of-the-world blob (upserted on
--     each scratchpad.save_scratchpad call); the new events_jsonl
--     column accumulates ordered scratchpad events (cluster.start,
--     verifier.approve, claim.admit, meta.warn, ...) so a cold
--     SSE subscriber can replay from ?since_seq=0.
--
-- Related:
--     * ~/.claude/plans/glistening-crafting-matsumoto.md §4.2 (scratchpad),
--       §4.4 (meta-observer), §6 (cockpit + SSE), §10 D17-D20
--     * pebble/storage/db.py:990-1021 (save_scratchpad / update_scratchpad)
--     * tasks/pebble-adversary-security.md M3 (idempotency replay defense)
--
-- Idempotent — safe to re-run.
--
-- Apply as bedrock owner:
--     psql "$DATABASE_URL" -f 2026-05-18-pebble-swarm-runtime.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Extend pebble_scratchpad with append-only event log
-- ---------------------------------------------------------------------------
-- JSONB so the SSE replay handler can filter by event kind at the DB
-- level (`jsonb_path_query`) for ?since_seq=N catch-up. Defaults to
-- empty array so legacy rows continue to read fine.
ALTER TABLE bedrock.pebble_scratchpad
    ADD COLUMN IF NOT EXISTS events_jsonl JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS last_event_seq BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS originating_user_email TEXT,
    ADD COLUMN IF NOT EXISTS tier TEXT,
    ADD COLUMN IF NOT EXISTS run_status TEXT NOT NULL DEFAULT 'running'
        CHECK (run_status IN ('running','done','aborted','halted','failed'));

-- SSE replay queries by session_id ordered by last_event_seq.
-- The existing UNIQUE idx_pebble_sp_session(session_id) covers
-- the lookup; new index would be duplicative.

COMMENT ON COLUMN bedrock.pebble_scratchpad.events_jsonl IS
    'Append-only ordered list of ScratchpadEvent objects. SSE replay reads from here when subscriber is cold. Each event has shape: {seq, ts, kind, cluster, actor, payload}.';
COMMENT ON COLUMN bedrock.pebble_scratchpad.last_event_seq IS
    'Monotonic counter. SSE subscriber sends ?since_seq=N to resume.';
COMMENT ON COLUMN bedrock.pebble_scratchpad.run_status IS
    'Top-level run state. Distinct from status (which is the legacy free-text). Cockpit binds the status pill to this column.';

-- ---------------------------------------------------------------------------
-- pebble_meta_alerts — Meta-Observer interventions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock.pebble_meta_alerts (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    occurred_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    session_id               UUID NOT NULL,

    -- What was detected.
    alert_kind               TEXT NOT NULL CHECK (alert_kind IN (
        'stall',
        'runaway',
        'off_rails',
        'divergence',
        'conflict_spike',
        'low_novelty',
        'cost_80',
        'cost_100',
        'injection_signature',
        'global_cost_breach'
    )),

    -- What was done about it.
    severity                 TEXT NOT NULL CHECK (severity IN (
        'warn',
        'throttle',
        'abort_cluster',
        'replan',
        'halt'
    )),

    -- Cluster being acted on (null for run-level alerts like cost_100).
    cluster                  TEXT,

    -- Human-readable action description, for cockpit display.
    -- Examples:
    --   "Cluster A verifier rejection rate 60% (3/5); injected one-shot tightening hint"
    --   "Cluster B stall: no scratchpad event in 45s; aborting"
    --   "Cost 80% of TierBudget; signaling orchestrator to drop optional clusters"
    action_taken             TEXT NOT NULL,

    -- Structured detection payload for forensics + cassette tests.
    -- Examples:
    --   {"rejection_rate": 0.6, "last_5_outcomes": [...]}
    --   {"silent_seconds": 45, "last_event_seq": 47}
    --   {"cost_used_usd": 0.62, "tier_cap_usd": 0.75}
    payload_json             JSONB,

    -- Did the Meta-Observer use its $0.01 LLM budget for this decision?
    -- TRUE = ambiguous case warranted Haiku introspection.
    -- FALSE = deterministic threshold tripped.
    llm_introspection        BOOLEAN NOT NULL DEFAULT FALSE,
    llm_cost_usd             NUMERIC NOT NULL DEFAULT 0,

    -- Audit attribution. Required.
    originating_user_email   TEXT NOT NULL,

    -- Multi-tenant outer guard.
    org_id                   TEXT NOT NULL DEFAULT 'pursuit'
);

CREATE INDEX IF NOT EXISTS idx_pebble_meta_session_time
    ON bedrock.pebble_meta_alerts(session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_pebble_meta_kind_time
    ON bedrock.pebble_meta_alerts(alert_kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_pebble_meta_severity_time
    ON bedrock.pebble_meta_alerts(severity, occurred_at DESC)
    WHERE severity IN ('halt', 'abort_cluster');
CREATE INDEX IF NOT EXISTS idx_pebble_meta_user_time
    ON bedrock.pebble_meta_alerts(originating_user_email, occurred_at DESC);

COMMENT ON TABLE bedrock.pebble_meta_alerts IS
    'Meta-Observer interventions: detected anomaly + chosen action. One row per intervention. Append-only. Cockpit renders these as the "Meta-Observer feed" panel; ops dashboards aggregate by kind to spot systemic issues.';
COMMENT ON COLUMN bedrock.pebble_meta_alerts.llm_introspection IS
    'TRUE when Meta-Observer used its bounded ($0.01/run) Haiku budget to disambiguate. FALSE when a deterministic threshold tripped.';
COMMENT ON COLUMN bedrock.pebble_meta_alerts.payload_json IS
    'Structured detection details for forensics + cassette test assertions. Schema varies by alert_kind.';

-- ---------------------------------------------------------------------------
-- pebble_research_action_idempotency — abort/continue replay defense
-- ---------------------------------------------------------------------------
-- Pattern mirrors bedrock.pebble_write_audit.UNIQUE(request_id).
-- The control endpoints (abort, abort-cluster, continue-to-T4)
-- accept X-Request-Id and insert here BEFORE acting. Duplicate
-- request_id within 24h returns the prior response (cached
-- response_summary) rather than re-acting. Cleanup job (separate
-- migration when retention rules ship) prunes rows > 24h.
CREATE TABLE IF NOT EXISTS bedrock.pebble_research_action_idempotency (
    request_id               UUID PRIMARY KEY,
    occurred_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    session_id               UUID NOT NULL,
    action                   TEXT NOT NULL CHECK (action IN (
        'abort',
        'abort_cluster',
        'continue_t4',
        'pause',
        'resume'
    )),
    action_params            JSONB,

    response_status          SMALLINT NOT NULL,
    response_summary         JSONB,

    originating_user_email   TEXT NOT NULL,
    org_id                   TEXT NOT NULL DEFAULT 'pursuit'
);

CREATE INDEX IF NOT EXISTS idx_pebble_action_session_time
    ON bedrock.pebble_research_action_idempotency(session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_pebble_action_ttl
    ON bedrock.pebble_research_action_idempotency(occurred_at)
    WHERE occurred_at < now() - INTERVAL '24 hours';

COMMENT ON TABLE bedrock.pebble_research_action_idempotency IS
    'Replay defense for swarm control endpoints (abort, abort-cluster, continue-to-T4). UNIQUE(request_id) means a duplicate request returns the cached response_summary rather than re-acting. 24h retention.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bedrock_user') THEN
        GRANT SELECT, INSERT ON bedrock.pebble_meta_alerts TO bedrock_user;
        GRANT SELECT, INSERT ON bedrock.pebble_research_action_idempotency TO bedrock_user;
        -- pebble_scratchpad already has full grants from init.sql.
    END IF;
END $$;
