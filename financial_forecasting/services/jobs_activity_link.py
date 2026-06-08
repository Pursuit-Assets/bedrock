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
        SELECT contact_id, lower(email) AS em
        FROM public.contacts
        WHERE is_jobs_contact = true AND email IS NOT NULL AND email <> ''
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
