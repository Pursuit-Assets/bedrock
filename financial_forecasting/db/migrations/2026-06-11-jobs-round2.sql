-- ============================================================================
-- Jobs pipeline — round 2: committed roles, opp fields, tasks/comments,
-- activity channels, secured-jobs source.
-- ============================================================================
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / guarded CHECK swap).
-- ============================================================================

-- ── jobs_opportunity: forecast fields ───────────────────────────────────────
ALTER TABLE bedrock.jobs_opportunity ADD COLUMN IF NOT EXISTS num_roles  integer;
ALTER TABLE bedrock.jobs_opportunity ADD COLUMN IF NOT EXISTS likelihood text;  -- low|medium|high

-- ── jobs_role: committed reqs on an opportunity (unfilled until a builder is hired) ──
-- A confirmed opportunity commits to N roles BEFORE any builder is attached.
-- Hiring a builder into a role creates an employment_record (the secured-jobs
-- source of truth, whose user_id is NOT NULL so it can't hold an empty req) and
-- flips the role to 'filled', back-linking the record.
CREATE TABLE IF NOT EXISTS bedrock.jobs_role (
    id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    opportunity_id       uuid NOT NULL REFERENCES bedrock.jobs_opportunity(id) ON DELETE CASCADE,
    title                text,
    approx_salary        integer,
    employment_type      text,                              -- full_time|contract|freelance
    start_date           date,
    status               text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','filled','cancelled')),
    filled_by_user_id    integer,                           -- soft ref public.users(user_id)
    employment_record_id integer,                           -- soft ref public.employment_records(id)
    notes                text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_role_opp ON bedrock.jobs_role(opportunity_id);

-- ── job_applications: target a specific committed role (optional) ────────────
ALTER TABLE public.job_applications ADD COLUMN IF NOT EXISTS jobs_role_id uuid;

-- ── jobs_task: tasks on a prospect or opportunity (mirrors bedrock.project_task) ──
-- Keyed by (parent_type, parent_id) because prospects are int-keyed and opps are
-- uuid-keyed; parent_id holds the text form of either.
CREATE TABLE IF NOT EXISTS bedrock.jobs_task (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    parent_type  text NOT NULL CHECK (parent_type IN ('opportunity','prospect')),
    parent_id    text NOT NULL,
    title        text NOT NULL,
    status       text NOT NULL DEFAULT 'Not Started'
        CHECK (status IN ('Not Started','In Progress','Completed','Blocked','On Hold')),
    owner        text NOT NULL DEFAULT '',
    owner_ids    uuid[] NOT NULL DEFAULT '{}',
    deadline     date,
    start_date   date,
    description  text NOT NULL DEFAULT '',
    links        text[] NOT NULL DEFAULT '{}',
    sort_order   integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz,
    deleted_by   text
);
CREATE INDEX IF NOT EXISTS idx_jobs_task_parent ON bedrock.jobs_task(parent_type, parent_id) WHERE deleted_at IS NULL;

-- ── jobs_comment: comments on a prospect or opportunity (mirrors public.org_comments) ──
CREATE TABLE IF NOT EXISTS bedrock.jobs_comment (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    parent_type  text NOT NULL CHECK (parent_type IN ('opportunity','prospect')),
    parent_id    text NOT NULL,
    author_id    uuid,                                      -- soft ref org_users(id)
    author_email text,
    content      text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_comment_parent ON bedrock.jobs_comment(parent_type, parent_id);

-- ── activity.type: add 'text' + 'linkedin' channels (manual logging) ─────────
ALTER TABLE bedrock.activity DROP CONSTRAINT IF EXISTS activity_type_check;
ALTER TABLE bedrock.activity ADD CONSTRAINT activity_type_check
    CHECK (type = ANY (ARRAY['call','email','meeting','note','slack-message','calendar-event','text','linkedin']));

-- ── secured_jobs(): expose source + job_application_id ───────────────────────
-- DROP first: adding OUT columns changes the return row type, which
-- CREATE OR REPLACE cannot do.
DROP FUNCTION IF EXISTS bedrock.secured_jobs();
CREATE OR REPLACE FUNCTION bedrock.secured_jobs()
RETURNS TABLE(
    id integer, user_id integer, builder text, role_title text, company_name text,
    employment_type text, engagement_stage text, payment_amount numeric,
    influenced boolean, opportunity_id uuid, start_date date,
    source text, job_application_id integer
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT er.id, er.user_id,
           COALESCE(NULLIF(trim(u.first_name||' '||u.last_name),''), 'Builder #'||er.user_id) AS builder,
           er.role_title, er.company_name, er.employment_type, er.engagement_stage,
           er.payment_amount, er.influenced, er.opportunity_id, er.start_date,
           er.source, er.job_application_id
    FROM public.employment_records er
    LEFT JOIN public.users u ON u.user_id = er.user_id
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock.jobs_role    TO bedrock_user, jobs_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock.jobs_task    TO bedrock_user, jobs_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock.jobs_comment TO bedrock_user, jobs_dev;
GRANT EXECUTE ON FUNCTION bedrock.secured_jobs() TO bedrock_user, jobs_dev;
