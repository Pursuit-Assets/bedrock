-- Message-level index over gmail-sync threads (TKT: thread-level dating starves
-- outreach metrics). bedrock.activity stays one-row-per-thread (email_messages
-- JSON holds every message); this table explodes those messages so metrics can
-- count each send on the day it happened and credit the actual author.
-- Populated by services/email_message_index.py (backfill + nightly incremental).

CREATE TABLE IF NOT EXISTS bedrock.activity_email_message (
    id           bigserial PRIMARY KEY,
    activity_id  uuid NOT NULL REFERENCES bedrock.activity(id) ON DELETE CASCADE,
    message_id   text,                -- RFC Message-ID header (dedupe key within thread)
    from_email   text NOT NULL,       -- parsed, lowercased sender address
    sent_at      timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per (thread, message). message_id is occasionally missing — fall back
-- to sender+timestamp identity in that case. Two partial indexes (a coalesce
-- expression over sent_at::text isn't IMMUTABLE); bare ON CONFLICT DO NOTHING
-- respects both.
CREATE UNIQUE INDEX IF NOT EXISTS activity_email_message_uniq_mid
    ON bedrock.activity_email_message (activity_id, message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS activity_email_message_uniq_fallback
    ON bedrock.activity_email_message (activity_id, from_email, sent_at) WHERE message_id IS NULL;

CREATE INDEX IF NOT EXISTS activity_email_message_from_sent
    ON bedrock.activity_email_message (from_email, sent_at);
CREATE INDEX IF NOT EXISTS activity_email_message_sent
    ON bedrock.activity_email_message (sent_at);
CREATE INDEX IF NOT EXISTS activity_email_message_activity
    ON bedrock.activity_email_message (activity_id);
