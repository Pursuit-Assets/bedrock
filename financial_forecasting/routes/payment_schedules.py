"""Payment schedule CRUD endpoints."""

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_auth
from dependencies import get_mcp_client, require_sf_mcp_client
from mcp_client import UnifiedMCPClient
from routes.permissions import check_permission
from security import validate_salesforce_id, escape_soql_string
from services.cache import cache

logger = logging.getLogger(__name__)

router = APIRouter(tags=["payment-schedules"])


class PaymentScheduleItem(BaseModel):
    amount: float
    scheduled_date: str  # YYYY-MM-DD format


class CreatePaymentScheduleRequest(BaseModel):
    opportunity_id: str
    payments: List[PaymentScheduleItem]
    delete_existing: bool = True


# ---------------------------------------------------------------------------
# GET payment schedule
# ---------------------------------------------------------------------------

@router.get("/api/opportunities/{opportunity_id}/payment-schedule")
async def get_payment_schedule(
    opportunity_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Get payment schedule for an opportunity."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    safe_id = escape_soql_string(opportunity_id)
    try:
        salesforce = client.salesforce

        opp_result = await salesforce.query(
            f"SELECT Id, Name, Amount, StageName FROM Opportunity WHERE Id = '{safe_id}'"
        )
        if not opp_result.get("records"):
            raise HTTPException(status_code=404, detail="Opportunity not found")

        opportunity = opp_result["records"][0]

        payment_result = await salesforce.query(
            f"""SELECT Id, npe01__Payment_Amount__c, npe01__Scheduled_Date__c,
                       npe01__Paid__c, npe01__Payment_Date__c
            FROM npe01__OppPayment__c
            WHERE npe01__Opportunity__c = '{safe_id}'
            ORDER BY npe01__Scheduled_Date__c ASC"""
        )
        payments = payment_result.get("records", [])

        return {
            "success": True,
            "opportunity": {
                "Id": opportunity["Id"],
                "Name": opportunity["Name"],
                "Amount": opportunity.get("Amount", 0),
                "StageName": opportunity.get("StageName"),
            },
            "payments": [
                {
                    "Id": p["Id"],
                    "Amount": p.get("npe01__Payment_Amount__c", 0),
                    "ScheduledDate": p.get("npe01__Scheduled_Date__c"),
                    "Paid": p.get("npe01__Paid__c", False),
                    "PaymentDate": p.get("npe01__Payment_Date__c"),
                }
                for p in payments
            ],
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in get_payment_schedule")
        raise HTTPException(status_code=500, detail="Internal server error")


# ---------------------------------------------------------------------------
# CREATE payment schedule
# ---------------------------------------------------------------------------

@router.post("/api/opportunities/create-payment-schedule")
async def create_payment_schedule(
    request: CreatePaymentScheduleRequest,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(check_permission("manage_payment_schedules")),
):
    """Create payment schedule for an opportunity."""
    # TODO: Phase 3 — use per-user SF tokens when available for write attribution
    validate_salesforce_id(request.opportunity_id, "opportunity_id")
    safe_id = escape_soql_string(request.opportunity_id)
    try:
        salesforce = client.salesforce

        # Get opportunity
        opp_result = await salesforce.query(
            f"SELECT Id, Name, Amount FROM Opportunity WHERE Id = '{safe_id}'"
        )
        if not opp_result.get("records"):
            raise HTTPException(status_code=404, detail="Opportunity not found")

        opp = opp_result["records"][0]
        opp_amount = float(opp.get("Amount", 0))

        # Validate payment total
        payment_total = sum(p.amount for p in request.payments)
        if abs(payment_total - opp_amount) > 0.01:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "Payment total doesn't match opportunity amount",
                    "opportunity_amount": opp_amount,
                    "payment_total": payment_total,
                    "difference": payment_total - opp_amount,
                    "message": f"Payment total (${payment_total:,.2f}) must equal opportunity amount (${opp_amount:,.2f})",
                },
            )

        # Delete existing payments if requested
        if request.delete_existing:
            existing_result = await salesforce.query(
                f"SELECT Id FROM npe01__OppPayment__c WHERE npe01__Opportunity__c = '{safe_id}'"
            )
            for payment in existing_result.get("records", []):
                await salesforce.delete_record("npe01__OppPayment__c", payment["Id"])

        # Create new payments
        created_payments = []
        for i, payment in enumerate(request.payments):
            result = await salesforce.create_record(
                "npe01__OppPayment__c",
                {
                    "npe01__Opportunity__c": request.opportunity_id,
                    "npe01__Payment_Amount__c": payment.amount,
                    "npe01__Scheduled_Date__c": payment.scheduled_date,
                    "npe01__Paid__c": False,
                },
            )
            created_payments.append({
                "Id": result["id"],
                "Amount": payment.amount,
                "ScheduledDate": payment.scheduled_date,
                "Number": i + 1,
            })

        # Bust backend payment caches so the next fetch sees the new schedule.
        cache.invalidate_prefix(f"opp-payments:{request.opportunity_id}")
        cache.invalidate_prefix("payments:")

        return {
            "success": True,
            "message": f"Created {len(created_payments)} payment(s) totaling ${payment_total:,.2f}",
            "payments": created_payments,
            "opportunity_name": opp.get("Name"),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in create_payment_schedule")
        raise HTTPException(status_code=500, detail="Internal server error")


# ---------------------------------------------------------------------------
# UPDATE / DELETE individual payments
# ---------------------------------------------------------------------------


class PaymentUpdate(BaseModel):
    paid: Optional[bool] = None
    received_date: Optional[str] = None  # YYYY-MM-DD
    amount: Optional[float] = None
    scheduled_date: Optional[str] = None  # YYYY-MM-DD


@router.put("/api/opportunities/{opportunity_id}/payment-schedule/{payment_id}")
async def update_payment(
    opportunity_id: str,
    payment_id: str,
    body: PaymentUpdate,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(check_permission("manage_payment_schedules")),
):
    """Update a single payment — mark as received, change amount, etc."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    validate_salesforce_id(payment_id, "payment_id")
    try:
        salesforce = client.salesforce

        # Build SF update fields
        update_fields = {}
        if body.paid is not None:
            update_fields["npe01__Paid__c"] = body.paid
        if body.received_date is not None:
            update_fields["npe01__Payment_Date__c"] = body.received_date
        elif body.paid is True:
            # Auto-set received date to today if marking as paid without explicit date
            from datetime import date
            update_fields["npe01__Payment_Date__c"] = date.today().isoformat()
        if body.paid is False:
            # Clear received date when unmarking
            update_fields["npe01__Payment_Date__c"] = None
        if body.amount is not None:
            update_fields["npe01__Payment_Amount__c"] = body.amount
        if body.scheduled_date is not None:
            update_fields["npe01__Scheduled_Date__c"] = body.scheduled_date

        if not update_fields:
            raise HTTPException(status_code=400, detail="No fields to update")

        await salesforce.update_record("npe01__OppPayment__c", payment_id, update_fields)

        # Check if all payments are now received → auto-advance opportunity
        all_payments_received = False
        if body.paid is True:
            safe_opp_id = escape_soql_string(opportunity_id)
            result = await salesforce.query(
                f"SELECT Id, npe01__Paid__c FROM npe01__OppPayment__c "
                f"WHERE npe01__Opportunity__c = '{safe_opp_id}'"
            )
            payments = result.get("records", [])
            all_payments_received = all(
                p.get("npe01__Paid__c", False) or p["Id"] == payment_id
                for p in payments
            )

            if all_payments_received and payments:
                # Auto-advance to Closed / Completed (Pursuit SF schema)
                opp_result = await salesforce.query(
                    f"SELECT StageName FROM Opportunity WHERE Id = '{safe_opp_id}'"
                )
                current_stage = opp_result["records"][0]["StageName"] if opp_result.get("records") else None
                if current_stage and current_stage != "Closed / Completed":
                    await salesforce.update_record(
                        "Opportunity", opportunity_id,
                        {"StageName": "Closed / Completed"},
                    )
                    logger.info(f"Opportunity {opportunity_id} auto-advanced to Closed / Completed")

        return {
            "success": True,
            "message": "Payment updated",
            "all_payments_received": all_payments_received,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in update_payment")
        raise HTTPException(status_code=500, detail="Failed to update payment")


@router.delete("/api/opportunities/{opportunity_id}/payment-schedule/{payment_id}")
async def delete_payment(
    opportunity_id: str,
    payment_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(check_permission("manage_payment_schedules")),
):
    """Delete a single payment from a schedule."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    validate_salesforce_id(payment_id, "payment_id")
    try:
        salesforce = client.salesforce
        await salesforce.delete_record("npe01__OppPayment__c", payment_id)
        return {"success": True, "message": "Payment deleted"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in delete_payment")
        raise HTTPException(status_code=500, detail="Failed to delete payment")
