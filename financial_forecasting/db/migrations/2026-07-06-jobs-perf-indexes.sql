-- Performance indexes for the jobs app (search + tab endpoints).
-- Global search + list search do leading-wildcard lower(col) LIKE '%q%' across
-- public.contacts (~40k rows) with no supporting index → full seq-scan per
-- keystroke. Trigram GIN indexes make those sargable. Plus functional indexes
-- for the email/name/account joins reused across /accounts, /activity-trends,
-- /contacts, /candidates. Run CONCURRENTLY (outside a txn) so live traffic isn't
-- locked.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Global + list search (name / email / company)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_full_name_trgm       ON public.contacts USING gin (lower(full_name)       gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_email_trgm           ON public.contacts USING gin (lower(email)           gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_current_company_trgm ON public.contacts USING gin (lower(current_company) gin_trgm_ops);

-- Email-join used by /accounts + /activity-trends (attendee/recipient → contact)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_lower_email ON public.contacts (lower(email));
-- Candidate self-join on name
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_lower_full_name ON public.contacts (lower(full_name));
-- Engaged-prospect scans
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_jobs ON public.contacts (contact_stage) WHERE is_jobs_contact = true;

-- Team-sender ILIKE on activity (outreach trends actor filter)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_email_from_trgm ON bedrock.activity USING gin (email_from gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_logged_by_trgm  ON bedrock.activity USING gin (logged_by  gin_trgm_ops);

-- Account-name grouping/joins (jobs_opportunity had no account_name index)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_opp_account_name_lower ON bedrock.jobs_opportunity (lower(trim(account_name))) WHERE deleted_at IS NULL;
-- Open-task subqueries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_task_parent ON bedrock.jobs_task (parent_type, parent_id) WHERE deleted_at IS NULL;
