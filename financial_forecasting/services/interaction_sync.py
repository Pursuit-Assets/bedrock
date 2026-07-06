"""Orchestrator: run Gmail + Calendar sync for all enabled sync_staff members."""

import logging
from typing import Any

logger = logging.getLogger(__name__)


async def run_interaction_sync(
    conn_or_pool,
    days_back: int = 90,
    staff_emails: list[str] | None = None,
    since_days: int | None = None,
) -> dict[str, Any]:
    """Sync Gmail and Calendar for all enabled staff. Returns per-staff summary.

    Accepts either a single asyncpg connection or a connection pool.
    A pool is strongly preferred for long syncs — each staff member acquires
    a fresh connection so a slow Gmail run cannot time out the shared connection.

    staff_emails — restrict the run to these addresses (else all enabled staff).
    since_days   — force a historical backfill from N days ago, bypassing each
                   staff member's incremental watermark (needed the first time
                   we capture Sent mail, which the watermark never covered).
    """
    from datetime import datetime, timedelta, timezone
    from services.gmail_sync import sync_gmail_for_staff
    from services.calendar_sync import sync_calendar_for_staff
    from services.google_dwd import is_dwd_configured
    import asyncpg

    if not is_dwd_configured():
        logger.warning("interaction sync skipped — GOOGLE_SERVICE_ACCOUNT_JSON not set")
        return {"skipped": True, "reason": "DWD not configured"}

    override_since = (
        datetime.now(timezone.utc) - timedelta(days=since_days) if since_days else None
    )

    is_pool = isinstance(conn_or_pool, asyncpg.pool.Pool)

    async def _get_conn():
        if is_pool:
            return await conn_or_pool.acquire()
        return conn_or_pool

    async def _release_conn(c):
        if is_pool:
            await conn_or_pool.release(c)

    # Fetch staff list on a short-lived connection
    list_conn = await _get_conn()
    try:
        staff_rows = await list_conn.fetch(
            "SELECT email FROM bedrock.sync_staff WHERE enabled = true "
            "AND ($1::text[] IS NULL OR email = ANY($1)) ORDER BY email",
            staff_emails,
        )
    finally:
        await _release_conn(list_conn)

    if not staff_rows:
        return {"skipped": True, "reason": "no enabled staff in sync_staff table"}

    results = []
    for row in staff_rows:
        email = row["email"]

        # Each staff member gets a fresh connection to avoid timeout on long syncs
        staff_conn = await _get_conn()
        try:
            try:
                gmail_result = await sync_gmail_for_staff(staff_conn, email, days_back=days_back, override_since=override_since)
            except Exception as e:
                # repr(), not str(): connection-reset / cancelled-task errors
                # have an empty str() and were logging as "failed for X: " (blank).
                logger.error("gmail sync failed for %s: %r", email, e)
                gmail_result = {"staff_email": email, "error": repr(e) or type(e).__name__}

            try:
                cal_result = await sync_calendar_for_staff(staff_conn, email, days_back=days_back, override_since=override_since)
            except Exception as e:
                logger.error("calendar sync failed for %s: %r", email, e)
                cal_result = {"staff_email": email, "error": repr(e) or type(e).__name__}
        finally:
            await _release_conn(staff_conn)

        results.append({"email": email, "gmail": gmail_result, "calendar": cal_result})

    total_gmail = sum(r["gmail"].get("upserted", 0) for r in results)
    total_cal = sum(r["calendar"].get("upserted", 0) for r in results)

    # Domain enrichment pass — auto-map new domains found in this run
    domains_mapped = 0
    try:
        from services.domain_enrichment import auto_enrich_domains
        enrich_conn = await _get_conn()
        try:
            enrich_result = await auto_enrich_domains(enrich_conn)
            domains_mapped = enrich_result.get("auto_mapped", 0)
        finally:
            await _release_conn(enrich_conn)
    except Exception as e:
        logger.error("domain enrichment failed: %s", e)

    # Jobs-prospect link pass — resolve newly-synced activity to jobs prospects
    # so the Performance dashboard's Engaged/Outreach/Calls reflect this run.
    # Full pass (days_back=None), not just the synced window: the matcher only
    # UPDATEs rows where participant_public_contact_id IS NULL, so an unbounded
    # run stays cheap (set-based hash join, skips already-linked rows) while
    # also back-linking the *older* history of contacts that were only recently
    # flagged as jobs prospects — which a window-bounded run permanently missed.
    prospects_linked = 0
    try:
        from services.jobs_activity_link import relink_jobs_prospect_activity
        link_conn = await _get_conn()
        try:
            link_result = await relink_jobs_prospect_activity(link_conn, days_back=None)
            prospects_linked = link_result.get("linked", 0)
        finally:
            await _release_conn(link_conn)
    except Exception as e:
        logger.error("jobs-prospect activity link failed: %s", e)

    # Auto-add pass — flag EXISTING contacts the jobs team has engaged as jobs
    # prospects so the dashboard picks them up without manual tagging.
    prospects_flagged = 0
    try:
        from services.jobs_activity_link import auto_flag_jobs_prospects
        flag_conn = await _get_conn()
        try:
            flag_result = await auto_flag_jobs_prospects(flag_conn)
            prospects_flagged = flag_result.get("flagged", 0)
        finally:
            await _release_conn(flag_conn)
        logger.info("auto-flagged %d existing contacts as jobs prospects", prospects_flagged)
    except Exception as e:
        logger.error("jobs-prospect auto-flag failed: %s", e)

    # Candidate pipeline — for external counterparties in this run's activity:
    # link to an existing/SF-mirrored contact (via the alias index), else create
    # a review candidate (owner-attributed, company from domain). This is what
    # makes new people surface automatically as "link or create" without manual
    # work. Bounded to the recent window (`since_days` or a 7-day default) so the
    # nightly stays cheap; the address/alias guards make it idempotent.
    candidates_created = 0
    candidate_links = 0
    try:
        from services.candidate_pipeline import resolve_and_queue_candidates
        cand_conn = await _get_conn()
        try:
            cand_result = await resolve_and_queue_candidates(
                cand_conn, days_back=(since_days or 7), staff_emails=staff_emails)
            candidates_created = cand_result.get("candidates_created", 0)
            candidate_links = cand_result.get("activity_linked", 0)
            # Absorb any newly-created candidates who are actually our builders
            # (save personal email to the builder record + drop from review).
            try:
                from services.builder_match import sweep_builder_candidates
                b = await sweep_builder_candidates(cand_conn)
                logger.info("builder sweep: %s", b)
            except Exception as be:
                logger.error("builder sweep failed: %s", be)
        finally:
            await _release_conn(cand_conn)
        logger.info("candidate pipeline: created %d candidates, linked %d activity rows",
                    candidates_created, candidate_links)
    except Exception as e:
        logger.error("candidate pipeline failed: %s", e)

    logger.info(
        "interaction sync complete: %d staff, %d gmail, %d calendar, %d domains auto-mapped, %d jobs prospects linked, %d jobs prospects flagged, %d candidates created",
        len(results), total_gmail, total_cal, domains_mapped, prospects_linked, prospects_flagged, candidates_created,
    )
    return {
        "staff_count": len(results),
        "gmail_upserted": total_gmail,
        "calendar_upserted": total_cal,
        "domains_auto_mapped": domains_mapped,
        "jobs_prospects_linked": prospects_linked,
        "jobs_prospects_flagged": prospects_flagged,
        "candidates_created": candidates_created,
        "candidate_activity_linked": candidate_links,
        "by_staff": results,
    }
