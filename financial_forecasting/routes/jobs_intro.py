"""Intro requests — ask a staff member for an intro to one of their connections.

Two sources feed a staff member's inbox:
  - bedrock.intro_request      — staff→staff asks created here (Damon/Avni flow)
  - public.intro_requests      — builder→staff asks created in Sputnik (surfaced
                                 read/respond-only so the old workflow isn't lost;
                                 that table is builder-owned, we never insert)

  GET    /api/jobs/contacts/{contact_id}/connectors  — staff connected to a contact
  GET    /api/jobs/intro-requests?box=inbox|sent      — my inbox / my sent asks
  POST   /api/jobs/intro-requests                     — create a staff→staff ask
  PATCH  /api/jobs/intro-requests/{id}                — respond (accept/decline/complete)

Modeled on the Sputnik intro_requests semantics (specific_ask, context, status
lifecycle, response notes) per its live usage.
"""

import logging
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import require_auth
from db import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/jobs", tags=["jobs"])

STAFF_STATUSES = {"pending", "accepted", "declined", "completed", "withdrawn"}
# public.intro_requests (Sputnik) vocabulary for the same actions
BUILDER_STATUS_MAP = {"accepted": "approved", "declined": "declined", "completed": "approved", "pending": "pending"}


def _email(user) -> str:
    return ((user.get("email") if isinstance(user, dict) else getattr(user, "email", None)) or "").lower()


async def _my_staff_id(conn, email: str) -> Optional[int]:
    return await conn.fetchval(
        "SELECT staff_user_id FROM bedrock.staff_user_id_map WHERE lower(email)=$1", email)


@router.get("/contacts/{contact_id}/connectors")
async def contact_connectors(
    contact_id: int,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Staff members connected to this contact (who could make an intro)."""
    rows = await conn.fetch(
        """
        SELECT m.staff_user_id, m.display_name, m.email, r.connected_date,
               EXISTS (
                 SELECT 1 FROM bedrock.intro_request ir
                 WHERE ir.contact_id = $1 AND ir.connector_staff_id = m.staff_user_id
                   AND ir.status = 'pending'
               ) AS has_pending_request
        FROM public.staff_contact_relationships r
        JOIN bedrock.staff_user_id_map m ON m.staff_user_id = r.staff_user_id
        WHERE r.contact_id = $1
        ORDER BY m.display_name
        """, contact_id)
    return {"success": True, "data": [dict(r) | {
        "connected_date": r["connected_date"].isoformat() if r["connected_date"] else None,
    } for r in rows]}


class IntroRequestCreate(BaseModel):
    contact_id: int
    connector_staff_id: int
    specific_ask: Optional[str] = None    # hiring_intro | industry_advice | free text
    context: Optional[str] = None


class IntroRequestRespond(BaseModel):
    status: str                            # accepted | declined | completed | withdrawn
    response_note: Optional[str] = None
    source: str = "staff"                  # staff (bedrock) | builder (Sputnik)


def _staff_row(r) -> dict:
    return {
        "id": str(r["id"]), "source": "staff",
        "contact_id": r["contact_id"], "contact_name": r["contact_name"],
        "contact_company": r["contact_company"], "contact_title": r["contact_title"],
        "connector_staff_id": r["connector_staff_id"], "connector_name": r["connector_name"],
        "connector_email": r["connector_email"],
        "requested_by": r["requested_by_email"],
        "specific_ask": r["specific_ask"], "context": r["context"],
        "status": r["status"], "response_note": r["response_note"],
        "responded_at": r["responded_at"].isoformat() if r["responded_at"] else None,
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
    }


_STAFF_SELECT = """
    SELECT ir.id, ir.contact_id, ir.connector_staff_id, ir.requested_by_email,
           ir.specific_ask, ir.context, ir.status, ir.response_note,
           ir.responded_at, ir.created_at,
           c.full_name AS contact_name, c.current_company AS contact_company,
           c.current_title AS contact_title,
           m.display_name AS connector_name, m.email AS connector_email
    FROM bedrock.intro_request ir
    LEFT JOIN public.contacts c ON c.contact_id = ir.contact_id
    LEFT JOIN bedrock.staff_user_id_map m ON m.staff_user_id = ir.connector_staff_id
"""


@router.get("/intro-requests")
async def list_intro_requests(
    box: str = Query("inbox", pattern="^(inbox|sent|all)$"),
    include_closed: bool = Query(False),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    email = _email(user)
    sid = await _my_staff_id(conn, email)
    open_staff = "" if include_closed else " AND ir.status IN ('pending','accepted')"
    out: list = []

    if box in ("inbox", "all") and sid is not None:
        rows = await conn.fetch(
            _STAFF_SELECT + f" WHERE ir.connector_staff_id = $1{open_staff} ORDER BY ir.created_at DESC", sid)
        out += [_staff_row(r) for r in rows]
        # Builder asks from Sputnik targeted at me (respond-only surface)
        open_builder = "" if include_closed else " AND ir.status = 'pending'"
        brows = await conn.fetch(
            f"""
            SELECT ir.intro_request_id, ir.contact_id, ir.contact_name, ir.contact_company,
                   ir.contact_title, ir.specific_ask, ir.request_context, ir.status,
                   ir.staff_response_notes, ir.responded_at, ir.created_at,
                   trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS builder_name,
                   u.email AS builder_email
            FROM public.intro_requests ir
            LEFT JOIN public.users u ON u.user_id = ir.builder_id
            WHERE ir.staff_user_id = $1{open_builder}
            ORDER BY ir.created_at DESC
            """, sid)
        out += [{
            "id": str(r["intro_request_id"]), "source": "builder",
            "contact_id": r["contact_id"], "contact_name": r["contact_name"],
            "contact_company": r["contact_company"], "contact_title": r["contact_title"],
            "connector_staff_id": sid, "connector_name": None, "connector_email": email,
            "requested_by": r["builder_email"] or r["builder_name"],
            "requested_by_name": r["builder_name"],
            "specific_ask": r["specific_ask"], "context": r["request_context"],
            "status": r["status"], "response_note": r["staff_response_notes"],
            "responded_at": r["responded_at"].isoformat() if r["responded_at"] else None,
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        } for r in brows]

    if box in ("sent", "all"):
        rows = await conn.fetch(
            _STAFF_SELECT + f" WHERE lower(ir.requested_by_email) = $1{open_staff} ORDER BY ir.created_at DESC", email)
        seen = {o["id"] for o in out}
        out += [_staff_row(r) for r in rows if str(r["id"]) not in seen]

    out.sort(key=lambda r: r["created_at"] or "", reverse=True)
    return {"success": True, "data": out}


@router.post("/intro-requests")
async def create_intro_request(
    body: IntroRequestCreate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    email = _email(user)
    ok = await conn.fetchval(
        "SELECT 1 FROM public.staff_contact_relationships WHERE staff_user_id=$1 AND contact_id=$2",
        body.connector_staff_id, body.contact_id)
    if not ok:
        raise HTTPException(400, "That staff member isn't connected to this contact")
    dup = await conn.fetchval(
        """SELECT 1 FROM bedrock.intro_request
           WHERE contact_id=$1 AND connector_staff_id=$2 AND lower(requested_by_email)=$3 AND status='pending'""",
        body.contact_id, body.connector_staff_id, email)
    if dup:
        raise HTTPException(409, "You already have a pending request for this contact via this staff member")
    r = await conn.fetchrow(
        """INSERT INTO bedrock.intro_request (contact_id, connector_staff_id, requested_by_email, specific_ask, context)
           VALUES ($1,$2,$3,$4,$5) RETURNING id""",
        body.contact_id, body.connector_staff_id, email, body.specific_ask, body.context)
    return {"success": True, "data": {"id": str(r["id"]), "status": "pending"}}


@router.patch("/intro-requests/{request_id}")
async def respond_intro_request(
    request_id: str,
    body: IntroRequestRespond,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    email = _email(user)
    if body.status not in STAFF_STATUSES or body.status == "pending":
        raise HTTPException(400, f"Invalid status: {body.status}")

    if body.source == "builder":
        # Respond to a Sputnik builder ask — status vocabulary differs slightly.
        try:
            rid = int(request_id)
        except ValueError:
            raise HTTPException(400, "Builder request ids are integers")
        sid = await _my_staff_id(conn, email)
        row = await conn.fetchrow("SELECT staff_user_id FROM public.intro_requests WHERE intro_request_id=$1", rid)
        if not row:
            raise HTTPException(404, "Request not found")
        if sid is None or row["staff_user_id"] != sid:
            raise HTTPException(403, "This request isn't addressed to you")
        mapped = BUILDER_STATUS_MAP.get(body.status)
        if not mapped:
            raise HTTPException(400, f"Can't set a builder request to {body.status}")
        await conn.execute(
            """UPDATE public.intro_requests
               SET status=$2, staff_response_notes=coalesce($3, staff_response_notes),
                   responded_at=coalesce(responded_at, now()),
                   completed_at=CASE WHEN $4 THEN now() ELSE completed_at END,
                   updated_at=now()
               WHERE intro_request_id=$1""",
            rid, mapped, body.response_note, body.status == "completed")
        return {"success": True, "data": {"id": request_id, "status": mapped, "source": "builder"}}

    try:
        rid_uuid = UUID(request_id)
    except ValueError:
        raise HTTPException(400, "Invalid request id")
    row = await conn.fetchrow(
        """SELECT ir.connector_staff_id, ir.requested_by_email, m.email AS connector_email
           FROM bedrock.intro_request ir
           LEFT JOIN bedrock.staff_user_id_map m ON m.staff_user_id = ir.connector_staff_id
           WHERE ir.id=$1""", rid_uuid)
    if not row:
        raise HTTPException(404, "Request not found")
    is_connector = (row["connector_email"] or "").lower() == email
    is_requester = (row["requested_by_email"] or "").lower() == email
    if body.status == "withdrawn":
        if not is_requester:
            raise HTTPException(403, "Only the requester can withdraw")
    elif not is_connector:
        raise HTTPException(403, "Only the connected staff member can respond")
    await conn.execute(
        """UPDATE bedrock.intro_request
           SET status=$2, response_note=coalesce($3, response_note),
               responded_at=CASE WHEN $2 IN ('accepted','declined') THEN coalesce(responded_at, now()) ELSE responded_at END,
               completed_at=CASE WHEN $2='completed' THEN now() ELSE completed_at END,
               updated_at=now()
           WHERE id=$1""",
        rid_uuid, body.status, body.response_note)
    return {"success": True, "data": {"id": request_id, "status": body.status, "source": "staff"}}
