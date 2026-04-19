"""AI pipeline analysis and automation review endpoints.

Ported from simple_server.py: POST /api/ai/pipeline-analysis, POST /api/automation-review/ingest-pipeline
Extracted from main.py: POST /api/slack/webhook, GET /api/automation-review/pending,
    GET /api/automation-review/all, POST /api/automation-review/{item_id}/approve,
    POST /api/automation-review/{item_id}/reject
"""

import json
import logging
import os
import re
import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Body, Depends, HTTPException

from auth import require_auth
from db import get_db
from dependencies import get_mcp_client
from mcp_client import UnifiedMCPClient
from models import ApiResponse
from security import validate_salesforce_id
from services.crm_parser import parse_crm_message, get_opp_cache

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ai"])

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
SLACK_PIPELINE_CHANNEL = os.getenv("SLACK_PIPELINE_CHANNEL", "pipeline-updates")

# ---------------------------------------------------------------------------
# Module-level state (production: move to DB)
# ---------------------------------------------------------------------------

_automation_queue: Dict[str, Dict[str, Any]] = {}
_ingested_slack_ts: set = set()

# Strict YYYY-MM-DD. The character class is deliberately narrow: digits and
# hyphen only. That lets us interpolate validated values directly into SOQL
# datetime literals (`CreatedDate >= 2026-01-01T00:00:00Z`) without escaping,
# because no SOQL-breaking character (quote, whitespace, comment, wildcard,
# operator) can pass the regex. Same discipline as validate_salesforce_id.
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _parse_pipeline_time_window(
    payload: Dict[str, Any],
) -> Tuple[int, Optional[str], Optional[str]]:
    """Parse the time-window section of an /api/ai/pipeline-analysis payload.

    Returns (days, start_or_none, end_or_none).
    - If `start`/`end` provided: both returned as validated YYYY-MM-DD strings,
      and `days` is computed as an integer span (inclusive day count) for
      backward-compatible response shape.
    - Otherwise: `days` is the validated int (default 30), start/end are None.

    Raises HTTPException(400) on any validation failure.
    """
    raw_days = payload.get("days")
    raw_start = payload.get("start")
    raw_end = payload.get("end")

    has_days = raw_days is not None
    has_start = raw_start is not None
    has_end = raw_end is not None

    if has_start != has_end:
        raise HTTPException(
            status_code=400, detail="start and end must be provided together"
        )
    if (has_start or has_end) and has_days:
        raise HTTPException(
            status_code=400,
            detail="provide either days or start+end, not both",
        )

    if has_start and has_end:
        if not isinstance(raw_start, str) or not isinstance(raw_end, str):
            raise HTTPException(
                status_code=400, detail="start and end must be YYYY-MM-DD strings"
            )
        if not _ISO_DATE_RE.match(raw_start) or not _ISO_DATE_RE.match(raw_end):
            raise HTTPException(
                status_code=400,
                detail="start and end must match YYYY-MM-DD format",
            )
        try:
            start_dt = datetime.strptime(raw_start, "%Y-%m-%d").replace(
                tzinfo=timezone.utc
            )
            end_dt = datetime.strptime(raw_end, "%Y-%m-%d").replace(
                tzinfo=timezone.utc, hour=23, minute=59, second=59
            )
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail="start and end must be valid calendar dates",
            )
        if start_dt > end_dt:
            raise HTTPException(
                status_code=400, detail="start must be on or before end"
            )
        now_utc = datetime.now(timezone.utc)
        if start_dt < now_utc - timedelta(days=365):
            raise HTTPException(
                status_code=400,
                detail="start must be within the last 365 days",
            )
        # Allow end up to end-of-today by permitting one extra day of slack.
        if end_dt > now_utc + timedelta(days=1):
            raise HTTPException(
                status_code=400, detail="end cannot be in the future"
            )
        span_days = (end_dt.date() - start_dt.date()).days + 1
        return span_days, raw_start, raw_end

    days = raw_days if has_days else 30
    if not isinstance(days, int) or isinstance(days, bool) or days < 1 or days > 365:
        raise HTTPException(
            status_code=400, detail="days must be an integer between 1 and 365"
        )
    return days, None, None


# ---------------------------------------------------------------------------
# POST /api/ai/pipeline-analysis
# ---------------------------------------------------------------------------

@router.post("/api/ai/pipeline-analysis")
async def ai_pipeline_analysis(
    payload: Dict[str, Any] = Body(...),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
):
    """On-demand AI analysis of pipeline stage changes and funnel health.

    Optional owner_ids list scopes both the snapshot and history queries to
    those Salesforce User IDs so the LLM analysis is per-RM (or per subset).
    """
    if not ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="AI analysis not configured (missing ANTHROPIC_API_KEY)",
        )

    days, start, end = _parse_pipeline_time_window(payload)

    raw_owner_ids = payload.get("owner_ids") or []
    if not isinstance(raw_owner_ids, list):
        raise HTTPException(
            status_code=400, detail="owner_ids must be a list of Salesforce User IDs"
        )
    owner_ids: List[str] = []
    for oid in raw_owner_ids:
        if not isinstance(oid, str):
            raise HTTPException(status_code=400, detail="owner_ids must be strings")
        validate_salesforce_id(oid, "owner_id")
        owner_ids.append(oid)

    owner_filter_clause = ""
    snapshot_owner_clause = ""
    owner_names_lookup: Dict[str, str] = {}
    if owner_ids:
        # IDs already validated to match the strict SF ID regex, so direct
        # interpolation is safe (no string escaping needed).
        id_list = ", ".join(f"'{oid}'" for oid in owner_ids)
        owner_filter_clause = f" AND Opportunity.OwnerId IN ({id_list})"
        snapshot_owner_clause = f" AND OwnerId IN ({id_list})"

    try:
        import anthropic

        salesforce = client.salesforce

        # Resolve owner IDs to display names so the prompt can reference RMs
        if owner_ids:
            try:
                id_list = ", ".join(f"'{oid}'" for oid in owner_ids)
                users_result = await salesforce.query(
                    f"SELECT Id, Name FROM User WHERE Id IN ({id_list})"
                )
                for u in users_result.get("records", []):
                    owner_names_lookup[u["Id"]] = u.get("Name") or u["Id"]
            except Exception as e:
                logger.warning(f"Failed to resolve owner names for analysis: {e}")

        # SOQL date literal: either LAST_N_DAYS:n (preset) or an explicit
        # range (custom). start/end are regex-validated (digits + hyphen
        # only) so direct interpolation is injection-safe — matches the
        # validate_salesforce_id pattern used for owner_filter_clause above.
        if start is not None and end is not None:
            time_clause = (
                f"CreatedDate >= {start}T00:00:00Z "
                f"AND CreatedDate <= {end}T23:59:59Z"
            )
        else:
            time_clause = f"CreatedDate = LAST_N_DAYS:{days}"

        history_query = f"""
        SELECT OpportunityId, Opportunity.Name, Opportunity.Amount,
               Opportunity.StageName, OldValue, NewValue, CreatedDate
        FROM OpportunityFieldHistory
        WHERE Field = 'StageName'
          AND {time_clause}{owner_filter_clause}
        ORDER BY CreatedDate DESC
        """
        history_result = await salesforce.query_all(history_query)
        changes = history_result.get("records", [])

        snapshot_query = f"""
        SELECT StageName, COUNT(Id) cnt, SUM(Amount) total
        FROM Opportunity
        WHERE IsClosed = false{snapshot_owner_clause}
        GROUP BY StageName
        ORDER BY StageName
        """
        snapshot_result = await salesforce.query_all(snapshot_query)
        stage_snapshot = [
            {
                "stage": r["StageName"],
                "count": r["cnt"],
                "totalAmount": r.get("total") or 0,
            }
            for r in snapshot_result.get("records", [])
        ]

        formatted_changes = []
        for r in changes:
            opp = r.get("Opportunity") or {}
            formatted_changes.append(
                {
                    "opportunity": opp.get("Name"),
                    "amount": opp.get("Amount") or 0,
                    "from": r.get("OldValue"),
                    "to": r.get("NewValue"),
                    "date": r.get("CreatedDate"),
                }
            )

        if owner_ids:
            owner_names = [owner_names_lookup.get(oid, oid) for oid in owner_ids]
            scope_line = f"SCOPE: This analysis covers {len(owner_ids)} Relationship Manager(s): {', '.join(owner_names)}."
        else:
            scope_line = "SCOPE: This analysis covers the entire team's pipeline."

        if start is not None and end is not None:
            window_heading = f"STAGE CHANGES FROM {start} TO {end}"
        else:
            window_heading = f"STAGE CHANGES IN THE LAST {days} DAYS"

        prompt = f"""You are a pipeline analyst for a nonprofit fundraising team managing grant opportunities.

{scope_line}

CURRENT PIPELINE SNAPSHOT (open opportunities by stage):
{json.dumps(stage_snapshot, indent=1)}

{window_heading} ({len(formatted_changes)} total):
{json.dumps(formatted_changes[:50], default=str, indent=1)}

Analyze the pipeline health in 3-5 concise bullet points covering:
- Pipeline velocity: Are opportunities moving forward through stages?
- Stagnation risk: Any stages with many opps but little movement?
- Stage conversion: Which transitions are happening most/least?
- Actionable recommendations: What should the team focus on?

Be specific — reference actual stage names, counts, and dollar amounts. Keep each bullet to 1-2 sentences. Use plain text, no markdown formatting."""

        ai_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        response = ai_client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1000,
            messages=[{"role": "user", "content": prompt}],
        )
        analysis_text = response.content[0].text.strip()

        return {
            "analysis": analysis_text,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "changes_count": len(formatted_changes),
            "days": days,
            "start": start,
            "end": end,
            "owner_ids": owner_ids,
            "owner_names": [owner_names_lookup.get(oid, oid) for oid in owner_ids],
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"AI pipeline analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# POST /api/automation-review/ingest-pipeline
# ---------------------------------------------------------------------------

@router.post("/api/automation-review/ingest-pipeline")
async def ingest_pipeline_updates(
    limit: int = 20,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
):
    """Fetch new messages from #pipeline-updates and feed them through
    parse_crm_message -> _automation_queue. Deduplicates by Slack timestamp."""
    try:
        slack_service = client.services.get("slack")
        if not slack_service:
            raise HTTPException(status_code=503, detail="Slack service not connected")

        # Find the channel
        channels = await slack_service.get_channels(limit=200)
        target_channel = None
        for ch in channels:
            if ch.get("name") == SLACK_PIPELINE_CHANNEL:
                target_channel = ch
                break

        if not target_channel:
            return {
                "ingested": 0,
                "error": f"Channel #{SLACK_PIPELINE_CHANNEL} not found",
            }

        channel_id = target_channel["id"]
        messages = await slack_service.get_channel_history(channel_id, limit=limit)
        if not messages:
            return {"ingested": 0, "total_queued": len(_automation_queue)}

        # Normalize: get_channel_history may return a list or a dict with "messages"
        if isinstance(messages, dict):
            messages = messages.get("messages", [])

        # Resolve user names
        user_cache_local: Dict[str, str] = {}
        try:
            users = await slack_service.get_users(limit=200)
            for u in users:
                user_cache_local[u["id"]] = (
                    u.get("real_name") or u.get("name", u["id"])
                )
        except Exception:
            pass

        ingested = 0
        for msg in messages:
            ts = msg.get("ts", "")
            if not ts or ts in _ingested_slack_ts:
                continue

            text = msg.get("text", "").strip()
            if not text:
                continue

            _ingested_slack_ts.add(ts)

            uid = msg.get("user", "")
            user_name = user_cache_local.get(uid, uid)
            parsed = parse_crm_message(text)

            item_id = str(_uuid.uuid4())
            _automation_queue[item_id] = {
                "id": item_id,
                "source": f"slack:#{SLACK_PIPELINE_CHANNEL}",
                "user_name": user_name,
                "raw_text": text,
                "parsed": parsed,
                "status": "pending",
                "created_at": datetime.utcnow().isoformat(),
                "slack_ts": ts,
                "reviewed_by": None,
                "reviewed_at": None,
            }
            ingested += 1

        return {"ingested": ingested, "total_queued": len(_automation_queue)}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Pipeline ingest error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# POST /api/slack/webhook
# ---------------------------------------------------------------------------

@router.post("/api/slack/webhook")
async def slack_webhook(
    payload: Dict[str, Any],
    user=Depends(require_auth),
    db=Depends(get_db),
):
    """Receive a Slack message and parse it as a CRM update."""
    text = payload.get("text", "")
    channel = payload.get("channel", "")
    user_name = payload.get("user_name", user.get("name", "Unknown"))

    if not text:
        raise HTTPException(status_code=400, detail="Empty message text")

    parsed = parse_crm_message(text, get_opp_cache())

    item_id = str(_uuid.uuid4())
    _automation_queue[item_id] = {
        "id": item_id,
        "source": "slack",
        "source_detail": {"channel": channel, "user": user_name},
        "raw_text": text,
        "parsed": parsed,
        "status": "pending",
        "created_at": datetime.now().isoformat(),
    }

    return ApiResponse(
        success=True,
        data={"id": item_id, "parsed": parsed},
        meta={"message": "CRM update queued for review"},
    )


# ---------------------------------------------------------------------------
# GET /api/automation-review/pending
# ---------------------------------------------------------------------------

@router.get("/api/automation-review/pending")
async def get_pending_reviews(user=Depends(require_auth)):
    """List all pending CRM updates awaiting review."""
    pending = [
        item
        for item in _automation_queue.values()
        if item["status"] == "pending"
    ]
    pending.sort(key=lambda x: x["created_at"], reverse=True)
    return ApiResponse(success=True, data=pending, meta={"count": len(pending)})


# ---------------------------------------------------------------------------
# GET /api/automation-review/all
# ---------------------------------------------------------------------------

@router.get("/api/automation-review/all")
async def get_all_reviews(user=Depends(require_auth)):
    """List all CRM updates (pending, approved, rejected)."""
    items = list(_automation_queue.values())
    items.sort(key=lambda x: x["created_at"], reverse=True)
    return ApiResponse(success=True, data=items, meta={"count": len(items)})


# ---------------------------------------------------------------------------
# POST /api/automation-review/{item_id}/approve
# ---------------------------------------------------------------------------

@router.post("/api/automation-review/{item_id}/approve")
async def approve_review(
    item_id: str,
    edits: Optional[Dict[str, Any]] = None,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
    db=Depends(get_db),
):
    """Approve a pending CRM update and apply to Salesforce."""
    item = _automation_queue.get(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Review item not found")
    if item["status"] != "pending":
        raise HTTPException(
            status_code=400, detail=f"Item already {item['status']}"
        )

    parsed = item["parsed"]
    if edits:
        parsed.update(edits)

    # Apply to Salesforce
    try:
        salesforce = client.salesforce
        opp_id = parsed.get("matched_opportunity")
        if opp_id:
            validate_salesforce_id(opp_id, "matched_opportunity")

        if parsed["action"] == "stage_change" and opp_id and parsed.get("stage"):
            update_fields: Dict[str, Any] = {"StageName": parsed["stage"]}
            if parsed.get("amount"):
                update_fields["Amount"] = parsed["amount"]
            if parsed.get("close_date"):
                update_fields["CloseDate"] = parsed["close_date"]
            await salesforce.update_record("Opportunity", opp_id, update_fields)

        elif parsed["action"] == "task" and opp_id:
            # Check if opportunity is locked before creating task via Slack
            opp_lock = await db.fetchrow(
                "SELECT locked_by FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1",
                opp_id,
            )
            if opp_lock:
                logger.warning(
                    f"Slack task creation blocked — opportunity {opp_id} is locked"
                )
            else:
                await salesforce.create_record(
                    "Task",
                    {
                        "Subject": parsed.get("detail", "Follow up")[:255],
                        "WhatId": opp_id,
                        "Status": "Not Started",
                        "Priority": "Normal",
                    },
                )

        elif parsed["action"] == "note" and opp_id:
            # Append to Description
            opp = await salesforce.query(
                f"SELECT Description FROM Opportunity WHERE Id = '{opp_id}' LIMIT 1"
            )
            existing = (
                opp.get("records", [{}])[0].get("Description", "") or ""
            )
            note = f"\n[{datetime.now().strftime('%Y-%m-%d')} via Slack] {parsed['detail']}"
            await salesforce.update_record(
                "Opportunity", opp_id, {"Description": existing + note}
            )

        item["status"] = "approved"
        item["approved_at"] = datetime.now().isoformat()
        item["approved_by"] = user.get("user_id", "unknown")
        return ApiResponse(success=True, data=item)

    except Exception as e:
        logger.error(f"Failed to apply CRM update {item_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# POST /api/automation-review/{item_id}/reject
# ---------------------------------------------------------------------------

@router.post("/api/automation-review/{item_id}/reject")
async def reject_review(
    item_id: str,
    reason: Optional[str] = None,
    user=Depends(require_auth),
):
    """Reject a pending CRM update."""
    item = _automation_queue.get(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Review item not found")
    if item["status"] != "pending":
        raise HTTPException(
            status_code=400, detail=f"Item already {item['status']}"
        )

    item["status"] = "rejected"
    item["rejected_at"] = datetime.now().isoformat()
    item["rejected_by"] = user.get("user_id", "unknown")
    item["rejection_reason"] = reason
    return ApiResponse(success=True, data=item)
