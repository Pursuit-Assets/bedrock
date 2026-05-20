-- 2026-05-20: notifications + Slack id cache
--
-- Adds:
--   1. bedrock.notification    — recipient-keyed event log used by the
--                                 in-app bell + Slack DM dispatch.
--   2. public.org_users.slack_user_id — lazy email→Slack-id cache so we
--                                 don't hit users.lookupByEmail every
--                                 dispatch. Slack rate-limits that
--                                 endpoint aggressively; one lookup
--                                 per user per ever is enough.
--
-- Idempotent; safe to re-run.

-- 1. Notification table -----------------------------------------------------

CREATE TABLE IF NOT EXISTS bedrock.notification (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Recipient (email is the canonical org identity — matches
    -- project.owner_email and SF Owner.Email).
    recipient_email   TEXT NOT NULL,

    -- Notification taxonomy:
    --   project_task_assigned — owner_ids on bedrock.project_task added the recipient
    --   comment_mention       — @display_name resolved to recipient in a comment body
    --   sf_task_assigned      — SF Task with OwnerId=recipient.sf_user_id, created since the last watermark
    --   sf_opp_owner_changed  — SF Opportunity.OwnerId transitioned from/to the recipient
    type              TEXT NOT NULL CHECK (
        type IN (
            'project_task_assigned',
            'comment_mention',
            'sf_task_assigned',
            'sf_opp_owner_changed'
        )
    ),

    -- Free-form payload — recipient app reads this without touching SF.
    -- Always includes a title + subtitle + a target_url that the frontend
    -- routes to on click. Source IDs (project_id / task_id / comment_id /
    -- opp_id / sf_task_id) live here as needed.
    payload           JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Who triggered the event (NULL when system-generated, e.g. SF polling).
    actor_email       TEXT,

    -- read state — null = unread, non-null = read at this time.
    read_at           TIMESTAMPTZ,

    -- Slack delivery state — independent of in-app read state.
    --   pending  — about to dispatch (default on insert)
    --   sent     — Slack accepted the message
    --   skipped  — recipient has no Slack id (lookup failed gracefully)
    --   failed   — Slack returned an error; payload.slack_error holds the reason
    --   disabled — recipient opted out (future; not used today)
    slack_status      TEXT NOT NULL DEFAULT 'pending' CHECK (
        slack_status IN ('pending', 'sent', 'skipped', 'failed', 'disabled')
    ),
    slack_sent_at     TIMESTAMPTZ,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast unread-by-recipient lookup (the bell query).
CREATE INDEX IF NOT EXISTS idx_notification_recipient_unread
    ON bedrock.notification (recipient_email, created_at DESC)
    WHERE read_at IS NULL;

-- Full per-recipient timeline.
CREATE INDEX IF NOT EXISTS idx_notification_recipient_all
    ON bedrock.notification (recipient_email, created_at DESC);

-- Slack-dispatch worker pulls pending rows.
CREATE INDEX IF NOT EXISTS idx_notification_slack_pending
    ON bedrock.notification (created_at)
    WHERE slack_status = 'pending';

-- updated_at trigger — reuses the existing helper installed by init.sql.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_notification'
    ) THEN
        CREATE TRIGGER set_updated_at_notification
            BEFORE UPDATE ON bedrock.notification
            FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();
    END IF;
EXCEPTION
    -- If the helper function doesn't exist in this environment yet,
    -- silently skip — the column has a default that's good enough for
    -- the bell's purposes.
    WHEN undefined_function THEN NULL;
END $$;


-- 2. Slack id cache (bedrock-owned) ----------------------------------------
--
-- We can't add a column to public.org_users (factory owns it), so the
-- email → Slack-id mapping lives in its own bedrock-owned cache table.
-- Lazily populated on first dispatch; entries never expire (Slack ids
-- are stable for the workspace's lifetime).

CREATE TABLE IF NOT EXISTS bedrock.slack_user_cache (
    email         TEXT PRIMARY KEY,
    slack_user_id TEXT NOT NULL,
    looked_up_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slack_cache_slack_id
    ON bedrock.slack_user_cache(slack_user_id);
