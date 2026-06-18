-- ============================================================================
-- Jobs Pipeline — capture of production schema changes applied ad-hoc via psql
-- ============================================================================
-- During the jobs-pipeline build (2026-06), several schema changes were applied
-- directly to the production DB (segundo-db) without migration files. This
-- migration reproduces them so the schema is rebuildable from source.
--
-- ALL statements are idempotent (IF NOT EXISTS / CREATE OR REPLACE) — safe to
-- run against the live DB (where these already exist) or a fresh rebuild.
--
-- Touches SHARED platform tables (public.contacts / job_applications /
-- employment_records) that Pathfinder also uses. Only ADDITIVE columns +
-- partial unique indexes + two SECURITY DEFINER functions. Nothing dropped.
-- ============================================================================

-- ── public.contacts ────────────────────────────────────────────────────────
-- Jobs-pipeline membership flag + employer-contact stage + Airtable provenance.
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS is_jobs_contact BOOLEAN DEFAULT false;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS contact_stage   TEXT;   -- lead | initial_outreach | active | on_hold
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS airtable_id     TEXT;   -- Airtable Contacts rec id (migration provenance)
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_airtable_id
    ON public.contacts (airtable_id) WHERE airtable_id IS NOT NULL;

-- ── public.job_applications ────────────────────────────────────────────────
-- Link a Pursuit-referred application to the jobs opportunity (deal) it belongs to.
ALTER TABLE public.job_applications ADD COLUMN IF NOT EXISTS jobs_opportunity_id UUID;
ALTER TABLE public.job_applications ADD COLUMN IF NOT EXISTS airtable_id         TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_applications_airtable_id
    ON public.job_applications (airtable_id) WHERE airtable_id IS NOT NULL;

-- ── public.employment_records (SINGLE SOURCE OF TRUTH for secured jobs) ──────
-- opportunity_id  : direct link to the won deal (one deal → many placements)
-- influenced      : true = jobs-team influenced, false = self-sourced, null = unclassified
ALTER TABLE public.employment_records ADD COLUMN IF NOT EXISTS opportunity_id UUID;
ALTER TABLE public.employment_records ADD COLUMN IF NOT EXISTS influenced     BOOLEAN;
ALTER TABLE public.employment_records ADD COLUMN IF NOT EXISTS airtable_id    TEXT;

-- ── bedrock.secured_jobs() ───────────────────────────────────────────────────
-- SECURITY DEFINER: lets the API role (bedrock_user) read placements joined to
-- builder names. public.users has RLS that otherwise hides rows from bedrock_user.
-- LOAD-BEARING: the Secured Jobs / placements metrics depend on this.
CREATE OR REPLACE FUNCTION bedrock.secured_jobs()
RETURNS TABLE(
    id integer, user_id integer, builder text, role_title text, company_name text,
    employment_type text, engagement_stage text, payment_amount numeric,
    influenced boolean, opportunity_id uuid, start_date date
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT er.id, er.user_id,
           COALESCE(NULLIF(trim(u.first_name||' '||u.last_name),''), 'Builder #'||er.user_id) AS builder,
           er.role_title, er.company_name, er.employment_type, er.engagement_stage,
           er.payment_amount, er.influenced, er.opportunity_id, er.start_date
    FROM public.employment_records er
    LEFT JOIN public.users u ON u.user_id = er.user_id
$$;
GRANT EXECUTE ON FUNCTION bedrock.secured_jobs() TO bedrock_user;

-- ── bedrock.search_builders(text) ────────────────────────────────────────────
-- SECURITY DEFINER builder search (bypasses public.users RLS) for the builder
-- pickers (placement recording, deal builder-matching).
CREATE OR REPLACE FUNCTION bedrock.search_builders(search_term text DEFAULT '')
RETURNS TABLE(
    user_id integer, full_name text, email character varying,
    cohort character varying, role character varying
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT u.user_id,
           (u.first_name || ' ' || u.last_name) AS full_name,
           u.email, u.cohort, u.role
    FROM public.users u
    WHERE u.role IN ('builder', 'enterprise_builder')
      AND (
        search_term = ''
        OR lower(u.first_name || ' ' || u.last_name) LIKE '%' || lower(search_term) || '%'
        OR lower(u.email) LIKE '%' || lower(search_term) || '%'
      )
    ORDER BY u.first_name, u.last_name
    LIMIT 50;
$$;
GRANT EXECUTE ON FUNCTION bedrock.search_builders(text) TO bedrock_user;

-- ── Grants for the API role on shared placement/contact tables ───────────────
-- bedrock_user (the API role) reads/writes these via the jobs endpoints.
GRANT SELECT, INSERT, UPDATE ON public.contacts            TO bedrock_user;
GRANT SELECT, INSERT, UPDATE ON public.job_applications    TO bedrock_user;
GRANT SELECT, INSERT, UPDATE ON public.employment_records  TO bedrock_user;
GRANT SELECT                  ON public.org_users          TO bedrock_user;  -- staff/owner picker
