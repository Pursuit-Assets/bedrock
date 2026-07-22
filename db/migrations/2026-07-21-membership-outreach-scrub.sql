-- One-time scrub (2026-07-21, Jac): contacts with real staff jobs-outreach
-- activity but no (or a lagging) pipeline stage.
--
-- AMENDED same day (Jac's call): only outreach from the jobs team proper —
-- damon.kornhauser@ and avni@ — counts as pipeline outreach. The scrub below
-- originally counted all 44 staff mailboxes; a follow-up pass (applied
-- directly, recorded here) deleted the 161 memberships whose only outreach
-- was other staff, reverted 5 advanced rows to 'assigned', restamped the
-- keepers to Damon/Avni's first touch, and unflagged 58 contacts. Net result:
-- the staff list in the CTE below should be read as ('damon.kornhauser@
-- pursuit.org','avni@pursuit.org') for pipeline-stage purposes.
--   A. Touched contacts with NO membership row → initial_outreach, with
--      assigned_at/first_outreach_at stamped from the earliest touch and the
--      contact's owner carried onto the membership. (The nightly auto-advance
--      only moves existing 'assigned' rows on post-assignment activity, so
--      these were invisible to it — e.g. Izza Nadeem.)
--   B. Existing 'assigned' rows whose outreach PREDATES the assignment →
--      initial_outreach; assigned_at pulled back to the first touch so the
--      scorecard's flow ordering (assigned ≤ first_outreach) stays coherent.
-- Idempotent.

WITH staff AS (
  SELECT lower(email) AS email FROM public.org_users
  WHERE is_active AND email LIKE '%@pursuit.org' AND email NOT IN ('systems@pursuit.org')
),
touches AS (
  SELECT a.participant_public_contact_id AS contact_id, lower(m.from_email) AS staff_email, m.sent_at AS at
  FROM bedrock.activity_email_message m
  JOIN bedrock.activity a ON a.id = m.activity_id
  WHERE a.participant_public_contact_id IS NOT NULL AND a.deleted_at IS NULL
    AND coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs'
    AND lower(m.from_email) IN (SELECT email FROM staff)
  UNION ALL
  SELECT a.participant_public_contact_id, lower(a.logged_by), a.activity_date
  FROM bedrock.activity a
  WHERE a.participant_public_contact_id IS NOT NULL AND a.deleted_at IS NULL
    AND a.source = 'manual' AND a.logged_by IS NOT NULL
    AND lower(a.logged_by) IN (SELECT email FROM staff)
),
first_touch AS (
  SELECT contact_id, min(at) AS first_at,
         (array_agg(staff_email ORDER BY at))[1] AS first_by
  FROM touches WHERE at IS NOT NULL
  GROUP BY contact_id
),
-- A: create the missing memberships
ins AS (
  INSERT INTO bedrock.jobs_contact_membership
    (contact_id, stage, owner_email, activation_reason, assigned_by, assigned_at,
     first_outreach_at, first_outreach_by, updated_at)
  SELECT f.contact_id, 'initial_outreach', c.owner_email, 'algorithm', f.first_by, f.first_at,
         f.first_at, f.first_by, now()
  FROM first_touch f
  JOIN public.contacts c ON c.contact_id = f.contact_id
  WHERE NOT EXISTS (SELECT 1 FROM bedrock.jobs_contact_membership m WHERE m.contact_id = f.contact_id)
  RETURNING contact_id
),
-- B: advance lagging 'assigned' rows (pre-assignment outreach)
adv AS (
  UPDATE bedrock.jobs_contact_membership m
  SET stage = 'initial_outreach',
      assigned_at = LEAST(coalesce(m.assigned_at, f.first_at), f.first_at),
      first_outreach_at = coalesce(m.first_outreach_at, f.first_at),
      first_outreach_by = coalesce(m.first_outreach_by, f.first_by),
      updated_at = now()
  FROM first_touch f
  WHERE f.contact_id = m.contact_id AND m.stage = 'assigned'
  RETURNING m.contact_id
)
SELECT (SELECT count(*) FROM ins) AS memberships_created,
       (SELECT count(*) FROM adv) AS assigned_advanced;

-- touched contacts should be jobs prospects (mirrors the sync's auto-flag)
UPDATE public.contacts c SET is_jobs_contact = true, updated_at = now()
WHERE NOT c.is_jobs_contact
  AND EXISTS (SELECT 1 FROM bedrock.jobs_contact_membership m WHERE m.contact_id = c.contact_id);
