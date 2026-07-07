-- Roles → Pathfinder sync. A committed role in Bedrock can be published to
-- Pathfinder (public.job_postings, which builders browse) with a visibility
-- toggle. We keep a link to the synced posting so edits/untoggles update the
-- same row rather than creating duplicates. Idempotent.

BEGIN;

ALTER TABLE bedrock.jobs_role
  -- staff-controlled: is this role published to builders in Pathfinder?
  ADD COLUMN IF NOT EXISTS pathfinder_visible boolean NOT NULL DEFAULT false,
  -- link to the public.job_postings row this role syncs to (null until first published)
  ADD COLUMN IF NOT EXISTS job_posting_id integer,
  ADD COLUMN IF NOT EXISTS pathfinder_synced_at timestamptz;

-- Publish/unpublish a role to Pathfinder's builder-facing feed (public.job_postings,
-- read by /api/employment-engine/jobs WHERE is_shared=true). SECURITY DEFINER so the
-- RLS-scoped bedrock_user can write public.job_postings (mirrors bedrock.merge_contacts
-- et al). Idempotent: an already-linked role updates its posting instead of duplicating.
--   pathfinder_visible=true  → upsert the posting, is_shared=true
--   pathfinder_visible=false → set the linked posting is_shared=false (keep interest history)
-- staff_user_id (NOT NULL FK → users) resolves the opp owner via staff_user_id_map,
-- falling back to the jobs team (avni) when the owner isn't mapped.
CREATE OR REPLACE FUNCTION bedrock.sync_role_to_pathfinder(p_role_id uuid)
RETURNS TABLE(action text, posting_id int)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  r record; v_staff int; v_pid int; v_range text; should_share boolean;
BEGIN
  SELECT rr.id, rr.title, rr.jd_url, rr.notes, rr.approx_salary, rr.status,
         rr.pathfinder_visible, rr.job_posting_id, o.account_name, o.owner_email
    INTO r
    FROM bedrock.jobs_role rr
    JOIN bedrock.jobs_opportunity o ON o.id = rr.opportunity_id
    WHERE rr.id = p_role_id;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::int; RETURN; END IF;

  -- A role is shown to builders only while it's OPEN and toggled visible. A
  -- filled or cancelled role must never keep advertising — this makes hire and
  -- cancel unpublish it even though pathfinder_visible is still true.
  should_share := r.pathfinder_visible AND coalesce(r.status, 'open') = 'open';

  SELECT staff_user_id INTO v_staff FROM bedrock.staff_user_id_map
    WHERE lower(email) = lower(r.owner_email);
  IF v_staff IS NULL THEN
    SELECT staff_user_id INTO v_staff FROM bedrock.staff_user_id_map
      WHERE lower(email) = 'avni@pursuit.org';
  END IF;

  v_range := CASE WHEN r.approx_salary IS NOT NULL
                  THEN '$' || round(r.approx_salary / 1000.0) || 'k' END;

  IF r.job_posting_id IS NOT NULL THEN
    IF should_share THEN
      UPDATE public.job_postings SET
        company_name = coalesce(r.account_name, '—'),
        job_title    = coalesce(r.title, 'Role'),
        job_url = r.jd_url, description = r.notes,
        salary_range = v_range, salary_min = r.approx_salary, salary_max = r.approx_salary,
        is_shared = true, updated_at = now()
      WHERE id = r.job_posting_id;
      UPDATE bedrock.jobs_role SET pathfinder_synced_at = now() WHERE id = p_role_id;
      RETURN QUERY SELECT 'updated'::text, r.job_posting_id; RETURN;
    ELSE
      UPDATE public.job_postings SET is_shared = false, updated_at = now()
        WHERE id = r.job_posting_id;
      UPDATE bedrock.jobs_role SET pathfinder_synced_at = now() WHERE id = p_role_id;
      RETURN QUERY SELECT 'unpublished'::text, r.job_posting_id; RETURN;
    END IF;
  ELSE
    IF NOT should_share THEN RETURN QUERY SELECT 'noop'::text, NULL::int; RETURN; END IF;
    INSERT INTO public.job_postings
      (staff_user_id, company_name, job_title, job_url, source, status,
       description, salary_range, salary_min, salary_max, is_shared, shared_date, is_migrated)
    VALUES
      (v_staff, coalesce(r.account_name, '—'), coalesce(r.title, 'Role'), r.jd_url, 'bedrock', 'new',
       r.notes, v_range, r.approx_salary, r.approx_salary, true, CURRENT_DATE, false)
    RETURNING id INTO v_pid;
    UPDATE bedrock.jobs_role SET job_posting_id = v_pid, pathfinder_synced_at = now() WHERE id = p_role_id;
    RETURN QUERY SELECT 'created'::text, v_pid; RETURN;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION bedrock.sync_role_to_pathfinder(uuid) TO bedrock_user, jobs_dev;

COMMIT;
