"""Resolve activity → jobs-prospect links by email match.

Synced (gmail-sync / calendar-sync) and manual activity rows leave
``participant_public_contact_id`` NULL. The jobs Performance dashboard counts
"engaged prospects" as the distinct jobs prospects (public.contacts WHERE
is_jobs_contact) we've actually had activity with — so we resolve that link by
matching a jobs-prospect email against the activity's from/to/cc fields.

Run once as a backfill (days_back=None) and again after every nightly
interaction sync (days_back=small) so the count stays fresh as scrapes land.
Only NULL links are filled — we never clobber an existing participant.
"""

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Mirror of routes.jobs.JOBS_TEAM_EMAILS — redefined locally so this service
# stays free of any route import. Keep in sync with routes/jobs.py.
JOBS_TEAM_EMAILS = ["avni@pursuit.org", "damon.kornhauser@pursuit.org", "devika@pursuit.org"]


async def relink_jobs_prospect_activity(conn, days_back: Optional[int] = None) -> dict[str, Any]:
    """Populate activity.participant_public_contact_id for jobs prospects.

    Set-based (hash join on normalized email), so it's fast even over the full
    activity table. ``days_back`` bounds the work to recently-dated activity for
    incremental nightly runs; pass None to backfill everything.
    """
    bound = ""
    params: list = []
    if days_back is not None:
        bound = "AND a.activity_date >= now() - ($1 || ' days')::interval"
        params = [str(days_back)]

    # One row per (activity_id, participant-email), joined to jobs prospects by
    # email, then DISTINCT ON keeps a single deterministic prospect per activity
    # (the participant column is singular; multi-recipient emails link to one).
    sql = f"""
    WITH jp AS (
        -- ALL contacts, not just is_jobs_contact: the participant link is
        -- identity resolution, not jobs classification (metrics gate on
        -- jobs_relevance separately). Restricting to flagged contacts left
        -- follow-up emails unlinked whenever the contact was flagged later
        -- than the email was synced (TKT-124: 115 orphaned emails).
        SELECT contact_id, lower(email) AS em
        FROM public.contacts
        WHERE email IS NOT NULL AND email <> ''
    ),
    act_part AS (
        SELECT a.id, lower(a.email_from) AS em
        FROM bedrock.activity a
        WHERE a.participant_public_contact_id IS NULL AND a.deleted_at IS NULL
          AND a.source IN ('manual', 'gmail-sync', 'calendar-sync')
          AND a.email_from IS NOT NULL {bound}
        UNION ALL
        SELECT a.id, lower(e) AS em
        FROM bedrock.activity a, unnest(coalesce(a.email_to, '{{}}')) e
        WHERE a.participant_public_contact_id IS NULL AND a.deleted_at IS NULL
          AND a.source IN ('manual', 'gmail-sync', 'calendar-sync') {bound}
        UNION ALL
        SELECT a.id, lower(e) AS em
        FROM bedrock.activity a, unnest(coalesce(a.email_cc, '{{}}')) e
        WHERE a.participant_public_contact_id IS NULL AND a.deleted_at IS NULL
          AND a.source IN ('manual', 'gmail-sync', 'calendar-sync') {bound}
    ),
    matched AS (
        SELECT DISTINCT ON (ap.id) ap.id, jp.contact_id
        FROM act_part ap
        JOIN jp ON jp.em = ap.em
        ORDER BY ap.id, jp.contact_id
    )
    UPDATE bedrock.activity a
    SET participant_public_contact_id = m.contact_id
    FROM matched m
    WHERE m.id = a.id
    """
    result = await conn.execute(sql, *params)
    # asyncpg returns e.g. "UPDATE 884"
    linked = int(result.split()[-1]) if result and result.split()[-1].isdigit() else 0
    logger.info("relinked %d activity rows to jobs prospects (days_back=%s)", linked, days_back)
    return {"linked": linked}


async def auto_flag_jobs_prospects(conn) -> dict[str, Any]:
    """Flip is_jobs_contact=true on EXISTING contacts the jobs team engaged.

    A contact qualifies when there is a non-deleted bedrock.activity row that
    the jobs team (Avni or Damon) sent or owned — matched via email_from ILIKE
    a team address OR logged_by ILIKE a team address — AND that activity has the
    contact as a participant: either the activity already links to the contact
    via participant_public_contact_id, or the contact's lower(email) appears in
    the activity's recipients (parsed lower(email_from), or = ANY of the lowered
    email_to / email_cc arrays).

    Set-based (unnest CTE over recipients, hash-joined to contacts by normalized
    email), mirroring relink_jobs_prospect_activity. Only EXISTING contacts that
    are currently not flagged (is_jobs_contact false/null) and have a non-empty
    email are updated — this never INSERTs a contact. Returns {"flagged": n}.
    """
    # Build the team-address predicates inline. JOBS_TEAM_EMAILS is a fixed
    # internal constant (not user input), matching routes/jobs.py's own pattern.
    sender = " OR ".join(f"a.email_from ILIKE '%{e}%'" for e in JOBS_TEAM_EMAILS)
    owner = " OR ".join(f"a.logged_by ILIKE '%{e}%'" for e in JOBS_TEAM_EMAILS)

    sql = f"""
    WITH team_act AS (
        -- Activity the jobs team sent or owned, still live
        SELECT a.id,
               a.participant_public_contact_id AS linked_cid,
               lower(a.email_from) AS from_em,
               a.email_to,
               a.email_cc
        FROM bedrock.activity a
        WHERE a.deleted_at IS NULL
          AND (({sender}) OR ({owner}))
    ),
    -- Every participant email seen on a team activity, normalized
    part_email AS (
        SELECT (regexp_match(from_em, '<([^>]+)>'))[1] AS em FROM team_act
            WHERE from_em IS NOT NULL AND from_em ~ '<[^>]+>'
        UNION ALL
        SELECT from_em AS em FROM team_act
            WHERE from_em IS NOT NULL AND from_em !~ '<[^>]+>'
        UNION ALL
        SELECT lower(e) AS em
            FROM team_act, unnest(coalesce(email_to, '{{}}')) e
        UNION ALL
        SELECT lower(e) AS em
            FROM team_act, unnest(coalesce(email_cc, '{{}}')) e
    ),
    -- Contacts already directly linked on a team activity
    linked_cid AS (
        SELECT DISTINCT linked_cid AS contact_id
        FROM team_act
        WHERE linked_cid IS NOT NULL
    ),
    -- Existing, unflagged contacts that qualify
    cand AS (
        SELECT c.contact_id
        FROM public.contacts c
        WHERE coalesce(c.is_jobs_contact, false) = false
          AND c.email IS NOT NULL AND c.email <> ''
          -- Email-review candidates are staged for human review, not the main
          -- pipeline — never auto-promote them into is_jobs_contact via activity.
          AND coalesce(c.contact_stage, '') <> 'candidate'
          AND (
              lower(c.email) IN (SELECT em FROM part_email WHERE em IS NOT NULL)
              OR c.contact_id IN (SELECT contact_id FROM linked_cid)
          )
    )
    UPDATE public.contacts c
    SET is_jobs_contact = true,
        updated_at = now()
    FROM cand
    WHERE c.contact_id = cand.contact_id
    """
    result = await conn.execute(sql)
    flagged = int(result.split()[-1]) if result and result.split()[-1].isdigit() else 0
    logger.info("auto-flagged %d existing contacts as jobs prospects", flagged)
    return {"flagged": flagged}
