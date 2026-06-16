"""Admin endpoints for Gmail + Calendar interaction sync.

  POST   /api/admin/interaction-sync/run     — manual full sync trigger
  GET    /api/admin/interaction-sync/status  — last sync times + counts per staff
  GET    /api/admin/interaction-sync/staff   — list sync_staff roster
  POST   /api/admin/interaction-sync/staff   — add a staff member
  DELETE /api/admin/interaction-sync/staff/{email} — remove a staff member
"""

import asyncio
import logging
import os

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException
from pydantic import BaseModel

from db import get_db, get_pool
from routes.permissions import require_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/interaction-sync", tags=["admin-interaction-sync"])

_sync_lock = asyncio.Lock()
_sync_status: dict = {"running": False, "last_summary": None}


class StaffRequest(BaseModel):
    email: str
    display_name: str | None = None


async def _run_sync_background():
    async with _sync_lock:
        _sync_status["running"] = True
        try:
            from services.interaction_sync import run_interaction_sync
            pool = get_pool()
            async with pool.acquire() as conn:
                summary = await run_interaction_sync(conn)
            _sync_status["last_summary"] = summary
            logger.info("interaction sync complete: %s", summary)
        except Exception as e:
            logger.error("interaction sync failed: %s", e)
            _sync_status["last_summary"] = {"error": str(e)}
        finally:
            _sync_status["running"] = False


@router.post("/run")
async def trigger_sync(
    background_tasks: BackgroundTasks,
    user=Depends(require_admin),
):
    """Manually trigger a full interaction sync in the background."""
    if _sync_status["running"]:
        return {"success": False, "data": {"message": "Sync already running"}}
    background_tasks.add_task(_run_sync_background)
    return {"success": True, "data": {"message": "Sync started in background"}}


@router.get("/status")
async def get_sync_status(user=Depends(require_admin)):
    """Current sync state + last summary."""
    return {"success": True, "data": _sync_status}


@router.get("/staff")
async def list_staff(user=Depends(require_admin), conn=Depends(get_db)):
    """List all sync_staff members with their last watermark timestamps."""
    rows = await conn.fetch(
        """
        SELECT
            ss.email,
            ss.display_name,
            ss.enabled,
            ss.added_at,
            wg.last_synced_at  AS gmail_last_synced,
            wg.last_run_count  AS gmail_last_count,
            wc.last_synced_at  AS calendar_last_synced,
            wc.last_run_count  AS calendar_last_count
        FROM bedrock.sync_staff ss
        LEFT JOIN bedrock.sync_watermark wg
            ON wg.staff_email = ss.email AND wg.source = 'gmail'
        LEFT JOIN bedrock.sync_watermark wc
            ON wc.staff_email = ss.email AND wc.source = 'calendar'
        ORDER BY ss.email
        """
    )
    return {"success": True, "data": [dict(r) for r in rows]}


@router.post("/staff")
async def add_staff(
    body: StaffRequest,
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """Add (or re-enable) a staff member for interaction sync."""
    await conn.execute(
        """
        INSERT INTO bedrock.sync_staff (email, display_name, enabled)
        VALUES ($1, $2, true)
        ON CONFLICT (email) DO UPDATE SET enabled = true, display_name = COALESCE($2, bedrock.sync_staff.display_name)
        """,
        body.email,
        body.display_name,
    )
    return {"success": True, "data": {"email": body.email, "enabled": True}}


@router.post("/run-internal")
async def trigger_sync_internal(
    background_tasks: BackgroundTasks,
    x_sync_secret: str | None = Header(default=None, alias="X-Sync-Secret"),
):
    """Cloud Scheduler endpoint — authenticated via X-Sync-Secret header."""
    expected = os.environ.get("INTERNAL_SYNC_SECRET", "")
    if not expected or x_sync_secret != expected:
        raise HTTPException(401, "Invalid or missing X-Sync-Secret")
    if _sync_status["running"]:
        return {"success": False, "data": {"message": "Sync already running"}}
    background_tasks.add_task(_run_sync_background)
    return {"success": True, "data": {"message": "Nightly sync started"}}


@router.delete("/staff/{email:path}")
async def remove_staff(
    email: str,
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """Disable a staff member (soft delete — keeps watermark history)."""
    result = await conn.execute(
        "UPDATE bedrock.sync_staff SET enabled = false WHERE email = $1",
        email,
    )
    if result == "UPDATE 0":
        raise HTTPException(404, f"No staff found with email {email}")
    return {"success": True, "data": {"email": email, "enabled": False}}
