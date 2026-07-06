"""Finance dashboard endpoints — invoicing, payment sync, cashflow."""

import asyncio
import logging
import os
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_auth
from dependencies import get_mcp_client, require_sf_mcp_client
from mcp_client import UnifiedMCPClient
from models import OpportunityStage, ApiResponse
from routes.permissions import check_permission
from security import validate_salesforce_id, escape_soql_string
from sf_errors import sf_http_error
from services.cache import cache

logger = logging.getLogger(__name__)

router = APIRouter(tags=["finance"])


class CreateInvoiceRequest(BaseModel):
    payment_id: str
    send_email: bool = False


# ---------------------------------------------------------------------------
# Cashflow summary (extracted from main.py)
# ---------------------------------------------------------------------------

@router.get("/api/cashflow/summary")
async def cashflow_summary(user=Depends(require_auth)):
    """Placeholder cashflow summary for frontend."""
    return ApiResponse(success=True, data={
        "total_pipeline": 0,
        "weighted_pipeline": 0,
        "ytd_received": 0,
        "outstanding": 0,
    })


# ---------------------------------------------------------------------------
# Awaiting invoices
# ---------------------------------------------------------------------------

@router.get("/api/finance/awaiting-invoices")
async def get_awaiting_invoices(
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(check_permission("view_sage_invoices_payments")),
):
    """Get payments ready to be invoiced (Collecting stage, no invoice, unpaid)."""
    try:
        salesforce = client.salesforce
        collecting_stage = escape_soql_string(OpportunityStage.COLLECTING.value)

        query = f"""
        SELECT Id, npe01__Payment_Amount__c, npe01__Scheduled_Date__c, npe01__Paid__c,
               npe01__Opportunity__c, npe01__Opportunity__r.Name,
               npe01__Opportunity__r.Account.Name, npe01__Opportunity__r.CloseDate,
               npe01__Opportunity__r.Owner.Name, npe01__Opportunity__r.StageName,
               Invoice__c
        FROM npe01__OppPayment__c
        WHERE npe01__Opportunity__r.StageName = '{collecting_stage}'
        AND Invoice__c = null
        AND npe01__Paid__c = false
        ORDER BY npe01__Scheduled_Date__c ASC
        """

        result = await salesforce.query_all(query)

        payments = []
        for record in result.get("records", []):
            opp = record.get("npe01__Opportunity__r") or {}
            payments.append({
                "Id": record["Id"],
                "PaymentAmount": record.get("npe01__Payment_Amount__c", 0),
                "ScheduledDate": record.get("npe01__Scheduled_Date__c"),
                "OpportunityId": record.get("npe01__Opportunity__c"),
                "OpportunityName": opp.get("Name"),
                "AccountName": (opp.get("Account") or {}).get("Name"),
                "OwnerName": (opp.get("Owner") or {}).get("Name"),
                "CloseDate": opp.get("CloseDate"),
                "HasInvoice": record.get("Invoice__c") is not None,
                "IsPaid": record.get("npe01__Paid__c", False),
            })

        return {
            "success": True,
            "count": len(payments),
            "payments": payments,
            "summary": {
                "total_amount": sum(p["PaymentAmount"] for p in payments),
            },
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in get_awaiting_invoices")
        raise sf_http_error(e, "invoices")


# ---------------------------------------------------------------------------
# Create invoice
# ---------------------------------------------------------------------------

@router.post("/api/finance/create-invoice")
async def create_sage_invoice(
    request: CreateInvoiceRequest,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(check_permission("create_sage_invoices")),
):
    """Create invoice from a Salesforce payment record.

    NOTE: Uses demo invoice IDs. Full Sage Intacct integration is TODO.
    """
    validate_salesforce_id(request.payment_id, "payment_id")
    safe_id = escape_soql_string(request.payment_id)
    try:
        salesforce = client.salesforce

        # Get payment details
        payment_result = await salesforce.query(
            f"""SELECT Id, npe01__Payment_Amount__c, npe01__Scheduled_Date__c,
                       npe01__Opportunity__c, npe01__Opportunity__r.Name,
                       npe01__Opportunity__r.Account.Name
            FROM npe01__OppPayment__c
            WHERE Id = '{safe_id}'"""
        )
        if not payment_result.get("records"):
            raise HTTPException(status_code=404, detail="Payment not found")

        payment = payment_result["records"][0]
        opp_name = (payment.get("npe01__Opportunity__r") or {}).get("Name")
        opp_id = payment.get("npe01__Opportunity__c")
        amount = float(payment.get("npe01__Payment_Amount__c", 0))

        # TODO: Replace with actual Sage Intacct integration
        sage_invoice_id = f"DEMO-{request.payment_id[:8]}"

        # Create Invoice__c record in Salesforce
        sf_invoice_result = await salesforce.create_record(
            "Invoice__c",
            {
                "Opportunity__c": opp_id,
                "Sage_Invoice_ID__c": sage_invoice_id,
                "Invoice_Amount__c": amount,
                "Invoice_Date__c": datetime.now().strftime("%Y-%m-%d"),
                "Invoice_Status__c": "Posted",
                "Description__c": f"{opp_name} - Payment",
            },
        )
        sf_invoice_id = sf_invoice_result.get("id")

        # Link invoice to payment
        await salesforce.update_record(
            "npe01__OppPayment__c",
            request.payment_id,
            {"Invoice__c": sf_invoice_id},
        )

        return {
            "success": True,
            "message": "Invoice created for payment",
            "sage_invoice_id": sage_invoice_id,
            "salesforce_invoice_id": sf_invoice_id,
            "payment_id": request.payment_id,
            "opportunity_name": opp_name,
            "amount": amount,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in create_sage_invoice")
        raise sf_http_error(e, "invoice")


# ---------------------------------------------------------------------------
# Sync payments from Sage
# ---------------------------------------------------------------------------

def _sync_invoice_payments_from_sage_blocking():
    """Synchronous background job: syncs invoice payment status from Sage to Salesforce."""
    try:
        from mcp_client.services.sage_intacct_sync import SageIntacctService

        sage_config = {
            "company_id": os.getenv("SAGE_COMPANY_ID"),
            "user_id": os.getenv("SAGE_USER_ID"),
            "user_password": os.getenv("SAGE_USER_PASSWORD"),
            "sender_id": os.getenv("SAGE_SENDER_ID"),
            "sender_password": os.getenv("SAGE_SENDER_PASSWORD"),
        }

        if not all(sage_config.values()):
            logger.info("Sage not configured — skipping payment sync")
            return {"success": False, "error": "Sage not configured"}

        sage = SageIntacctService(sage_config)

        # This function needs a synchronous Salesforce client.
        # For now, return a stub — full sync requires the service account SF client.
        logger.info("Sage payment sync triggered (stub — requires sync SF client)")
        return {"success": True, "message": "Sync triggered"}

    except Exception as e:
        logger.error(f"Sync failed: {e}")
        return {"success": False, "error": str(e)}


@router.post("/api/finance/sync-payments")
async def manual_sync_payments(
    user=Depends(check_permission("trigger_data_sync")),
):
    """Manually trigger the Sage -> Salesforce payment sync."""
    result = await asyncio.get_event_loop().run_in_executor(
        None, _sync_invoice_payments_from_sage_blocking
    )
    return result


# ---------------------------------------------------------------------------
# Aspirational endpoints (not yet in simple_server.py — stub for future)
# ---------------------------------------------------------------------------

@router.get("/api/finance/active-collections")
async def get_active_collections(user=Depends(require_auth)):
    """Get active collection items. (Not yet implemented.)"""
    raise HTTPException(status_code=501, detail="Not implemented")


@router.get("/api/finance/unsent-invoices")
async def get_unsent_invoices(user=Depends(require_auth)):
    """Get invoices not yet sent. (Not yet implemented.)"""
    raise HTTPException(status_code=501, detail="Not implemented")


@router.post("/api/finance/send-invoice-email")
async def send_invoice_email(user=Depends(require_auth)):
    """Send invoice via email. (Not yet implemented.)"""
    raise HTTPException(status_code=501, detail="Not implemented")


@router.post("/api/finance/sync-invoice-status")
async def sync_invoice_status(user=Depends(require_auth)):
    """Sync invoice status from Sage. (Not yet implemented.)"""
    raise HTTPException(status_code=501, detail="Not implemented")
