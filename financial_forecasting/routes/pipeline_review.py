"""Pipeline Review API — backs the weekly pipeline meeting dashboard.

Exposes a single endpoint for opportunity changes since a watermark
(stage, amount, probability, close-date). Activity-feed and meeting
data come from the existing /api/activities listing; SF Task
creation goes through the existing /api/salesforce/tasks endpoint.

Why a dedicated endpoint for changes:
- The frontend wants opp-level rows ("Acme Foundation — Qualifying →
  Ask in Progress, by Jac, 2 days ago"), not raw field-history rows.
- We collapse multiple fields per opp into one row (so a single edit
  that touched both Amount and Stage shows as one card, not two).
- We resolve OwnerId / CreatedById to a person name so the UI doesn't
  need a second SF query per row.
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


# Fields whose changes we surface in the dashboard. Keep this short and
# pipeline-meeting-actionable; close_date is in here because closing
# date pushes are a routine review topic.
TRACKED_FIELDS = ("StageName", "Amount", "Probability", "CloseDate")

# How much OpportunityFieldHistory to scan in one window. SF's per-query
# row cap is 2000 (query_all paginates); we use a soft per-window cap
# to keep payloads reasonable for the UI.
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
    """Return one row per opportunity that had a tracked-field change
    in the last `days` days, with all of that opp's changes nested
    inside. Owner filter narrows to a single RM for the per-RM
    walkthrough phase of the meeting.

    Returns ``{success, data: [...]}`` where each item is:

        {
            "opportunity_id": "006Pa00000...",
            "name": "Acme Foundation FY26 — $100K",
            "account_name": "Acme Foundation",
            "owner_name": "Allie Mikalatos",
            "stage_name": "Ask in Progress",        // current
            "amount": 100000.0,                     // current
            "probability": 50.0,                    // current
            "close_date": "2026-08-01",             // current
            "last_change_at": "2026-05-24T14:22:00+0000",
            "changes": [
                {
                    "field": "StageName",
                    "from": "Qualifying",
                    "to": "Ask in Progress",
                    "at": "...",
                    "by_name": "Jac Reverand",
                },
                ...
            ],
        }
    """
    sf = getattr(client, "salesforce", None)
    if not client or "salesforce" not in (client.connected_services or []) or sf is None:
        # Service-account fallback also handled by get_mcp_client. If we
        # still don't have SF connected, return empty so the UI doesn't
        # blow up; just renders the "no recent changes" state.
        return {"success": True, "data": []}

    since = datetime.now(timezone.utc) - timedelta(days=days)
    since_soql = since.strftime("%Y-%m-%dT%H:%M:%SZ")

    fields_clause = ", ".join(f"'{f}'" for f in TRACKED_FIELDS)
    owner_clause = ""
    if owner_id:
        # Validate Salesforce id shape (15/18 char). Defensive — the
        # body of the query is interpolated, so reject anything that
        # doesn't look like a SF id before splicing.
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

    # Bucket history rows by OpportunityId.
    by_opp: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        opp_id = r.get("OpportunityId")
        if not opp_id:
            continue
        by_opp[opp_id].append(r)

    # Batch-load each opp's current header info in one SOQL — name,
    # account, owner, current stage/amount/probability/close. Keeps
    # the per-row work to a constant number of API calls.
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
        # Sort changes newest-first within the opp.
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

    # Sort opp groups by most-recent-change descending so the freshest
    # work surfaces at the top of the dashboard.
    out.sort(key=lambda x: x.get("last_change_at") or "", reverse=True)
    return {"success": True, "data": out}
