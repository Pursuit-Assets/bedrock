"""Pipeline Review API — backs the weekly pipeline meeting dashboard.

One endpoint: `GET /api/pipeline-review/opportunity-changes` returns
opportunity-level rows grouped by opp, each carrying its
stage/amount/probability/close-date changes in a recent window.
Activity-feed and meeting data come from the existing /api/activities
listing; SF Task creation goes through /api/salesforce/tasks.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import require_auth
from dependencies import get_mcp_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/pipeline-review", tags=["pipeline-review"])

# Fields whose changes we surface in the dashboard. Kept short and
# pipeline-meeting-actionable; close_date is in here because close-date
# pushes are a routine review topic.
TRACKED_FIELDS = ("StageName", "Amount", "Probability", "CloseDate")

DEFAULT_DAYS = 7
MAX_DAYS = 60


@router.get("/opportunity-changes")
async def opportunity_changes(
    days: int = Query(DEFAULT_DAYS, ge=1, le=MAX_DAYS),
    owner_id: Optional[str] = Query(
        None,
        description="Filter to opps owned by this SF User Id. Omit for all.",
    ),
    client=Depends(get_mcp_client),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    """One row per opportunity that had a tracked-field change in the
    last `days` days, with all of that opp's changes nested inside.
    Sorted by most-recent change first."""
    sf = getattr(client, "salesforce", None)
    if not client or "salesforce" not in (client.connected_services or []) or sf is None:
        return {"success": True, "data": []}

    since = datetime.now(timezone.utc) - timedelta(days=days)
    since_soql = since.strftime("%Y-%m-%dT%H:%M:%SZ")

    fields_clause = ", ".join(f"'{f}'" for f in TRACKED_FIELDS)
    owner_clause = ""
    if owner_id:
        if not owner_id.isalnum() or len(owner_id) not in (15, 18):
            raise HTTPException(status_code=400, detail="Invalid owner_id")
        owner_clause = f" AND OpportunityId IN (SELECT Id FROM Opportunity WHERE OwnerId = '{owner_id}') "

    history_soql = f"""
        SELECT Id, OpportunityId, Field, OldValue, NewValue,
               CreatedDate, CreatedById, CreatedBy.Name
        FROM OpportunityFieldHistory
        WHERE Field IN ({fields_clause})
          AND CreatedDate > {since_soql}
          {owner_clause}
        ORDER BY CreatedDate DESC
        LIMIT 2000
    """
    try:
        result = await sf.query(history_soql)
    except Exception as e:
        logger.warning("opportunity_changes history SOQL failed: %s", e)
        return {"success": True, "data": []}

    rows = result.get("records") or []
    if not rows:
        return {"success": True, "data": []}

    by_opp: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        opp_id = r.get("OpportunityId")
        if not opp_id:
            continue
        by_opp[opp_id].append(r)

    opp_ids = list(by_opp.keys())
    in_list = ", ".join(f"'{i}'" for i in opp_ids)
    opp_soql = (
        "SELECT Id, Name, AccountId, Account.Name, OwnerId, Owner.Name, "
        "StageName, Amount, Probability, CloseDate "
        f"FROM Opportunity WHERE Id IN ({in_list}) LIMIT {len(opp_ids)}"
    )
    try:
        opp_result = await sf.query(opp_soql)
    except Exception as e:
        logger.warning("opportunity_changes opp SOQL failed: %s", e)
        return {"success": True, "data": []}
    opp_lookup: Dict[str, Dict[str, Any]] = {
        o["Id"]: o for o in (opp_result.get("records") or [])
    }

    out: List[Dict[str, Any]] = []
    for opp_id, hist_rows in by_opp.items():
        opp = opp_lookup.get(opp_id) or {}
        hist_rows.sort(key=lambda r: r.get("CreatedDate") or "", reverse=True)
        changes: List[Dict[str, Any]] = []
        for r in hist_rows:
            changes.append({
                "field": r.get("Field"),
                "from": r.get("OldValue"),
                "to": r.get("NewValue"),
                "at": r.get("CreatedDate"),
                "by_name": (r.get("CreatedBy") or {}).get("Name"),
                "by_id": r.get("CreatedById"),
            })
        out.append({
            "opportunity_id": opp_id,
            "name": opp.get("Name") or opp_id,
            "account_id": opp.get("AccountId"),
            "account_name": (opp.get("Account") or {}).get("Name"),
            "owner_id": opp.get("OwnerId"),
            "owner_name": (opp.get("Owner") or {}).get("Name"),
            "stage_name": opp.get("StageName"),
            "amount": opp.get("Amount"),
            "probability": opp.get("Probability"),
            "close_date": opp.get("CloseDate"),
            "last_change_at": changes[0]["at"] if changes else None,
            "changes": changes,
        })

    out.sort(key=lambda x: x.get("last_change_at") or "", reverse=True)
    return {"success": True, "data": out}
