-- Allow 'account' as a parent_type for jobs tasks + comments so the account
-- hub can carry its own account-level tasks/comments (parent_id = the
-- normalized account key), alongside the opportunity/prospect-tagged ones it
-- aggregates. Idempotent.

ALTER TABLE bedrock.jobs_task   DROP CONSTRAINT IF EXISTS jobs_task_parent_type_check;
ALTER TABLE bedrock.jobs_task   ADD  CONSTRAINT jobs_task_parent_type_check
    CHECK (parent_type = ANY (ARRAY['opportunity'::text, 'prospect'::text, 'account'::text]));

ALTER TABLE bedrock.jobs_comment DROP CONSTRAINT IF EXISTS jobs_comment_parent_type_check;
ALTER TABLE bedrock.jobs_comment ADD  CONSTRAINT jobs_comment_parent_type_check
    CHECK (parent_type = ANY (ARRAY['opportunity'::text, 'prospect'::text, 'account'::text]));
