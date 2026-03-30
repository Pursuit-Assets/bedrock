-- Projects schema — idempotent (safe to re-run)
-- All tables live in the bedrock schema on segundo-db

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- Schema must already exist on segundo-db (owned by postgres, bedrock_user has CREATE + USAGE)
-- For local dev: CREATE SCHEMA IF NOT EXISTS bedrock;
DO $$ BEGIN
    CREATE SCHEMA IF NOT EXISTS bedrock;
EXCEPTION
    WHEN insufficient_privilege THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bedrock.project (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bedrock.workstream (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id  UUID NOT NULL REFERENCES bedrock.project(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bedrock.milestone (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workstream_id UUID NOT NULL REFERENCES bedrock.workstream(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'On Track'
                  CHECK (status IN ('On Track', 'At Risk', 'Needs Attention', 'Completed')),
    priority      TEXT NOT NULL DEFAULT 'Now'
                  CHECK (priority IN ('Now', 'Later', 'On-going')),
    owner         TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    source_links  TEXT[] NOT NULL DEFAULT '{}',
    sort_order    INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bedrock.project_task (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    milestone_id  UUID NOT NULL REFERENCES bedrock.milestone(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'Not Started'
                  CHECK (status IN ('Not Started', 'In Progress', 'Completed', 'Blocked', 'On Hold')),
    owner         TEXT NOT NULL DEFAULT '',
    deadline      DATE,
    description   TEXT NOT NULL DEFAULT '',
    updates       TEXT NOT NULL DEFAULT '',
    links         TEXT[] NOT NULL DEFAULT '{}',
    depends_on    UUID[] NOT NULL DEFAULT '{}',
    sort_order    INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add start_date for Gantt chart support (idempotent)
DO $$ BEGIN
    ALTER TABLE bedrock.project_task ADD COLUMN start_date DATE;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Soft-delete columns for project hierarchy (M18 — data loss prevention)
-- Pattern: proven in bedrock.activity (see line ~403)
-- ---------------------------------------------------------------------------
DO $$ BEGIN ALTER TABLE bedrock.project ADD COLUMN deleted_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE bedrock.project ADD COLUMN deleted_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE bedrock.workstream ADD COLUMN deleted_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE bedrock.workstream ADD COLUMN deleted_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE bedrock.milestone ADD COLUMN deleted_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE bedrock.milestone ADD COLUMN deleted_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE bedrock.project_task ADD COLUMN deleted_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE bedrock.project_task ADD COLUMN deleted_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Partial indexes for soft-delete filtering (follows activity pattern, line ~420)
CREATE INDEX IF NOT EXISTS idx_project_not_deleted ON bedrock.project(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workstream_not_deleted ON bedrock.workstream(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_milestone_not_deleted ON bedrock.milestone(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_project_task_not_deleted ON bedrock.project_task(deleted_at) WHERE deleted_at IS NULL;

-- Updated-at trigger
CREATE OR REPLACE FUNCTION bedrock.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
    FOR t IN SELECT unnest(ARRAY['project', 'workstream', 'milestone', 'project_task'])
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%s_updated_at ON bedrock.%I; '
            'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON bedrock.%I '
            'FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();',
            t, t, t, t
        );
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Salesforce Task Dependencies (local storage — SF has no native dependency support)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock.sf_task_dependency (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id         TEXT NOT NULL,
    depends_on_id   TEXT NOT NULL,
    external_source TEXT NOT NULL DEFAULT 'salesforce',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (task_id, depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_sf_dep_task ON bedrock.sf_task_dependency(task_id);
CREATE INDEX IF NOT EXISTS idx_sf_dep_depends ON bedrock.sf_task_dependency(depends_on_id);

COMMENT ON TABLE bedrock.sf_task_dependency IS
  'Stores dependency edges between external CRM tasks. Salesforce Task objects '
  'have no native dependency support, so this is stored locally. '
  'Migration note: when moving off Salesforce, convert these edges to '
  'project_task.depends_on UUID arrays (the native project task dependency model).';

-- ---------------------------------------------------------------------------
-- Salesforce Task ↔ Project Bridge (local link — SF tasks appear in Project views)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock.sf_task_project (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sf_task_id      TEXT NOT NULL,
    external_source TEXT NOT NULL DEFAULT 'salesforce',
    project_id      UUID NOT NULL REFERENCES bedrock.project(id) ON DELETE CASCADE,
    milestone_id    UUID REFERENCES bedrock.milestone(id) ON DELETE SET NULL,
    sort_order      INT DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (sf_task_id)
);
CREATE INDEX IF NOT EXISTS idx_stp_project ON bedrock.sf_task_project(project_id);
CREATE INDEX IF NOT EXISTS idx_stp_source ON bedrock.sf_task_project(external_source);

COMMENT ON TABLE bedrock.sf_task_project IS
  'Bridge table linking external CRM tasks (currently Salesforce) to local projects. '
  'This is the critical coupling point between the external CRM and local project management. '
  'When migrating off Salesforce: (1) sf_task_id maps to the external Task ID, '
  '(2) external_source identifies which CRM system the task came from, '
  '(3) all task data lives in the CRM — this table only stores the relationship. '
  'Migration path: create project_task rows from CRM data, then drop this table.';

COMMENT ON COLUMN bedrock.sf_task_project.sf_task_id IS
  'External CRM task identifier. Salesforce format: 00T + 12/15 alphanumeric chars. '
  'Stored as TEXT to accommodate any CRM ID format after migration.';

COMMENT ON COLUMN bedrock.sf_task_project.external_source IS
  'CRM system this task originates from. Currently always "salesforce". '
  'Added for forward-compatibility when migrating to a different CRM.';

-- Add opportunity_id to project table for opportunity-based projects
DO $$ BEGIN
    ALTER TABLE bedrock.project ADD COLUMN opportunity_id TEXT;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Project ↔ Opportunity many-to-many junction
-- Supports multi-Opportunity campaigns and cross-Opportunity dependencies
-- (e.g., Amazon funding contingent on Google commitment)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock.project_opportunity (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES bedrock.project(id) ON DELETE CASCADE,
    opportunity_id  TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'linked',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_po_project ON bedrock.project_opportunity(project_id);
CREATE INDEX IF NOT EXISTS idx_po_opp ON bedrock.project_opportunity(opportunity_id);

COMMENT ON TABLE bedrock.project_opportunity IS
  'Many-to-many link between local Projects and CRM Opportunities. '
  'Supports multi-Opportunity campaigns (e.g., donor dependencies across Opps). '
  'opportunity_id is TEXT to accommodate Salesforce IDs now and any CRM ID format later. '
  'Migration note: replaces the singular project.opportunity_id column for new usage.';

-- ---------------------------------------------------------------------------
-- Permission Profiles & User Roles
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bedrock.permission_profile (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    is_default  BOOLEAN DEFAULT false,
    permissions JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bedrock.app_user (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sf_user_id  TEXT UNIQUE,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT DEFAULT '',
    profile_id  UUID REFERENCES bedrock.permission_profile(id) ON DELETE SET NULL,
    is_active   BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bedrock.opportunity_lock (
    sf_opportunity_id TEXT PRIMARY KEY,
    locked_by         TEXT NOT NULL,
    locked_at         TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_opp_lock_locked_by ON bedrock.opportunity_lock(locked_by);

-- Seed permission profiles (idempotent via ON CONFLICT)
INSERT INTO bedrock.permission_profile (name, description, is_default, permissions)
VALUES (
    'Admin',
    'Full access to all features',
    false,
    '{
        "view_opportunities": true,
        "edit_own_opportunities": true,
        "edit_all_opportunities": true,
        "create_opportunities": true,
        "bulk_update_opportunities": true,
        "lock_own_opportunities": true,
        "reassign_opportunities": true,
        "view_tasks": true,
        "edit_own_tasks": true,
        "edit_all_tasks": true,
        "create_tasks": true,
        "view_revenue_dashboard": true,
        "view_cashflow_forecasts": true,
        "view_sage_invoices_payments": true,
        "create_sage_invoices": true,
        "match_invoices": true,
        "manage_payment_schedules": true,
        "generate_financial_reports": true,
        "trigger_data_sync": true,
        "manage_users_roles": true
    }'::jsonb
) ON CONFLICT (name) DO NOTHING;

INSERT INTO bedrock.permission_profile (name, description, is_default, permissions)
VALUES (
    'Fundraiser',
    'Standard fundraiser access — own opportunities and tasks, no financial writes',
    true,
    '{
        "view_opportunities": true,
        "edit_own_opportunities": true,
        "edit_all_opportunities": false,
        "create_opportunities": true,
        "bulk_update_opportunities": false,
        "lock_own_opportunities": true,
        "reassign_opportunities": true,
        "view_tasks": true,
        "edit_own_tasks": true,
        "edit_all_tasks": false,
        "create_tasks": true,
        "view_revenue_dashboard": true,
        "view_cashflow_forecasts": true,
        "view_sage_invoices_payments": false,
        "create_sage_invoices": false,
        "match_invoices": false,
        "manage_payment_schedules": false,
        "generate_financial_reports": false,
        "trigger_data_sync": false,
        "manage_users_roles": false
    }'::jsonb
) ON CONFLICT (name) DO NOTHING;

INSERT INTO bedrock.permission_profile (name, description, is_default, permissions)
VALUES (
    'Manager',
    'Full CRM access — edit and reassign all opportunities, manage all tasks, view financials',
    false,
    '{
        "view_opportunities": true,
        "edit_own_opportunities": true,
        "edit_all_opportunities": true,
        "create_opportunities": true,
        "bulk_update_opportunities": true,
        "lock_own_opportunities": true,
        "reassign_opportunities": true,
        "view_tasks": true,
        "edit_own_tasks": true,
        "edit_all_tasks": true,
        "create_tasks": true,
        "view_revenue_dashboard": true,
        "view_cashflow_forecasts": true,
        "view_sage_invoices_payments": true,
        "create_sage_invoices": false,
        "match_invoices": false,
        "manage_payment_schedules": false,
        "generate_financial_reports": true,
        "trigger_data_sync": false,
        "manage_users_roles": false,
        "use_pebble_chat": true
    }'::jsonb
) ON CONFLICT (name) DO NOTHING;

-- Backfill: add reassign_opportunities to existing profiles that lack it
UPDATE bedrock.permission_profile
SET permissions = permissions || '{"reassign_opportunities": true}'::jsonb
WHERE NOT (permissions ? 'reassign_opportunities');

-- Backfill: add Account/Contact/Payment permissions to existing profiles
-- Fundraisers: Account/Contact edit yes, Payment edit no (finance-sensitive)
UPDATE bedrock.permission_profile
SET permissions = permissions || '{
    "edit_accounts": true, "create_accounts": true,
    "edit_contacts": true, "create_contacts": true,
    "edit_payments": false, "create_payments": false
}'::jsonb
WHERE name = 'Fundraiser' AND NOT (permissions ? 'edit_accounts');

-- Manager: full CRM access including payments
UPDATE bedrock.permission_profile
SET permissions = permissions || '{
    "edit_accounts": true, "create_accounts": true,
    "edit_contacts": true, "create_contacts": true,
    "edit_payments": true, "create_payments": true
}'::jsonb
WHERE name = 'Manager' AND NOT (permissions ? 'edit_accounts');

-- Admin: auto-granted via code (permissions.py line 61-65), but explicit for DB clarity
UPDATE bedrock.permission_profile
SET permissions = permissions || '{
    "edit_accounts": true, "create_accounts": true,
    "edit_contacts": true, "create_contacts": true,
    "edit_payments": true, "create_payments": true
}'::jsonb
WHERE name = 'Admin' AND NOT (permissions ? 'edit_accounts');

-- Backfill: add Pebble research + CRM write permissions to existing profiles
-- Admin: full Pebble access (chat auto-granted via code, research + write explicit)
UPDATE bedrock.permission_profile
SET permissions = permissions || '{"use_pebble_research": true, "pebble_crm_write": true}'::jsonb
WHERE name = 'Admin' AND NOT (permissions ? 'use_pebble_research');

-- Manager: research yes, CRM write no (admin-only for now)
UPDATE bedrock.permission_profile
SET permissions = permissions || '{"use_pebble_research": true, "pebble_crm_write": false}'::jsonb
WHERE name = 'Manager' AND NOT (permissions ? 'use_pebble_research');

-- Fundraiser: no Pebble access by default
UPDATE bedrock.permission_profile
SET permissions = permissions || '{"use_pebble_research": false, "pebble_crm_write": false}'::jsonb
WHERE name = 'Fundraiser' AND NOT (permissions ? 'use_pebble_research');

-- ---------------------------------------------------------------------------
-- Activities (synced from SF Tasks + Events, plus manual/extension entries)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bedrock.activity (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Salesforce identifiers (for mirror sync)
    sf_id TEXT UNIQUE,
    sf_type TEXT CHECK (sf_type IN ('Task', 'Event')),

    -- Core fields
    type TEXT NOT NULL CHECK (type IN ('call', 'email', 'meeting', 'note', 'slack-message', 'calendar-event')),
    subject TEXT NOT NULL,
    description TEXT,
    description_html TEXT,
    activity_date TIMESTAMPTZ NOT NULL,

    -- Association (Opportunity-first model)
    opportunity_id TEXT,
    account_id TEXT,
    contact_ids TEXT[] DEFAULT '{}',
    project_task_id UUID REFERENCES bedrock.project_task(id) ON DELETE SET NULL,
    sf_task_id TEXT,

    -- Source tracking
    source TEXT NOT NULL CHECK (source IN ('salesforce', 'extension', 'manual', 'gmail-sync', 'calendar-sync')),
    source_ref TEXT,
    source_thread_id TEXT,

    -- Email-specific fields
    email_from TEXT,
    email_to TEXT[],
    email_cc TEXT[],
    email_snippet TEXT,

    -- Meeting-specific fields
    meeting_duration_minutes INTEGER,
    meeting_attendees JSONB,
    meeting_location TEXT,

    -- Attachments (GCS URLs — populated by extension in M15)
    attachments JSONB DEFAULT '[]',

    -- Ownership
    logged_by TEXT,
    owner_id TEXT,

    -- Sync metadata
    sf_last_modified TIMESTAMPTZ,
    synced_at TIMESTAMPTZ,
    sf_sync_status TEXT DEFAULT 'synced' CHECK (sf_sync_status IN ('synced', 'pending', 'failed')),

    -- Full-text search
    search_vector TSVECTOR,

    -- Soft delete (required: prevents sync resurrection of deleted records)
    deleted_at TIMESTAMPTZ,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Activity indexes
CREATE INDEX IF NOT EXISTS idx_activity_opportunity ON bedrock.activity(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_activity_account ON bedrock.activity(account_id);
CREATE INDEX IF NOT EXISTS idx_activity_contact ON bedrock.activity USING GIN(contact_ids);
CREATE INDEX IF NOT EXISTS idx_activity_date ON bedrock.activity(activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_activity_type ON bedrock.activity(type);
CREATE INDEX IF NOT EXISTS idx_activity_source ON bedrock.activity(source);
CREATE INDEX IF NOT EXISTS idx_activity_sf_id ON bedrock.activity(sf_id);
CREATE INDEX IF NOT EXISTS idx_activity_search ON bedrock.activity USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_activity_thread ON bedrock.activity(source_thread_id);
CREATE INDEX IF NOT EXISTS idx_activity_not_deleted ON bedrock.activity(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activity_project_task ON bedrock.activity(project_task_id);

-- Full-text search trigger (subject=A weight, snippet=B, description=C)
CREATE OR REPLACE FUNCTION bedrock.activity_search_vector_update() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.subject, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.email_snippet, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_activity_search_vector ON bedrock.activity;
CREATE TRIGGER trg_activity_search_vector
    BEFORE INSERT OR UPDATE ON bedrock.activity
    FOR EACH ROW EXECUTE FUNCTION bedrock.activity_search_vector_update();

-- Activity updated_at trigger (reuses bedrock.set_updated_at)
DROP TRIGGER IF EXISTS trg_activity_updated_at ON bedrock.activity;
CREATE TRIGGER trg_activity_updated_at
    BEFORE UPDATE ON bedrock.activity
    FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();

-- ---------------------------------------------------------------------------
-- Pebble Tables (research pipeline, chat, batches, conflict tracking)
-- All use pebble_ prefix, no FK contamination with SF data
-- ---------------------------------------------------------------------------

-- Final research output per contact
CREATE TABLE IF NOT EXISTS bedrock.pebble_profiles (
    contact_id  TEXT PRIMARY KEY,
    profile_json TEXT,
    cost_usd    NUMERIC,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- One row per completed research run
CREATE TABLE IF NOT EXISTS bedrock.pebble_research_sessions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contact_id    TEXT,
    profile_json  TEXT,
    cost_usd      NUMERIC,
    prospect_name TEXT,
    prospect_org  TEXT,
    status          TEXT DEFAULT 'completed',
    tier            TEXT,
    agents_log_json TEXT,
    batch_id        TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pebble_rs_contact ON bedrock.pebble_research_sessions(contact_id);

-- Claim accuracy tracking
CREATE TABLE IF NOT EXISTS bedrock.pebble_feedback (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id    TEXT,
    correct     BOOLEAN,
    text        TEXT,
    contact_id  TEXT,
    user_id     TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- Agent execution metrics
CREATE TABLE IF NOT EXISTS bedrock.pebble_harness_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_name      TEXT,
    outcome         TEXT,
    cost_usd        NUMERIC,
    tokens_input    INTEGER,
    tokens_output   INTEGER,
    attempts        INTEGER,
    elapsed_seconds NUMERIC,
    error           TEXT,
    prospect_id     TEXT,
    user_email      TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Stigmergy pheromone trail
CREATE TABLE IF NOT EXISTS bedrock.pebble_source_scores (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_name     TEXT,
    richness_score  NUMERIC,
    prospect_id     TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Response deduplication with TTL
CREATE TABLE IF NOT EXISTS bedrock.pebble_api_cache (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source          TEXT,
    lookup_key      TEXT,
    response_json   TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    UNIQUE (source, lookup_key)
);

-- Ask Pebble chat sessions
CREATE TABLE IF NOT EXISTS bedrock.pebble_chat_conversations (
    id              UUID PRIMARY KEY,
    user_email      TEXT,
    title           TEXT,
    total_cost_usd  NUMERIC DEFAULT 0.0,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Chat message history
CREATE TABLE IF NOT EXISTS bedrock.pebble_chat_messages (
    id              UUID PRIMARY KEY,
    conversation_id UUID REFERENCES bedrock.pebble_chat_conversations(id),
    role            TEXT,
    content         TEXT,
    tier            TEXT,
    cost_usd        NUMERIC DEFAULT 0.0,
    metadata_json   TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pebble_cm_conv ON bedrock.pebble_chat_messages(conversation_id);

-- Bulk research jobs
CREATE TABLE IF NOT EXISTS bedrock.pebble_research_batches (
    id                    UUID PRIMARY KEY,
    user_email            TEXT,
    total_prospects       INTEGER DEFAULT 0,
    completed_prospects   INTEGER DEFAULT 0,
    target_tier           TEXT DEFAULT 'T1',
    status                TEXT DEFAULT 'pending',
    total_cost_usd        NUMERIC DEFAULT 0.0,
    created_at            TIMESTAMPTZ DEFAULT now(),
    updated_at            TIMESTAMPTZ DEFAULT now()
);

-- Individual prospects in a batch
CREATE TABLE IF NOT EXISTS bedrock.pebble_batch_prospects (
    id                    UUID PRIMARY KEY,
    batch_id              UUID REFERENCES bedrock.pebble_research_batches(id),
    prospect_name         TEXT,
    prospect_org          TEXT,
    current_tier          TEXT DEFAULT 'pending',
    identity_confidence   TEXT DEFAULT 'none',
    crm_status            TEXT DEFAULT 'unknown',
    result_json           TEXT,
    cost_usd              NUMERIC DEFAULT 0.0,
    created_at            TIMESTAMPTZ DEFAULT now(),
    updated_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pebble_bp_batch ON bedrock.pebble_batch_prospects(batch_id);

-- Persist detected conflicts
CREATE TABLE IF NOT EXISTS bedrock.pebble_conflict_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      UUID REFERENCES bedrock.pebble_research_sessions(id),
    contact_id      TEXT,
    conflict_type   TEXT,
    claim_a         TEXT,
    claim_b         TEXT,
    description     TEXT,
    resolution      TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pebble_cl_session ON bedrock.pebble_conflict_log(session_id);

-- Persist intermediate research state
CREATE TABLE IF NOT EXISTS bedrock.pebble_scratchpad (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      UUID REFERENCES bedrock.pebble_research_sessions(id),
    contact_id      TEXT,
    scratchpad_json TEXT,
    status          TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);
-- M17: upgrade to UNIQUE for ON CONFLICT support in save_scratchpad()
DROP INDEX IF EXISTS bedrock.idx_pebble_sp_session;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pebble_sp_session ON bedrock.pebble_scratchpad(session_id);

-- Per-user daily cost tracking (M12 — Pebble access control)
CREATE TABLE IF NOT EXISTS bedrock.pebble_daily_usage (
    user_email  TEXT NOT NULL,
    date        DATE NOT NULL,
    total_cost_usd NUMERIC DEFAULT 0.0,
    query_count INTEGER DEFAULT 0,
    updated_at  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_email, date)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- M17: SF Field Requirements + Prospect CRM Mapping (absorbs M14)
-- ─────────────────────────────────────────────────────────────────────────────

-- Reference table: SF field metadata from describe() audit
CREATE TABLE IF NOT EXISTS bedrock.sf_field_requirements (
    id              SERIAL PRIMARY KEY,
    sobject         TEXT NOT NULL,
    field_name      TEXT NOT NULL,
    field_label     TEXT,
    field_type      TEXT,
    is_required     BOOLEAN DEFAULT FALSE,
    has_default     BOOLEAN DEFAULT FALSE,
    default_value   TEXT,
    is_updateable   BOOLEAN DEFAULT TRUE,
    pebble_source_tier TEXT,
    notes           TEXT,
    last_verified_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(sobject, field_name)
);
CREATE INDEX IF NOT EXISTS idx_sf_field_req_sobject
    ON bedrock.sf_field_requirements(sobject);

-- Prospect → SF Contact mapping (typed columns, all nullable for soft enforcement)
CREATE TABLE IF NOT EXISTS bedrock.prospect_sf_contact (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    prospect_id         UUID NOT NULL REFERENCES bedrock.pebble_batch_prospects(id) ON DELETE CASCADE,
    last_name           TEXT,
    first_name          TEXT,
    title               TEXT,
    email               TEXT,
    phone               TEXT,
    department          TEXT,
    lead_source         TEXT,
    linkedin_url        TEXT,
    mailing_street      TEXT,
    mailing_city        TEXT,
    mailing_state       TEXT,
    mailing_postal_code TEXT,
    philanthropic_contact BOOLEAN,
    philanthropy        BOOLEAN,
    volunteer           BOOLEAN,
    notes               TEXT,
    sources             TEXT[],
    last_enriched_tier  TEXT,
    last_enriched_at    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),
    UNIQUE(prospect_id)
);
CREATE INDEX IF NOT EXISTS idx_prospect_sf_contact_prospect
    ON bedrock.prospect_sf_contact(prospect_id);

-- Prospect → SF Account mapping
CREATE TABLE IF NOT EXISTS bedrock.prospect_sf_account (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    prospect_id         UUID NOT NULL REFERENCES bedrock.pebble_batch_prospects(id) ON DELETE CASCADE,
    name                TEXT,
    account_type        TEXT,
    industry            TEXT,
    website             TEXT,
    phone               TEXT,
    grantmaker          BOOLEAN,
    philanthropy        BOOLEAN,
    fee_for_service     BOOLEAN,
    annual_revenue      NUMERIC,
    funding_focus       TEXT,
    notes               TEXT,
    sources             TEXT[],
    last_enriched_tier  TEXT,
    last_enriched_at    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),
    UNIQUE(prospect_id)
);
CREATE INDEX IF NOT EXISTS idx_prospect_sf_account_prospect
    ON bedrock.prospect_sf_account(prospect_id);

-- Prospect → SF Opportunity hints (research-derived suggestions)
CREATE TABLE IF NOT EXISTS bedrock.prospect_sf_opportunity (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    prospect_id             UUID NOT NULL REFERENCES bedrock.pebble_batch_prospects(id) ON DELETE CASCADE,
    suggested_name          TEXT,
    suggested_amount        NUMERIC,
    suggested_stage         TEXT DEFAULT 'Lead Gen',
    suggested_close_date    DATE,
    suggested_record_type   TEXT,
    giving_capacity_estimate NUMERIC,
    past_giving_history     TEXT,
    wealth_indicators       TEXT,
    notes                   TEXT,
    sources                 TEXT[],
    last_enriched_tier      TEXT,
    last_enriched_at        TIMESTAMPTZ,
    created_at              TIMESTAMPTZ DEFAULT now(),
    updated_at              TIMESTAMPTZ DEFAULT now(),
    UNIQUE(prospect_id)
);
CREATE INDEX IF NOT EXISTS idx_prospect_sf_opp_prospect
    ON bedrock.prospect_sf_opportunity(prospect_id);

-- Schema drift detection log (HITL review for SF field changes)
CREATE TABLE IF NOT EXISTS bedrock.sf_schema_drift_log (
    id              SERIAL PRIMARY KEY,
    sobject         TEXT NOT NULL,
    field_name      TEXT NOT NULL,
    drift_type      TEXT NOT NULL,
    old_value       TEXT,
    new_value       TEXT,
    detected_at     TIMESTAMPTZ DEFAULT now(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     TEXT,
    action_taken    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sf_drift_unresolved
    ON bedrock.sf_schema_drift_log(resolved_at) WHERE resolved_at IS NULL;

-- Seed sf_field_requirements with describe() audit data (2026-03-30)
-- Non-boolean required fields (nillable=false, updateable=true, type!=boolean)
INSERT INTO bedrock.sf_field_requirements (sobject, field_name, field_label, field_type, is_required, has_default, is_updateable, pebble_source_tier, notes)
VALUES
    -- Opportunity: required
    ('Opportunity', 'Name',      'Name',       'string',    TRUE,  FALSE, TRUE, NULL,  'User-provided on create/edit'),
    ('Opportunity', 'StageName', 'Stage',      'picklist',  TRUE,  FALSE, TRUE, NULL,  'User-selected stage in pipeline'),
    ('Opportunity', 'CloseDate', 'Close Date', 'date',      TRUE,  FALSE, TRUE, NULL,  'User-provided expected close date'),
    ('Opportunity', 'OwnerId',   'Owner ID',   'reference', TRUE,  FALSE, TRUE, NULL,  'Auto-populated with current user'),
    -- Opportunity: key optional (Pebble can inform)
    ('Opportunity', 'Amount',       'Amount',        'currency',  FALSE, FALSE, TRUE, 'T2', 'Pebble giving capacity estimate'),
    ('Opportunity', 'AccountId',    'Account ID',    'reference', FALSE, FALSE, TRUE, 'T1', 'Linked via prospect org match'),
    ('Opportunity', 'Description',  'Description',   'textarea',  FALSE, FALSE, TRUE, 'T3', 'Pebble research summary'),
    ('Opportunity', 'Type',         'Type',          'picklist',  FALSE, FALSE, TRUE, NULL,  'User-selected'),
    ('Opportunity', 'Probability',  'Probability',   'percent',   FALSE, FALSE, TRUE, NULL,  'Auto-set from stage'),
    -- Contact: required
    ('Contact', 'LastName', 'Last Name', 'string',    TRUE,  FALSE, TRUE, 'T1', 'Extracted from prospect name'),
    ('Contact', 'OwnerId',  'Owner ID', 'reference', TRUE,  FALSE, TRUE, NULL,  'Auto-populated'),
    -- Contact: key optional (Pebble populates)
    ('Contact', 'FirstName',                      'First Name',           'string',    FALSE, FALSE, TRUE, 'T1', 'Extracted from prospect name'),
    ('Contact', 'Title',                          'Title',                'string',    FALSE, FALSE, TRUE, 'T1', 'From identity card or Wikipedia'),
    ('Contact', 'Email',                          'Email',                'email',     FALSE, FALSE, TRUE, 'T1', 'From CRM match or web search'),
    ('Contact', 'Phone',                          'Phone',                'phone',     FALSE, FALSE, TRUE, 'T2', 'From enrichment sources'),
    ('Contact', 'Department',                     'Department',           'string',    FALSE, FALSE, TRUE, 'T2', 'From affiliations dimension'),
    ('Contact', 'npsp__Primary_Affiliation__c',   'Primary Affiliation', 'reference', FALSE, FALSE, TRUE, 'T1', 'Account ID from org match'),
    ('Contact', 'LinkedIn_URL__c',                'LinkedIn URL',         'url',       FALSE, FALSE, TRUE, 'T2', 'From web search'),
    ('Contact', 'LeadSource',                     'Lead Source',          'picklist',  FALSE, FALSE, TRUE, NULL,  'User-selected'),
    ('Contact', 'Philanthropic_Contact__c',       'Philanthropic Contact','boolean',   FALSE, TRUE,  TRUE, 'T3', 'From philanthropy forager'),
    ('Contact', 'Philanthropy__c',                'Philanthropy',         'boolean',   FALSE, TRUE,  TRUE, 'T3', 'From philanthropy forager'),
    ('Contact', 'Volunteer__c',                   'Volunteer',            'boolean',   FALSE, TRUE,  TRUE, NULL,  'User-set'),
    -- Account: required
    ('Account', 'Name',    'Account Name', 'string',    TRUE,  FALSE, TRUE, 'T1', 'From prospect org name'),
    ('Account', 'OwnerId', 'Owner ID',    'reference', TRUE,  FALSE, TRUE, NULL,  'Auto-populated'),
    -- Account: key optional (Pebble populates)
    ('Account', 'Type',                    'Account Type',     'picklist', FALSE, FALSE, TRUE, 'T2', 'From OpenCorporates or Wikipedia'),
    ('Account', 'Industry',                'Industry',         'picklist', FALSE, FALSE, TRUE, 'T2', 'From Wikipedia or web search'),
    ('Account', 'Website',                 'Website',          'url',      FALSE, FALSE, TRUE, 'T2', 'From web search or Wikipedia'),
    ('Account', 'Phone',                   'Phone',            'phone',    FALSE, FALSE, TRUE, 'T2', 'From enrichment sources'),
    ('Account', 'npsp__Grantmaker__c',     'Grantmaker',       'boolean',  FALSE, TRUE,  TRUE, 'T3', 'From ProPublica 990 data'),
    ('Account', 'Philanthropy__c',         'Philanthropy',     'boolean',  FALSE, TRUE,  TRUE, 'T3', 'From philanthropy forager'),
    ('Account', 'Fee_For_Service__c',      'Fee For Service',  'boolean',  FALSE, TRUE,  TRUE, NULL,  'User-set'),
    ('Account', 'npsp__Funding_Focus__c',  'Funding Focus',    'multipicklist', FALSE, FALSE, TRUE, 'T3', 'From ProPublica program descriptions'),
    ('Account', 'AnnualRevenue',           'Annual Revenue',   'currency', FALSE, FALSE, TRUE, 'T3', 'From ProPublica 990 or SEC filings'),
    -- Payment: no non-boolean required fields
    ('npe01__OppPayment__c', 'npe01__Payment_Amount__c',  'Payment Amount',   'currency', FALSE, FALSE, TRUE, NULL, 'User-provided'),
    ('npe01__OppPayment__c', 'npe01__Scheduled_Date__c',  'Scheduled Date',   'date',     FALSE, FALSE, TRUE, NULL, 'User-provided'),
    ('npe01__OppPayment__c', 'npe01__Payment_Date__c',    'Payment Date',     'date',     FALSE, FALSE, TRUE, NULL, 'Set when paid'),
    ('npe01__OppPayment__c', 'npe01__Payment_Method__c',  'Payment Method',   'picklist', FALSE, FALSE, TRUE, NULL, 'User-selected')
ON CONFLICT (sobject, field_name) DO NOTHING;

-- Updated-at triggers for pebble tables that have updated_at columns
DO $$
DECLARE t TEXT;
BEGIN
    FOR t IN SELECT unnest(ARRAY[
        'pebble_chat_conversations',
        'pebble_research_batches',
        'pebble_batch_prospects',
        'pebble_scratchpad',
        'pebble_daily_usage',
        'prospect_sf_contact',
        'prospect_sf_account',
        'prospect_sf_opportunity'
    ])
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%s_updated_at ON bedrock.%I; '
            'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON bedrock.%I '
            'FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();',
            t, t, t, t
        );
    END LOOP;
END $$;
