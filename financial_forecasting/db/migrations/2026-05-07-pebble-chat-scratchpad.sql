-- 2026-05-07: bedrock.pebble_chat_scratchpad
--
-- Externalized state for the Pebble chat orchestrator. Every step of
-- every conversation persists here: plan emission, tool calls, tool
-- results, evaluations, render, conflicts, checkpoints, errors. The
-- table is the foundation for replay, debugging, training-signal
-- extraction, and the human-visible "what is Pebble doing" plan view.
--
-- Design — see tasks/pebble-bi-architect.md "Schemas" section. Headlines:
--
--   * One row per step. Tree-shaped via parent_step_id so re-plans
--     branch (the original plan stays for forensics; the re-plan
--     hangs off the failed evaluation step's id).
--   * step_type CHECK constraint enumerates the legal step kinds —
--     same set the orchestrator emits as SSE events to the FE.
--   * tool_name + tool_args + tool_result NULL when the step isn't
--     a tool call (e.g. plan emission, evaluation).
--   * cost_usd + duration_ms drive bounded-autonomy enforcement and
--     post-run cost telemetry.
--   * org_id outermost guard from day 1. user_email is required so
--     the audit + replay surfaces don't have an "unattributed" row.
--   * Indices: (conversation_id, step_number) for replay; (user_email,
--     created_at) for "what has user X asked recently"; partial on
--     errors so the alerting query stays fast.
--
-- Idempotent.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS bedrock.pebble_chat_scratchpad (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL,
    parent_step_id  UUID,                                  -- nullable; root steps point at none
    step_number     INT NOT NULL,                          -- monotonic within conversation_id
    step_type       TEXT NOT NULL CHECK (step_type IN (
        'plan',
        'tool_call',
        'tool_result',
        'evaluation',
        'render',
        'conflict',
        'checkpoint',
        'error'
    )),

    -- Tool details. NULL for non-tool steps.
    tool_name       TEXT,
    tool_args       JSONB,
    tool_result     JSONB,

    -- Plan / evaluation details. JSONB-shaped; readers know how to
    -- interpret based on step_type.
    payload         JSONB,

    -- Resource accounting.
    cost_usd        NUMERIC(10, 6),
    duration_ms     INT,
    tokens_in       INT,
    tokens_out      INT,

    -- Attribution. user_email is the originating human (Pebble is
    -- always delegated). org_id is the multi-tenant outermost guard.
    user_email      CITEXT NOT NULL,
    org_id          TEXT NOT NULL DEFAULT 'pursuit',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replay index: walking a conversation step-by-step.
CREATE INDEX IF NOT EXISTS idx_chat_scratchpad_conv_step
    ON bedrock.pebble_chat_scratchpad(conversation_id, step_number);

-- Per-user history: drives /pebble/activity surface.
CREATE INDEX IF NOT EXISTS idx_chat_scratchpad_user_time
    ON bedrock.pebble_chat_scratchpad(user_email, created_at DESC);

-- Tree: child-step lookups when reconstructing branched re-plans.
CREATE INDEX IF NOT EXISTS idx_chat_scratchpad_parent
    ON bedrock.pebble_chat_scratchpad(parent_step_id)
    WHERE parent_step_id IS NOT NULL;

-- Errors / checkpoints: for ops dashboards + anomaly detection.
CREATE INDEX IF NOT EXISTS idx_chat_scratchpad_errors
    ON bedrock.pebble_chat_scratchpad(created_at DESC)
    WHERE step_type IN ('error', 'conflict', 'checkpoint');

-- Tool-call cost rollup: the daily-cost cap (Phase 0.4 in
-- pebble_proxy.py) reads pebble_daily_usage; the per-conversation
-- cap reads from this index.
CREATE INDEX IF NOT EXISTS idx_chat_scratchpad_conv_cost
    ON bedrock.pebble_chat_scratchpad(conversation_id, cost_usd)
    WHERE cost_usd IS NOT NULL;

COMMENT ON TABLE bedrock.pebble_chat_scratchpad IS
    'Externalized state for Pebble chat orchestrator. One row per step. Replay-able. tasks/pebble-bi-architect.md';
COMMENT ON COLUMN bedrock.pebble_chat_scratchpad.parent_step_id IS
    'NULL for root steps. Points at the parent step_id when this step is part of a re-plan or branched execution. Tree shape preserves the original failed plan for forensics.';
COMMENT ON COLUMN bedrock.pebble_chat_scratchpad.step_type IS
    'plan = planner emitted a Plan; tool_call = orchestrator invoked a tool; tool_result = tool returned; evaluation = evaluator scored a response; render = renderer composed final answer; conflict = two tool results disagreed; checkpoint = human-in-loop pause (e.g. propose_write); error = step failed with cause in payload.';

-- Grants
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bedrock_user') THEN
        GRANT SELECT, INSERT ON bedrock.pebble_chat_scratchpad TO bedrock_user;
        -- No UPDATE: scratchpad is append-only. No DELETE: retention
        -- job uses a separate role.
    END IF;
END $$;
