-- ============================================================================
-- Builders tab — bedrock.builder_job_profile + L3 population helper
-- ============================================================================
-- A per-builder job-search/coach profile overlay for the Jobs "Builders" tab.
-- Stores ONLY the Airtable "Builders" fields that have no home in the platform
-- DB. Everything else (identity, applications, interviews, placements, deal
-- matches, platform intake, learning model) is READ/joined from public.* and
-- bedrock.* at query time — never duplicated here.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE). Safe to re-run.
-- ============================================================================

-- ── builder_job_profile ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bedrock.builder_job_profile (
    user_id                 integer PRIMARY KEY,   -- soft ref to public.users(user_id); no FK (RLS, no REFERENCES priv)

    -- Job-search status: manual override only. The derived status lives in the API.
    job_search_status       text,                  -- not_started|actively_applying|interviewing|placed|paused
    status_overridden       boolean NOT NULL DEFAULT false,

    -- Coaching
    pursuit_coach           text,                  -- staff email (org_users.email convention)
    gen_notes               text,
    coach_notes             text,
    coach_flags             text[]  NOT NULL DEFAULT '{}',
    improvement_tags        text[]  NOT NULL DEFAULT '{}',

    -- Readiness checklist
    ready_lookbook          boolean NOT NULL DEFAULT false,
    ready_linkedin          boolean NOT NULL DEFAULT false,
    ready_github            boolean NOT NULL DEFAULT false,
    ready_cv                boolean NOT NULL DEFAULT false,
    ready_mock              boolean NOT NULL DEFAULT false,

    -- Coach competency ratings (text scale, e.g. Capable / Excelling / Developing)
    technical_capability    text,
    ai_reasoning            text,
    problem_solving         text,
    presentation            text,
    professional_behaviors  text,
    prof_strength           text,                  -- High | Med | Low
    technical_strength      text,                  -- High | Med | Low

    -- Targeting / preferences
    target_industries       text[]  NOT NULL DEFAULT '{}',
    preferred_modes         text[]  NOT NULL DEFAULT '{}',
    certifications          text[]  NOT NULL DEFAULT '{}',

    -- Assets
    resume_url              text,
    lookbook_url            text,

    -- Education
    university              text,
    degree                  text,
    graduation_year         integer,
    languages               text[]  NOT NULL DEFAULT '{}',

    -- Cadence
    applying_regularly      boolean,
    networking_regularly    boolean,

    -- Long-tail Airtable intake answers not modeled elsewhere:
    --   salary_expectation, work_preference, geo_preference, portfolio_projects_count,
    --   what_matters_most, open_to_freelance, biggest_blockers, confidence
    intake                  jsonb   NOT NULL DEFAULT '{}'::jsonb,

    -- Provenance / import idempotency
    airtable_id             text UNIQUE,
    import_match            text,                  -- email | name | manual | unmatched
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_builder_job_profile_coach
    ON bedrock.builder_job_profile (pursuit_coach) WHERE pursuit_coach IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_builder_job_profile_status
    ON bedrock.builder_job_profile (job_search_status) WHERE status_overridden = true;

-- ── bedrock.l3_builders() ────────────────────────────────────────────────────
-- The Builders-tab population gate. public.users AND public.user_profiles both
-- have RLS that hides rows from bedrock_user, so this SECURITY DEFINER function
-- exposes exactly the identity + profile-link fields the tab needs for the
-- completed-L3 cohort. `cohort_completed` is a badge (end_date in the past), NOT
-- a filter — most L3 cohorts have a NULL end_date (incl. "March 2025 L3+").
CREATE OR REPLACE FUNCTION bedrock.l3_builders()
RETURNS TABLE(
    user_id integer, full_name text, email character varying, cohort character varying,
    cohort_end_date date, cohort_completed boolean,
    linkedin_url character varying, github_url character varying
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT u.user_id,
           NULLIF(trim(u.first_name || ' ' || u.last_name), '') AS full_name,
           u.email, u.cohort,
           c.end_date AS cohort_end_date,
           (c.end_date IS NOT NULL AND c.end_date < CURRENT_DATE) AS cohort_completed,
           up.linkedin_url, up.github_url
    FROM public.users u
    LEFT JOIN public.cohort c         ON c.name = u.cohort
    LEFT JOIN public.user_profiles up ON up.user_id = u.user_id
    WHERE u.role IN ('builder', 'enterprise_builder')
      AND u.cohort ILIKE '%L3%'
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────
-- bedrock_user owns the bedrock schema (created the table). jobs_dev is the
-- Avni/Damon dev login. Grant both. (jobs_dev grant is a no-op if the role is
-- absent in a given environment — run the two lines that apply.)
GRANT SELECT, INSERT, UPDATE ON bedrock.builder_job_profile TO bedrock_user;
GRANT SELECT, INSERT, UPDATE ON bedrock.builder_job_profile TO jobs_dev;
GRANT EXECUTE ON FUNCTION bedrock.l3_builders() TO bedrock_user;
GRANT EXECUTE ON FUNCTION bedrock.l3_builders() TO jobs_dev;

-- Read access for the source tables the Builders endpoints join (mostly already
-- granted; included for a clean rebuild). users/user_profiles are reached only
-- inside l3_builders() (SECURITY DEFINER), so no direct grant needed for those.
GRANT SELECT ON public.job_applications              TO bedrock_user, jobs_dev;
GRANT SELECT ON public.employment_records            TO bedrock_user, jobs_dev;
GRANT SELECT ON public.job_strategy_quiz_responses   TO bedrock_user, jobs_dev;
GRANT SELECT ON public.job_strategy_enrollments      TO bedrock_user, jobs_dev;
GRANT SELECT ON public.builder_profiles              TO bedrock_user, jobs_dev;
