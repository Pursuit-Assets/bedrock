-- Read-only lookup of builder/fellow emails (primary + backup), for the
-- jobs-relevance classifier: activity whose counterpart is one of our learners
-- is coaching/support, NOT employer outreach. public.users is RLS-scoped away
-- from bedrock_user, so expose it via a SECURITY DEFINER function (read-only).
CREATE OR REPLACE FUNCTION bedrock.builder_emails()
RETURNS SETOF text
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT lower(email)        FROM public.users
    WHERE role IN ('builder','enterprise_builder') AND email IS NOT NULL
  UNION
  SELECT lower(backup_email) FROM public.users
    WHERE role IN ('builder','enterprise_builder') AND backup_email IS NOT NULL
$$;

GRANT EXECUTE ON FUNCTION bedrock.builder_emails() TO bedrock_user, jobs_dev;
