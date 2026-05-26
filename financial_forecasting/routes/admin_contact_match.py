"""Admin endpoints for SF Contact → public.contacts matching.

  POST   /api/admin/sf-contact-match/scan       — run the batch matcher
  GET    /api/admin/sf-contact-match            — list all matches
  GET    /api/admin/sf-contact-match/unmatched  — SF Contacts with no match
  POST   /api/admin/sf-contact-match/manual     — create/override a match
  DELETE /api/admin/sf-contact-match/{id}       — remove a match

Mirrors routes/admin_company_match.py exactly.
"""

import asyncio
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel

from db import get_db, get_pool
from dependencies import get_mcp_client
from routes.permissions import require_admin
from services.sf_contact_matcher import (
    delete_contact_match,
    get_unmatched_contacts,
    list_contact_matches,
    match_all_contacts,
    upsert_manual_contact_match,
)

_scan_lock = asyncio.Lock()
_scan_status: dict = {"running": False, "last_summary": None}

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/sf-contact-match", tags=["admin-sf-contact-match"])


class ManualContactMatchRequest(BaseModel):
    sf_contact_id: str
    public_contact_id: int
    notes: str | None = None


async def _run_scan_background(salesforce, limit: int, dry_run: bool):
    """Run the full scan in the background, releasing the HTTP request immediately."""
    async with _scan_lock:
        _scan_status["running"] = True
        try:
            pool = get_pool()
            async with pool.acquire() as conn:
                summary = await match_all_contacts(salesforce, conn, limit=limit, dry_run=dry_run)
            _scan_status["last_summary"] = summary
            logger.info("contact scan complete: %s", summary)
        except Exception as e:
            logger.error("contact scan failed: %s", e)
            _scan_status["last_summary"] = {"error": str(e)}
        finally:
            _scan_status["running"] = False


@router.post("/scan")
async def scan_contact_matches(
    background_tasks: BackgroundTasks,
    dry_run: bool = Query(False, description="If true, no inserts are written"),
    limit: int = Query(2000, ge=1, le=20000),
    background: bool = Query(False, description="If true, run async and return immediately"),
    user=Depends(require_admin),
    conn=Depends(get_db),
    client=Depends(get_mcp_client),
):
    """Run the batch matcher across all SF Contacts.

    Use background=true for large scans (>2000 contacts) — returns immediately
    and runs in the background. Poll GET /scan/status for progress.
    """
    try:
        salesforce = client.salesforce
    except RuntimeError:
        raise HTTPException(503, "Salesforce not connected")

    if background:
        if _scan_status["running"]:
            return {"success": False, "data": {"message": "Scan already running"}}
        background_tasks.add_task(_run_scan_background, salesforce, limit, dry_run)
        return {"success": True, "data": {"message": "Scan started in background", "limit": limit, "dry_run": dry_run}}

    summary = await match_all_contacts(salesforce, conn, limit=limit, dry_run=dry_run)
    return {"success": True, "data": summary}


@router.get("/scan/status")
async def scan_status(user=Depends(require_admin)):
    """Check if a background scan is running and see the last summary."""
    return {"success": True, "data": _scan_status}


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
