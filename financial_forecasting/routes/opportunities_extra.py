"""Opportunity bulk operations and stage management endpoints."""

import re
import logging
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import require_auth
from dependencies import get_mcp_client
from mcp_client import UnifiedMCPClient
from models import OpportunityStage
from routes.permissions import check_permission
from security import validate_salesforce_id, escape_soql_string
from services.cache import cache, CACHE_TTL_STAGE_HISTORY

logger = logging.getLogger(__name__)

router = APIRouter(tags=["opportunities-extra"])


# ---------------------------------------------------------------------------
# Stage history
# ---------------------------------------------------------------------------

@router.get("/api/salesforce/opportunities/stage-history")
async def get_stage_history(
    days: int = Query(30, ge=1, le=365),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
):
    """Get StageName changes from OpportunityFieldHistory within the given window."""
    cache_key = f"stage_history:{days}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        salesforce = client.salesforce
        query = f"""
        SELECT OpportunityId, Opportunity.Name, Opportunity.Amount,
               Opportunity.StageName, Opportunity.OwnerId, OldValue, NewValue, CreatedDate
        FROM OpportunityFieldHistory
        WHERE Field = 'StageName'
          AND CreatedDate = LAST_N_DAYS:{days}
        ORDER BY CreatedDate DESC
        """
        result = await salesforce.query_all(query)
        records = result.get("records", [])

        formatted = []
        for r in records:
            opp = r.get("Opportunity") or {}
            formatted.append({
                "OpportunityId": r.get("OpportunityId"),
                "OpportunityName": opp.get("Name"),
                "Amount": opp.get("Amount") or 0,
                "CurrentStage": opp.get("StageName"),
                "OwnerId": opp.get("OwnerId"),
                "OldValue": r.get("OldValue"),
                "NewValue": r.get("NewValue"),
                "CreatedDate": r.get("CreatedDate"),
            })

        cache.set(cache_key, formatted, CACHE_TTL_STAGE_HISTORY)
        return formatted

    except Exception as e:
        logger.warning(f"OpportunityFieldHistory query failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Ownership history
# ---------------------------------------------------------------------------

_SF_USER_ID_RE = re.compile(r"^005[a-zA-Z0-9]{12,15}$")


@router.get("/api/salesforce/opportunities/ownership-history")
async def get_ownership_history(
    days: int = Query(7, ge=1, le=365),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
):
    """Get Owner changes from OpportunityFieldHistory within the given window.

    OldValue/NewValue in Salesforce FieldHistory may be User IDs or display
    names depending on org configuration.  When IDs are detected the endpoint
    resolves them to names via a secondary User query so the frontend always
    has human-readable values.
    """
    cache_key = f"ownership_history:{days}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        salesforce = client.salesforce
        query = f"""
        SELECT OpportunityId, Opportunity.Name, Opportunity.Amount,
               Opportunity.StageName, Opportunity.OwnerId, Opportunity.Owner.Name,
               OldValue, NewValue, CreatedDate, CreatedById, CreatedBy.Name
        FROM OpportunityFieldHistory
        WHERE Field = 'Owner'
          AND CreatedDate = LAST_N_DAYS:{days}
        ORDER BY CreatedDate DESC
        """
        result = await salesforce.query_all(query)
        records = result.get("records", [])

        # Collect any OldValue/NewValue that look like Salesforce User IDs so
        # we can resolve them to display names.
        id_values: set[str] = set()
        for r in records:
            for val in (r.get("OldValue"), r.get("NewValue")):
                if val and _SF_USER_ID_RE.match(val):
                    id_values.add(val)

        user_names: Dict[str, str] = {}
        if id_values:
            id_list = ", ".join(f"'{uid}'" for uid in id_values)
            users_result = await salesforce.query(
                f"SELECT Id, Name FROM User WHERE Id IN ({id_list})"
            )
            for u in users_result.get("records", []):
                user_names[u["Id"]] = u["Name"]

        formatted = []
        for r in records:
            opp = r.get("Opportunity") or {}
            opp_owner = opp.get("Owner") or {}
            created_by = r.get("CreatedBy") or {}
            old_raw = r.get("OldValue") or ""
            new_raw = r.get("NewValue") or ""

            formatted.append({
                "OpportunityId": r.get("OpportunityId"),
                "OpportunityName": opp.get("Name"),
                "Amount": opp.get("Amount") or 0,
                "CurrentStage": opp.get("StageName"),
                "CurrentOwnerId": opp.get("OwnerId"),
                "CurrentOwnerName": opp_owner.get("Name"),
                "OldValue": old_raw,
                "NewValue": new_raw,
                "OldOwnerName": user_names.get(old_raw, old_raw),
                "NewOwnerName": user_names.get(new_raw, new_raw),
                "ChangedById": r.get("CreatedById"),
                "ChangedByName": created_by.get("Name"),
                "CreatedDate": r.get("CreatedDate"),
            })

        cache.set(cache_key, formatted, CACHE_TTL_STAGE_HISTORY)
        return formatted

    except Exception as e:
        logger.warning(f"OpportunityFieldHistory ownership query failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Bulk update
# ---------------------------------------------------------------------------

@router.put("/api/salesforce/opportunities/bulk-update")
async def bulk_update_opportunities(
    body: dict,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(check_permission("bulk_update_opportunities")),
):
    """Bulk update multiple Salesforce opportunities at once."""
    # TODO: Phase 3 — use per-user SF tokens when available for write attribution
    try:
        salesforce = client.salesforce
        opp_ids = body.get("opportunity_ids", [])
        updates = body.get("updates", {})

        if not opp_ids or not updates:
            raise HTTPException(status_code=400, detail="Missing opportunity_ids or updates")

        success_count = 0
        failed_ids = []

        for opp_id in opp_ids:
            try:
                validate_salesforce_id(opp_id, "opportunity_id")
                await salesforce.update_record("Opportunity", opp_id, updates)
                success_count += 1
            except Exception as e:
                logger.warning(f"Failed to update opportunity {opp_id}: {e}")
                failed_ids.append(opp_id)

        cache.invalidate_prefix("opps:")
        cache.invalidate_prefix("stage_history")

        return {
            "success": True,
            "total": len(opp_ids),
            "success_count": success_count,
            "failed_count": len(failed_ids),
            "failed_ids": failed_ids,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Stage validation (shared logic used by both endpoint and update-stage)
# ---------------------------------------------------------------------------

async def _validate_stage_change_logic(
    opp_id: str,
    new_stage: str,
    salesforce,
) -> Dict[str, Any]:
    """Core validation: checks payment schedule before allowing 'Collecting / In Effect'."""
    if new_stage != OpportunityStage.COLLECTING.value:
        return {"success": True, "can_proceed": True}

    validate_salesforce_id(opp_id, "opportunity_id")
    safe_id = escape_soql_string(opp_id)

    # Get opportunity
    opp_result = await salesforce.query(
        f"SELECT Id, Name, Amount FROM Opportunity WHERE Id = '{safe_id}'"
    )
    if not opp_result.get("records"):
        raise HTTPException(status_code=404, detail="Opportunity not found")

    opp = opp_result["records"][0]
    opp_amount = float(opp.get("Amount", 0))

    # Check for payment schedule
    payment_result = await salesforce.query(
        f"""SELECT Id, npe01__Payment_Amount__c, npe01__Scheduled_Date__c
        FROM npe01__OppPayment__c
        WHERE npe01__Opportunity__c = '{safe_id}'
        ORDER BY npe01__Scheduled_Date__c ASC"""
    )
    payments = payment_result.get("records", [])

    if not payments:
        return {
            "success": False,
            "can_proceed": False,
            "error": "Payment schedule required",
            "message": (
                f"Cannot move to '{OpportunityStage.COLLECTING.value}' without a payment schedule.\n\n"
                f"Please create a payment schedule for this ${opp_amount:,.0f} opportunity first."
            ),
            "action_required": "create_payment_schedule",
        }

    payment_total = sum(float(p.get("npe01__Payment_Amount__c", 0)) for p in payments)

    if abs(payment_total - opp_amount) > 0.01:
        return {
            "success": False,
            "can_proceed": False,
            "error": "Payment schedule total doesn't match opportunity amount",
            "message": (
                f"Payment schedule total (${payment_total:,.0f}) doesn't match "
                f"opportunity amount (${opp_amount:,.0f}).\n\n"
                "Please adjust the payment schedule in Salesforce."
            ),
            "opportunity_amount": opp_amount,
            "payment_total": payment_total,
            "difference": payment_total - opp_amount,
            "action_required": "fix_payment_schedule",
        }

    return {
        "success": True,
        "can_proceed": True,
        "message": f"Payment schedule validated: {len(payments)} payment(s) totaling ${payment_total:,.0f}",
        "payment_count": len(payments),
        "payment_total": payment_total,
    }


@router.post("/api/opportunities/validate-stage-change")
async def validate_stage_change(
    request: dict,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
):
    """Validate that opportunity can move to 'Collecting / In Effect'."""
    try:
        salesforce = client.salesforce
        opp_id = request.get("opportunity_id")
        new_stage = request.get("new_stage")
        return await _validate_stage_change_logic(opp_id, new_stage, salesforce)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in validate_stage_change")
        raise HTTPException(status_code=500, detail="Internal server error")


# ---------------------------------------------------------------------------
# Stage update (with validation)
# ---------------------------------------------------------------------------

@router.post("/api/opportunities/update-stage")
async def update_opportunity_stage(
    request: dict,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(check_permission("edit_own_opportunities")),
):
    """Update opportunity stage with validation."""
    # TODO: Phase 3 — use per-user SF tokens when available for write attribution
    try:
        salesforce = client.salesforce
        opp_id = request.get("opportunity_id")
        new_stage = request.get("new_stage")

        validate_salesforce_id(opp_id, "opportunity_id")

        # Validate stage change
        validation_result = await _validate_stage_change_logic(opp_id, new_stage, salesforce)
        if not validation_result.get("can_proceed"):
            raise HTTPException(status_code=400, detail=validation_result)

        # Update stage
        await salesforce.update_record("Opportunity", opp_id, {"StageName": new_stage})
        cache.invalidate_prefix("opps:")
        cache.invalidate_prefix("stage_history")

        return {
            "success": True,
            "message": f"Opportunity stage updated to '{new_stage}'",
            "stage": new_stage,
            "validation": validation_result,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in update_opportunity_stage")
        raise HTTPException(status_code=500, detail="Internal server error")
