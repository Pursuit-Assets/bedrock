-- ============================================================================
-- Generic entity comments for portfolio Salesforce records
-- ============================================================================
-- public.org_comments (factory-shared) keys entity_id as UUID, so it can't hold
-- Salesforce 18-char string IDs. This table mirrors the bedrock.jobs_comment
-- (parent_type, parent_id text) pattern for portfolio Accounts / Opportunities /
-- Contacts, whose IDs are SF strings. Author-gated edit/delete handled in the API.
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS bedrock.entity_comment (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_type  text NOT NULL CHECK (entity_type IN ('account','opportunity','contact')),
    entity_id    text NOT NULL,           -- Salesforce 18-char Id
    author_id    uuid,                    -- soft ref public.org_users(id)
    author_email text,
    content      text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entity_comment_parent
    ON bedrock.entity_comment (entity_type, entity_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock.entity_comment TO bedrock_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock.entity_comment TO jobs_dev;
