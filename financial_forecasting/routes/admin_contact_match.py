"""Admin endpoints for SF Contact → public.contacts matching.

  POST   /api/admin/sf-contact-match/scan       — run the batch matcher
  GET    /api/admin/sf-contact-match            — list all matches
  GET    /api/admin/sf-contact-match/unmatched  — SF Contacts with no match
  POST   /api/admin/sf-contact-match/manual     — create/override a match
  DELETE /api/admin/sf-contact-match/{id}       — remove a match

Mirrors routes/admin_company_match.py exactly.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from db import get_db
from dependencies import get_mcp_client
from routes.permissions import require_admin
from services.sf_contact_matcher import (
    delete_contact_match,
    get_unmatched_contacts,
    list_contact_matches,
    match_all_contacts,
    upsert_manual_contact_match,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/sf-contact-match", tags=["admin-sf-contact-match"])


class ManualContactMatchRequest(BaseModel):
    sf_contact_id: str
    public_contact_id: int
    notes: str | None = None


@router.post("/scan")
async def scan_contact_matches(
    dry_run: bool = Query(False, description="If true, no inserts are written"),
    limit: int = Query(2000, ge=1, le=20000),
    user=Depends(require_admin),
    conn=Depends(get_db),
    client=Depends(get_mcp_client),
):
    """Run the batch matcher across all SF Contacts.

    Returns:
        {"total": n, "matched": n, "unmatched": n, "errors": n,
         "by_confidence": {"email": n, "linkedin_url": n, "name_company": n}}
    """
    try:
        salesforce = client.salesforce
    except RuntimeError:
        raise HTTPException(503, "Salesforce not connected")

    summary = await match_all_contacts(salesforce, conn, limit=limit, dry_run=dry_run)
    return {"success": True, "data": summary}


@router.get("")
async def list_matches(
    limit: int = Query(2000, ge=1, le=20000),
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """List all SF Contact → public.contacts matches."""
    matches = await list_contact_matches(conn, limit=limit)
    return {"success": True, "data": matches}


@router.get("/unmatched")
async def list_unmatched(
    limit: int = Query(500, ge=1, le=5000),
    user=Depends(require_admin),
    conn=Depends(get_db),
    client=Depends(get_mcp_client),
):
    """SF Contacts with no match — the review queue."""
    try:
        salesforce = client.salesforce
    except RuntimeError:
        raise HTTPException(503, "Salesforce not connected")

    unmatched = await get_unmatched_contacts(salesforce, conn, limit=limit)
    return {"success": True, "data": unmatched}


@router.post("/manual")
async def create_manual_match(
    body: ManualContactMatchRequest,
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """Admin manually creates or overrides a match."""
    matched_by = user.get("email", "unknown")
    row = await upsert_manual_contact_match(
        body.sf_contact_id, body.public_contact_id, matched_by, body.notes, conn,
    )
    return {"success": True, "data": row}


@router.delete("/{sf_contact_id}")
async def delete_match(
    sf_contact_id: str,
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """Remove a match."""
    deleted = await delete_contact_match(sf_contact_id, conn)
    if not deleted:
        raise HTTPException(404, "No match found for that SF Contact ID")
    return {"success": True, "data": {"sf_contact_id": sf_contact_id, "deleted": True}}
