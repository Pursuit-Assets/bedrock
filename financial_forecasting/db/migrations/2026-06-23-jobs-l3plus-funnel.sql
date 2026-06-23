-- Job-ready (L3+) builder funnel, with names — SECURITY DEFINER so the app role
-- (bedrock_user) can read public.users despite RLS, matching the existing
-- secured_jobs()/search_builders() pattern (all postgres-owned).
--
-- L3+ = builders who EVER reached an L3+ course enrollment. `segment` = the L3
-- cohort (class) the builder completed (L3+ is one shared pool, so we look back
-- at each builder's L3 enrollment). Placement status comes from the
-- employment_records source of truth.
--
-- Apply as postgres (owns public.users + bypasses RLS):
--   psql "<postgres conn>" -f db/migrations/2026-06-23-jobs-l3plus-funnel.sql

CREATE OR REPLACE FUNCTION bedrock.l3plus_funnel(p_segment text DEFAULT NULL)
RETURNS TABLE (
    user_id  integer,
    name     text,
    segment  text,
    is_paid  boolean,
    is_ft    boolean,
    company  text,
    role     text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, bedrock
AS $$
    WITH l3plus AS (
        SELECT DISTINCT ue.user_id
        FROM public.user_enrollment ue
        JOIN public.cohort ch ON ch.cohort_id = ue.cohort_id
        JOIN public.course co ON co.course_id = ch.course_id
        WHERE co.level = 'L3+'
    ),
    l3cohort AS (
        SELECT DISTINCT ON (ue.user_id) ue.user_id, ch.name AS segment
        FROM public.user_enrollment ue
        JOIN public.cohort ch ON ch.cohort_id = ue.cohort_id
        JOIN public.course co ON co.course_id = ch.course_id
        WHERE co.level = 'L3' AND ue.user_id IN (SELECT user_id FROM l3plus)
        ORDER BY ue.user_id, ue.enrolled_date DESC
    ),
    pool AS (
        SELECT lp.user_id, COALESCE(lc.segment, 'Other L3+') AS segment
        FROM l3plus lp LEFT JOIN l3cohort lc ON lc.user_id = lp.user_id
    ),
    paid AS (
        SELECT er.user_id,
               bool_or(er.employment_type = 'full_time' AND er.payment_amount > 0) AS is_ft,
               bool_or(er.payment_amount > 0)                                       AS is_paid,
               (array_agg(er.company_name ORDER BY er.payment_amount DESC NULLS LAST))[1] AS company,
               (array_agg(er.role_title   ORDER BY er.payment_amount DESC NULLS LAST))[1] AS role
        FROM public.employment_records er
        GROUP BY er.user_id
    )
    SELECT p.user_id,
           COALESCE(NULLIF(trim(u.first_name || ' ' || u.last_name), ''), 'Builder #' || p.user_id) AS name,
           p.segment,
           COALESCE(pd.is_paid, false) AS is_paid,
           COALESCE(pd.is_ft,   false) AS is_ft,
           pd.company,
           pd.role
    FROM pool p
    LEFT JOIN public.users u  ON u.user_id  = p.user_id
    LEFT JOIN paid        pd ON pd.user_id = p.user_id
    WHERE p_segment IS NULL OR p.segment = p_segment
    ORDER BY name;
$$;

GRANT EXECUTE ON FUNCTION bedrock.l3plus_funnel(text) TO bedrock_user;
-- jobs_dev may not exist in all envs; ignore if it errors.
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION bedrock.l3plus_funnel(text) TO jobs_dev;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
