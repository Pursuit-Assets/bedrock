-- Account-level tasks & comments live in their own bedrock_user-owned tables,
-- mirroring jobs_task / jobs_comment column-for-column but WITHOUT the
-- parent_type CHECK (which is locked to opportunity|prospect on the
-- postgres-owned originals). This lets the account hub create account-direct
-- tasks/comments without a privileged migration on the postgres-owned tables.
-- The /jobs-tasks + /jobs-comments endpoints route parent_type='account' here.

CREATE TABLE IF NOT EXISTS bedrock.jobs_account_task (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    parent_type text NOT NULL,
    parent_id   text NOT NULL,
    title       text NOT NULL,
    status      text NOT NULL DEFAULT 'Not Started',
    owner       text NOT NULL DEFAULT '',
    owner_ids   uuid[] NOT NULL DEFAULT '{}',
    deadline    date,
    start_date  date,
    description text NOT NULL DEFAULT '',
    links       text[] NOT NULL DEFAULT '{}',
    sort_order  integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,
    deleted_by  text
);
CREATE INDEX IF NOT EXISTS idx_jobs_account_task_parent
    ON bedrock.jobs_account_task (parent_type, parent_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS bedrock.jobs_account_comment (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    parent_type  text NOT NULL,
    parent_id    text NOT NULL,
    author_id    uuid,
    author_email text,
    content      text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_account_comment_parent
    ON bedrock.jobs_account_comment (parent_type, parent_id);
