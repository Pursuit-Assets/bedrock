-- 2026-05-20: notification poller watermarks
--
-- Tracks the last-seen timestamp for each Salesforce-side notification
-- source (new Tasks, OpportunityFieldHistory rows). The poller updates
-- these in the same transaction as the notification inserts so a
-- crash mid-batch doesn't double-notify or skip events.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS bedrock.notification_watermark (
    source     TEXT PRIMARY KEY,
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT (now() - interval '1 hour'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the two known sources with a recent timestamp so the first
-- poll after deploy doesn't drown the team in old notifications.
-- (Skipped if the row already exists.)
INSERT INTO bedrock.notification_watermark (source, last_seen)
VALUES
    ('sf_task',              now() - interval '1 hour'),
    ('sf_opp_owner_history', now() - interval '1 hour')
ON CONFLICT (source) DO NOTHING;
