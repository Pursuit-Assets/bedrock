"""Payment schedule CRUD endpoints."""

import asyncio
import logging
import random
from typing import Any, Callable, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel


async def _with_lock_retry(coro_fn: Callable[[], Any], retries: int = 3) -> Any:
    """Retry an SF write that may hit UNABLE_TO_LOCK_ROW.

    The NPSP "[Payment] Payment Received" Flow updates the parent
    Opportunity from a Payment trigger. Parallel writes to several
    payments on the same opp race for the parent's exclusive lock —
    SF surfaces this as ``CANNOT_EXECUTE_FLOW_TRIGGER ... UNABLE_TO_LOCK_ROW``.
    Retrying with a tiny jittered backoff almost always wins on the
    second try; SF's lock is held for the duration of the Flow which
    is sub-second.

    Retries are independent of higher-level concurrency control. We
    pass a callable (not a coroutine) so the second attempt creates a
    fresh awaitable — an awaited coroutine can't be re-awaited.
    """
    last_exc: Exception | None = None
    for attempt in range(retries):
        try:
            return await coro_fn()
        except Exception as e:
            msg = str(e)
            if "UNABLE_TO_LOCK_ROW" not in msg and "CANNOT_EXECUTE_FLOW_TRIGGER" not in msg:
                raise
            last_exc = e
            if attempt < retries - 1:
                # 80–240ms, 200–600ms, ... exponential with jitter.
                await asyncio.sleep((0.08 + random.random() * 0.16) * (2.5 ** attempt))
    assert last_exc is not None
    raise last_exc

from auth import require_auth
from dependencies import get_mcp_client, require_sf_mcp_client
from mcp_client import UnifiedMCPClient
from routes.permissions import check_permission
from security import validate_salesforce_id, escape_soql_string
from sf_errors import sf_http_error
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
        raise sf_http_error(e, "payment schedule")


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
        raw_amount = opp.get("Amount")
        # Opportunities can have a NULL Amount in SF (new opps where the
        # user hasn't filled it in yet, or where the gate dialog just
        # typed a value but hasn't persisted it). float(None) raises —
        # treat null as "no amount set" and require the caller to fix
        # it before submitting a schedule.
        if raw_amount is None:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "Opportunity has no Amount set",
                    "message": "Set the opportunity Amount before creating a payment schedule.",
                },
            )
        opp_amount = float(raw_amount)

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
                    "message": f"Payment total (${payment_total:,.2f}) must equal opportunity amount (${opp_amount:,.2f}).",
                },
            )

        # Delete existing (unpaid) payments first. Parallel here is
        # safe — DELETE doesn't fire the Payment Received Flow.
        if request.delete_existing:
            existing_result = await salesforce.query(
                f"SELECT Id, npe01__Paid__c FROM npe01__OppPayment__c "
                f"WHERE npe01__Opportunity__c = '{safe_id}'"
            )
            to_delete = [
                p["Id"]
                for p in existing_result.get("records", [])
                if not p.get("npe01__Paid__c")
            ]
            if to_delete:
                await asyncio.gather(*(
                    _with_lock_retry(
                        lambda pid=pid: salesforce.delete_record("npe01__OppPayment__c", pid),
                    )
                    for pid in to_delete
                ))

        # Create payments SEQUENTIALLY. The NPSP "[Payment] Payment
        # Received" Flow updates the parent Opportunity on insert, and
        # parallel inserts on the same parent deadlock the row. With
        # optimistic-close on the frontend the user doesn't perceive
        # the small extra latency, and we avoid UNABLE_TO_LOCK_ROW.
        def _create_fn(payment: PaymentScheduleItem):
            return lambda: salesforce.create_record(
                "npe01__OppPayment__c",
                {
                    "npe01__Opportunity__c": request.opportunity_id,
                    "npe01__Payment_Amount__c": payment.amount,
                    "npe01__Scheduled_Date__c": payment.scheduled_date,
                    "npe01__Paid__c": False,
                },
            )

        results = []
        for p in request.payments:
            results.append(await _with_lock_retry(_create_fn(p)))
        created_payments = [
            {
                "Id": result["id"],
                "Amount": payment.amount,
                "ScheduledDate": payment.scheduled_date,
                "Number": i + 1,
            }
            for i, (payment, result) in enumerate(zip(request.payments, results))
        ]

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
        # Surface the underlying SF error so the user can see WHY the
        # POST failed. Salesforce errors are usually actionable (missing
        # required field, validation rule, deletion of paid payment,
        # etc.) — burying them behind a generic 500 leaves the user
        # debugging blind.
        raise sf_http_error(e, "payment schedule")


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

        # Wrap with lock-retry — the same NPSP Flow that bites parallel
        # inserts can also fire on update when ``npe01__Paid__c`` flips.
        await _with_lock_retry(
            lambda: salesforce.update_record("npe01__OppPayment__c", payment_id, update_fields),
        )

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
        raise sf_http_error(e, "payment")


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
        await _with_lock_retry(
            lambda: salesforce.delete_record("npe01__OppPayment__c", payment_id),
        )
        return {"success": True, "message": "Payment deleted"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in delete_payment")
        raise sf_http_error(e, "payment")
