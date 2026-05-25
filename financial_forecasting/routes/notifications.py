"""Notifications API — read + mark-read for the in-app bell.

Endpoints (all scoped to the authenticated user):

    GET    /api/notifications                — list (default: 50 most recent)
    GET    /api/notifications/unread-count   — small payload for the bell badge
    POST   /api/notifications/{id}/read      — mark a single row read
    POST   /api/notifications/read-all       — mark every unread row read

Notifications are private to the recipient; the SELECT WHERE clause
keys on the authenticated user's email so a user can't read another
user's bell by guessing IDs.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import require_auth
from db import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/notifications", tags=["notifications"])


def _serialize(row) -> Dict[str, Any]:
    return {
        "id": str(row["id"]),
        "type": row["type"],
        "payload": row["payload"] if isinstance(row["payload"], dict) else {},
        "actor_email": row["actor_email"],
        "read_at": row["read_at"].isoformat() if row["read_at"] else None,
        "slack_status": row["slack_status"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


def _recipient_from_user(user) -> str:
    email = (user.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=401, detail="No email on session")
    return email


@router.get("")
async def list_notifications(
    unread_only: bool = Query(False),
    limit: int = Query(50, le=200),
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    """List the current user's notifications, newest first."""
    recipient = _recipient_from_user(user)
    if unread_only:
        rows = await conn.fetch(
            "SELECT id, type, payload, actor_email, read_at, slack_status, created_at "
            "FROM bedrock.notification "
            "WHERE recipient_email = $1 AND read_at IS NULL "
            "ORDER BY created_at DESC LIMIT $2",
            recipient, limit,
        )
    else:
        rows = await conn.fetch(
            "SELECT id, type, payload, actor_email, read_at, slack_status, created_at "
            "FROM bedrock.notification "
            "WHERE recipient_email = $1 "
            "ORDER BY created_at DESC LIMIT $2",
            recipient, limit,
        )
    return {"success": True, "data": [_serialize(r) for r in rows]}


@router.get("/unread-count")
async def unread_count(
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    """Lightweight badge counter for the bell. Returns ``{count: N}``."""
    recipient = _recipient_from_user(user)
    n = await conn.fetchval(
        "SELECT COUNT(*) FROM bedrock.notification "
        "WHERE recipient_email = $1 AND read_at IS NULL",
        recipient,
    )
    return {"success": True, "data": {"count": int(n or 0)}}


@router.post("/{notification_id}/read")
async def mark_read(
    notification_id: str,
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    """Mark one notification as read. Idempotent — re-marking a read row
    no-ops."""
    recipient = _recipient_from_user(user)
    try:
        nid = uuid.UUID(notification_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid notification id")
    result = await conn.execute(
        "UPDATE bedrock.notification SET read_at = COALESCE(read_at, now()) "
        "WHERE id = $1 AND recipient_email = $2",
        nid, recipient,
    )
    if result.endswith("0"):
        # Either the row doesn't exist or belongs to someone else — same
        # 404 either way (no info leak).
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"success": True}


@router.post("/read-all")
async def mark_all_read(
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Any]:
    """Mark every unread notification for the current user as read."""
    recipient = _recipient_from_user(user)
    result = await conn.execute(
        "UPDATE bedrock.notification SET read_at = now() "
        "WHERE recipient_email = $1 AND read_at IS NULL",
        recipient,
    )
    # asyncpg returns "UPDATE N" — extract N best-effort for the response.
    try:
        n = int(result.rsplit(" ", 1)[-1])
    except Exception:
        n = 0
    return {"success": True, "data": {"marked": n}}
