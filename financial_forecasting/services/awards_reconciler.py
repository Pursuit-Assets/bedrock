"""Awards reconciler — periodic catch-up for award rows.

Bedrock auto-creates a `bedrock.award` row when an opp transitions into an
award-eligible stage *through Bedrock's update-stage endpoint*. When the
stage is changed directly in Salesforce (UI, workflow rule, flow,
data-loader, etc.), the side-effect never fires and the award row is
missing.

This reconciler runs as a daily background task (and as an on-demand
admin endpoint). It's a single bulk SOQL query for all opps in
eligible stages, then idempotent INSERTs for any that lack an award.
"""

from __future__ import annotations

import logging
from datetime import date as date_type
from typing import Any, Dict, Optional

from services.awards_service import (
    ELIGIBLE_STAGES_BY_RECORD_TYPE,
    initial_award_status,
    is_award_eligible,
)

logger = logging.getLogger(__name__)


def _build_eligible_soql() -> str:
    """SOQL fetching every Opp in any (record_type, stage) award-eligible pair.

    Filters with explicit (RecordType.Name, StageName) tuples so SF
    pre-filters efficiently — much cheaper than fetching all opps and
    filtering in Python.
    """
    parts = []
    for rt, stages in ELIGIBLE_STAGES_BY_RECORD_TYPE.items():
        # SOQL string literals — escape single quotes in the unlikely
        # case a stage name contains one (none currently do).
        rt_lit = rt.replace("'", "\\'")
        stage_list = ", ".join(f"'{s.replace(chr(39), chr(92) + chr(39))}'" for s in stages)
        parts.append(f"(RecordType.Name = '{rt_lit}' AND StageName IN ({stage_list}))")
    where = " OR ".join(parts)
    return (
        "SELECT Id, StageName, RecordType.Name, CloseDate "
        f"FROM Opportunity WHERE ({where}) "
        "ORDER BY LastModifiedDate DESC LIMIT 5000"
    )


async def reconcile_all(conn, sf_client) -> Dict[str, Any]:
    """Find every award-eligible opp in SF and ensure a bedrock.award row exists.

    Idempotent: opps with an existing (non-deleted) award row are
    skipped via the partial unique index `uq_award_opp_active`.

    Returns a summary dict for logging / endpoint response.
    """
    soql = _build_eligible_soql()
    try:
        result = await sf_client.query(soql)
    except Exception:
        logger.exception("awards.reconcile: SF query failed")
        return {"created": 0, "skipped": 0, "errors": 1, "scanned": 0,
                "error_detail": "soql_failed"}

    records = result.get("records") or []
    scanned = len(records)
    created = 0
    skipped = 0
    errors = 0
    created_ids: list[str] = []

    # Pull the set of opp ids that already have an active award row
    # in one query, so we don't issue N selects.
    rows = await conn.fetch(
        "SELECT opportunity_id FROM bedrock.award WHERE deleted_at IS NULL"
    )
    existing = {r["opportunity_id"] for r in rows}

    for rec in records:
        opp_id = rec.get("Id")
        if not opp_id:
            continue
        if opp_id in existing:
            skipped += 1
            continue
        stage = rec.get("StageName")
        rt = (rec.get("RecordType") or {}).get("Name")
        if not is_award_eligible(stage, rt):
            # Defensive — SOQL filter should make this impossible, but
            # don't trust it.
            skipped += 1
            continue

        close_date = rec.get("CloseDate")
        if isinstance(close_date, str):
            try:
                close_date = date_type.fromisoformat(close_date)
            except (ValueError, TypeError):
                close_date = None

        try:
            await conn.execute(
                """
                INSERT INTO bedrock.award (opportunity_id, award_status, award_date, notes)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (opportunity_id) WHERE deleted_at IS NULL DO NOTHING
                """,
                opp_id,
                initial_award_status(stage),
                close_date,
                f"Auto-created by reconciler — opp was in {stage} without an award row.",
            )
            created += 1
            created_ids.append(opp_id)
        except Exception:
            logger.exception("awards.reconcile: insert failed for opp=%s", opp_id)
            errors += 1

    summary = {
        "scanned": scanned,
        "created": created,
        "skipped": skipped,
        "errors": errors,
        "created_ids": created_ids[:50],  # cap to keep responses small
    }
    logger.info("awards.reconcile complete: %s", summary)
    return summary
