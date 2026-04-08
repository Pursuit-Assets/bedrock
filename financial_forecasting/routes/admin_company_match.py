"""Admin endpoints for SF Account ↔ public.companies matching (Claim 4).

Operates the matcher service in services/sf_company_matcher.py:
  - POST   /api/admin/sf-company-match/scan       — run the batch matcher
  - GET    /api/admin/sf-company-match            — list all matches
  - GET    /api/admin/sf-company-match/unmatched  — list SF Accounts with no match
  - POST   /api/admin/sf-company-match/manual     — admin manually creates/overrides
  - DELETE /api/admin/sf-company-match/{id}       — remove a match

All endpoints require admin (`manage_users_roles` permission) via the
existing require_admin dependency. Mirrors routes/admin_sf_drift.py shape.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from db import get_db
from dependencies import get_mcp_client
from routes.permissions import require_admin
from services.sf_company_matcher import (
    delete_match,
    get_unmatched_accounts,
    list_matches,
    match_all_accounts,
    upsert_manual_match,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/sf-company-match", tags=["admin-sf-company-match"])


class ManualMatchRequest(BaseModel):
    sf_account_id: str
    public_company_id: int
    notes: str | None = None


@router.post("/scan")
async def scan_company_matches(
    dry_run: bool = Query(False, description="If true, no inserts are written"),
    limit: int = Query(1000, ge=1, le=10000),
    user=Depends(require_admin),
    conn=Depends(get_db),
    client=Depends(get_mcp_client),
):
    """Run the batch matcher across all SF Accounts.

    Returns a summary like:
        {"total": 499, "matched": 87, "unmatched": 412, "errors": 0,
         "by_confidence": {"exact_name": 64, "normalized_name": 18, "domain": 5}}
    """
    salesforce = getattr(client, "salesforce", None)
    if salesforce is None:
        raise HTTPException(503, "Salesforce client not available")

    summary = await match_all_accounts(salesforce, conn, limit=limit, dry_run=dry_run)
    return {"success": True, "data": summary}


@router.get("")
async def list_company_matches(
    limit: int = Query(1000, ge=1, le=10000),
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """List all SF Account → public.companies matches with the joined company name."""
    matches = await list_matches(conn, limit=limit)
    return {"success": True, "data": matches}


@router.get("/unmatched")
async def list_unmatched_accounts(
    limit: int = Query(500, ge=1, le=5000),
    user=Depends(require_admin),
    conn=Depends(get_db),
    client=Depends(get_mcp_client),
):
    """List SF Accounts that have no row in bedrock.sf_account_company_map.

    Used by the admin review queue. Each entry is a candidate for either
    manual mapping or "no platform equivalent exists" confirmation.
    """
    salesforce = getattr(client, "salesforce", None)
    if salesforce is None:
        raise HTTPException(503, "Salesforce client not available")

    unmatched = await get_unmatched_accounts(salesforce, conn, limit=limit)
    return {"success": True, "data": unmatched}


@router.post("/manual")
async def create_manual_match(
    body: ManualMatchRequest,
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """Admin manually creates or overrides a match.

    Forces confidence='manual'. Overwrites any existing auto-match for the
    same sf_account_id. The matched_by field is set to the admin's email
    so we can audit who confirmed which links.
    """
    matched_by = user.get("email", "unknown")
    row = await upsert_manual_match(
        body.sf_account_id, body.public_company_id, matched_by, body.notes, conn,
    )
    return {"success": True, "data": dict(row)}


@router.delete("/{sf_account_id}")
async def delete_company_match(
    sf_account_id: str,
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """Remove a match (e.g., it was wrong)."""
    deleted = await delete_match(sf_account_id, conn)
    if not deleted:
        raise HTTPException(404, "No match found for that SF Account ID")
    return {"success": True, "data": {"sf_account_id": sf_account_id, "deleted": True}}
