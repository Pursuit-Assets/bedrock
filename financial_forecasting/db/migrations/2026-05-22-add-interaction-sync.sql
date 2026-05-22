-- 2026-05-22: Gmail + Calendar interaction sync infrastructure.
--
-- Adds:
--   bedrock.sync_staff      — which staff members to pull Gmail/Calendar for
--   bedrock.sync_watermark  — per-staff per-source incremental cursor
--   UNIQUE(source, source_thread_id) on bedrock.activity — idempotent upserts
--   sf_account_id on bedrock.sf_contact_link — denormalized for fast account lookup

-- Staff roster for interaction sync
CREATE TABLE IF NOT EXISTS bedrock.sync_staff (
    email         TEXT PRIMARY KEY,
    display_name  TEXT,
    enabled       BOOLEAN NOT NULL DEFAULT true,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-staff per-source watermark (drives incremental syncs)
CREATE TABLE IF NOT EXISTS bedrock.sync_watermark (
    staff_email    TEXT NOT NULL,
    source         TEXT NOT NULL CHECK (source IN ('gmail', 'calendar')),
    last_synced_at TIMESTAMPTZ,
    last_run_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (staff_email, source)
);

-- Unique constraint enabling ON CONFLICT (source, source_thread_id) upserts.
-- Partial: only rows where source_thread_id is populated (SF activities may lack it).
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_source_thread_unique
    ON bedrock.activity(source, source_thread_id)
    WHERE source_thread_id IS NOT NULL;

-- Denormalized SF account ID on the contact link — avoids extra SF API calls
-- when resolving which account to tag on synced activities.
ALTER TABLE bedrock.sf_contact_link
    ADD COLUMN IF NOT EXISTS sf_account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sf_contact_link_sf_account
    ON bedrock.sf_contact_link(sf_account_id)
    WHERE sf_account_id IS NOT NULL;
