"""Candidate funnel API — list + detail + promote endpoints.

See tasks/candidate-funnel-plan.md for the full design.

Endpoints:
  GET  /api/candidates/accounts                       — paginated list
  GET  /api/candidates/contacts                       — paginated list
  GET  /api/candidates/accounts/{id}/detail           — rich enrichment (name, top people, internal counterparts, suggestions)
  GET  /api/candidates/contacts/{id}/detail           — rich enrichment (name, internal counterparts, recent activity, public.contacts matches)
  POST /api/candidates/accounts/{id}/track            — mark in_registry (no public.* write yet)
  POST /api/candidates/accounts/{id}/promote-sf       — create SF Account
  POST /api/candidates/accounts/{id}/tag-existing     — link to existing SF Account
  POST /api/candidates/accounts/{id}/reject           — mark rejected
  POST /api/candidates/contacts/{id}/track            — mark in_registry
  POST /api/candidates/contacts/{id}/promote-sf       — create SF Contact
  POST /api/candidates/contacts/{id}/tag-existing     — link to existing SF Contact
  POST /api/candidates/contacts/{id}/reject           — mark rejected

Track-in-registry currently only flips status (public.* writeback is plan Step 4 —
needs factory-team coordination on provenance + dedup contract).
"""
from __future__ import annotations

import logging
import re
from typing import Any, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth import require_auth
from db import get_db
from dependencies import require_sf_mcp_client
from mcp_client import UnifiedMCPClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/candidates", tags=["candidates"])


# ─── Response models ──────────────────────────────────────────────────

class AccountCandidate(BaseModel):
    id: UUID
    primary_domain: str
    display_name: Optional[str]
    alt_domains: list[str]
    first_seen_at: str
    last_seen_at: str
    first_source: str
    signal_count: int
    unique_people: int
    public_company_id: Optional[int]
    sf_account_id: Optional[str]
    status: str
    reviewed_by: Optional[str]
    reviewed_at: Optional[str]
    notes: Optional[str]


class ContactCandidate(BaseModel):
    id: UUID
    email: str
    display_name: Optional[str]
    first_seen_at: str
    last_seen_at: str
    first_source: str
    signal_count: int
    account_candidate_id: Optional[UUID]
    account_candidate_domain: Optional[str]   # convenience join
    sf_account_id: Optional[str]
    sf_account_name: Optional[str]            # convenience join from account_email_domain
    sf_contact_id: Optional[str]
    public_contact_id: Optional[int]
    status: str
    title: Optional[str]
    linkedin_url: Optional[str]


class CandidateListResponse(BaseModel):
    items: list
    total: int
    limit: int
    offset: int


class PromoteSFAccountRequest(BaseModel):
    sf_account_name: str = Field(..., description="Name to use when creating the SF Account")
    sf_account_type: Optional[str] = Field(None, description="Account.Type (Corporate, Foundation, etc.)")


class PromoteSFContactRequest(BaseModel):
    first_name: str
    last_name: str
    sf_account_id: Optional[str] = Field(
        None,
        description="Override the candidate's sf_account_id. If not set, uses candidate.sf_account_id.",
    )
    title: Optional[str] = None


class TagExistingAccountRequest(BaseModel):
    sf_account_id: str = Field(..., description="Existing SF Account 18-char id")
    sf_account_name: Optional[str] = None


class TagExistingContactRequest(BaseModel):
    sf_contact_id: str
    sf_account_id: Optional[str] = None


class RejectRequest(BaseModel):
    notes: Optional[str] = None


# ─── Helpers ─────────────────────────────────────────────────────────

def _to_iso(v):
    return v.isoformat() if v else None


async def _row_to_account_candidate(r) -> dict:
    return {
        "id": r["id"],
        "primary_domain": r["primary_domain"],
        "display_name": r["display_name"],
        "alt_domains": list(r["alt_domains"] or []),
        "first_seen_at": _to_iso(r["first_seen_at"]),
        "last_seen_at": _to_iso(r["last_seen_at"]),
        "first_source": r["first_source"],
        "signal_count": r["signal_count"],
        "unique_people": r["unique_people"],
        "public_company_id": r["public_company_id"],
        "sf_account_id": r["sf_account_id"],
        "status": r["status"],
        "reviewed_by": r["reviewed_by"],
        "reviewed_at": _to_iso(r["reviewed_at"]),
        "notes": r["notes"],
    }


async def _row_to_contact_candidate(r) -> dict:
    return {
        "id": r["id"],
        "email": r["email"],
        "display_name": r["display_name"],
        "first_seen_at": _to_iso(r["first_seen_at"]),
        "last_seen_at": _to_iso(r["last_seen_at"]),
        "first_source": r["first_source"],
        "signal_count": r["signal_count"],
        "account_candidate_id": r["account_candidate_id"],
        "account_candidate_domain": r.get("account_candidate_domain"),
        "sf_account_id": r["sf_account_id"],
        "sf_account_name": r.get("sf_account_name"),
        "sf_contact_id": r["sf_contact_id"],
        "public_contact_id": r["public_contact_id"],
        "status": r["status"],
        "title": r["title"],
        "linkedin_url": r["linkedin_url"],
    }


# ─── List endpoints ──────────────────────────────────────────────────

@router.get("/accounts")
async def list_account_candidates(
    user=Depends(require_auth),
    db: asyncpg.Connection = Depends(get_db),
    status: Optional[str] = Query(None, description="Filter by status; comma-separated for multiple"),
    min_signal: int = Query(0, ge=0, description="Minimum signal_count"),
    has_sf_account: Optional[bool] = Query(None, description="True: only candidates already linked to an SF Account (quick-win promotions). False: only unlinked."),
    search: Optional[str] = Query(None, description="Substring match on primary_domain or display_name"),
    sort: str = Query("signal_count_desc", description="signal_count_desc | last_seen_desc | first_seen_asc"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict:
    where = []
    params: list[Any] = []

    if status:
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        params.append(statuses)
        where.append(f"status = ANY(${len(params)})")
    if min_signal > 0:
        params.append(min_signal)
        where.append(f"signal_count >= ${len(params)}")
    if has_sf_account is True:
        where.append("sf_account_id IS NOT NULL")
    elif has_sf_account is False:
        where.append("sf_account_id IS NULL")
    if search:
        params.append(f"%{search.lower()}%")
        where.append(f"(LOWER(primary_domain) LIKE ${len(params)} OR LOWER(COALESCE(display_name,'')) LIKE ${len(params)})")

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    order_by = {
        "signal_count_desc": "signal_count DESC, last_seen_at DESC",
        "last_seen_desc":    "last_seen_at DESC",
        "first_seen_asc":    "first_seen_at ASC",
    }.get(sort, "signal_count DESC, last_seen_at DESC")

    total = await db.fetchval(
        f"SELECT COUNT(*) FROM bedrock.account_candidate {where_sql}",
        *params,
    )

    params.extend([limit, offset])
    rows = await db.fetch(
        f"""
        SELECT id, primary_domain, display_name, alt_domains, first_seen_at, last_seen_at,
               first_source, signal_count, unique_people, public_company_id, sf_account_id,
               status, reviewed_by, reviewed_at, notes
        FROM bedrock.account_candidate
        {where_sql}
        ORDER BY {order_by}
        LIMIT ${len(params) - 1} OFFSET ${len(params)}
        """,
        *params,
    )
    items = [await _row_to_account_candidate(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/contacts")
async def list_contact_candidates(
    user=Depends(require_auth),
    db: asyncpg.Connection = Depends(get_db),
    status: Optional[str] = Query(None),
    min_signal: int = Query(0, ge=0),
    has_sf_account: Optional[bool] = Query(None),
    domain: Optional[str] = Query(None, description="Filter by account_candidate.primary_domain"),
    search: Optional[str] = Query(None, description="Substring on email or display_name"),
    sort: str = Query("signal_count_desc"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict:
    where = []
    params: list[Any] = []

    if status:
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        params.append(statuses)
        where.append(f"cc.status = ANY(${len(params)})")
    if min_signal > 0:
        params.append(min_signal)
        where.append(f"cc.signal_count >= ${len(params)}")
    if has_sf_account is True:
        where.append("cc.sf_account_id IS NOT NULL")
    elif has_sf_account is False:
        where.append("cc.sf_account_id IS NULL")
    if domain:
        params.append(domain.lower())
        where.append(f"LOWER(ac.primary_domain) = ${len(params)}")
    if search:
        params.append(f"%{search.lower()}%")
        where.append(f"(LOWER(cc.email) LIKE ${len(params)} OR LOWER(COALESCE(cc.display_name,'')) LIKE ${len(params)})")

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    order_by = {
        "signal_count_desc": "cc.signal_count DESC, cc.last_seen_at DESC",
        "last_seen_desc":    "cc.last_seen_at DESC",
        "first_seen_asc":    "cc.first_seen_at ASC",
    }.get(sort, "cc.signal_count DESC, cc.last_seen_at DESC")

    total = await db.fetchval(
        f"""
        SELECT COUNT(*) FROM bedrock.contact_candidate cc
        LEFT JOIN bedrock.account_candidate ac ON ac.id = cc.account_candidate_id
        {where_sql}
        """,
        *params,
    )

    params.extend([limit, offset])
    # account_email_domain has one row per domain; an SF Account with multiple
    # domains would Cartesian-multiply our rows on plain LEFT JOIN. Pick any
    # one name via LATERAL + LIMIT 1.
    rows = await db.fetch(
        f"""
        SELECT cc.id, cc.email, cc.display_name, cc.first_seen_at, cc.last_seen_at,
               cc.first_source, cc.signal_count, cc.account_candidate_id,
               ac.primary_domain AS account_candidate_domain,
               cc.sf_account_id, aed.sf_account_name AS sf_account_name,
               cc.sf_contact_id, cc.public_contact_id,
               cc.status, cc.title, cc.linkedin_url
        FROM bedrock.contact_candidate cc
        LEFT JOIN bedrock.account_candidate ac  ON ac.id = cc.account_candidate_id
        LEFT JOIN LATERAL (
            SELECT sf_account_name FROM bedrock.account_email_domain
            WHERE sf_account_id = cc.sf_account_id
            LIMIT 1
        ) aed ON true
        {where_sql}
        ORDER BY {order_by}
        LIMIT ${len(params) - 1} OFFSET ${len(params)}
        """,
        *params,
    )
    items = [await _row_to_contact_candidate(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


# ─── Account promotions ──────────────────────────────────────────────

@router.post("/accounts/{candidate_id}/track")
async def track_account_in_registry(
    candidate_id: UUID,
    user=Depends(require_auth),
    db: asyncpg.Connection = Depends(get_db),
):
    """Marks the candidate as tracked in the Pursuit registry without writing
    to public.companies yet. The actual public.companies INSERT is gated on
    plan Step 4 (factory team writeback contract). For now, the candidate
    just gets a status flip so the funnel UI can show progress."""
    n = await db.execute(
        """
        UPDATE bedrock.account_candidate
        SET status='in_registry', reviewed_by=$2, reviewed_at=now(), updated_at=now()
        WHERE id=$1 AND status NOT IN ('promoted','merged')
        """,
        candidate_id, user.get("email"),
    )
    if n.endswith(" 0"):
        raise HTTPException(404, "Candidate not found or already promoted/merged")
    return {"ok": True, "id": str(candidate_id), "status": "in_registry"}


@router.post("/accounts/{candidate_id}/promote-sf")
async def promote_account_to_sf(
    candidate_id: UUID,
    body: PromoteSFAccountRequest,
    user=Depends(require_auth),
    db: asyncpg.Connection = Depends(get_db),
    sf: UnifiedMCPClient = Depends(require_sf_mcp_client),
):
    cand = await db.fetchrow(
        "SELECT * FROM bedrock.account_candidate WHERE id=$1", candidate_id,
    )
    if not cand:
        raise HTTPException(404, "Candidate not found")
    if cand["sf_account_id"]:
        raise HTTPException(409, "Already promoted (sf_account_id is set)")

    # Create SF Account via MCP
    payload = {"Name": body.sf_account_name}
    if body.sf_account_type:
        payload["Type"] = body.sf_account_type
    try:
        created = await sf.create_record("Account", payload)
    except Exception as e:
        logger.exception("SF Account create failed for candidate %s", candidate_id)
        raise HTTPException(502, f"Salesforce Account creation failed: {e}")

    new_sf_id = created.get("id") if isinstance(created, dict) else created
    if not new_sf_id:
        raise HTTPException(502, "Salesforce did not return an Account Id")

    async with db.transaction():
        await db.execute(
            """
            UPDATE bedrock.account_candidate
            SET sf_account_id=$2, status='promoted',
                reviewed_by=$3, reviewed_at=now(), updated_at=now()
            WHERE id=$1
            """,
            candidate_id, new_sf_id, user.get("email"),
        )
        # Seed the domain → SF Account mapping so future activity resolves
        await db.execute(
            """
            INSERT INTO bedrock.account_email_domain (domain, sf_account_id, sf_account_name, source)
            VALUES ($1, $2, $3, 'manual')
            ON CONFLICT (domain) DO UPDATE SET
                sf_account_id = EXCLUDED.sf_account_id,
                sf_account_name = EXCLUDED.sf_account_name,
                source = 'manual'
            """,
            cand["primary_domain"], new_sf_id, body.sf_account_name,
        )
        # Propagate to dependent contact_candidates
        await db.execute(
            """
            UPDATE bedrock.contact_candidate
            SET sf_account_id = $2, updated_at=now()
            WHERE account_candidate_id = $1
              AND sf_account_id IS NULL
            """,
            candidate_id, new_sf_id,
        )

    return {"ok": True, "id": str(candidate_id), "sf_account_id": new_sf_id, "status": "promoted"}


@router.post("/accounts/{candidate_id}/tag-existing")
async def tag_account_to_existing_sf(
    candidate_id: UUID,
    body: TagExistingAccountRequest,
    user=Depends(require_auth),
    db: asyncpg.Connection = Depends(get_db),
):
    """Link a candidate to an existing SF Account. Writes the domain → sf_account_id
    mapping and propagates to dependent contact_candidates."""
    cand = await db.fetchrow(
        "SELECT primary_domain FROM bedrock.account_candidate WHERE id=$1",
        candidate_id,
    )
    if not cand:
        raise HTTPException(404, "Candidate not found")

    async with db.transaction():
        await db.execute(
            """
            UPDATE bedrock.account_candidate
            SET sf_account_id=$2, status='merged',
                reviewed_by=$3, reviewed_at=now(), updated_at=now()
            WHERE id=$1
            """,
            candidate_id, body.sf_account_id, user.get("email"),
        )
        await db.execute(
            """
            INSERT INTO bedrock.account_email_domain (domain, sf_account_id, sf_account_name, source)
            VALUES ($1, $2, $3, 'manual')
            ON CONFLICT (domain) DO UPDATE SET
                sf_account_id = EXCLUDED.sf_account_id,
                sf_account_name = COALESCE(EXCLUDED.sf_account_name, bedrock.account_email_domain.sf_account_name),
                source = 'manual'
            """,
            cand["primary_domain"], body.sf_account_id, body.sf_account_name,
        )
        await db.execute(
            """
            UPDATE bedrock.contact_candidate
            SET sf_account_id = $2, updated_at=now()
            WHERE account_candidate_id = $1
              AND sf_account_id IS NULL
            """,
            candidate_id, body.sf_account_id,
        )

    return {"ok": True, "id": str(candidate_id), "sf_account_id": body.sf_account_id, "status": "merged"}


@router.post("/accounts/{candidate_id}/reject")
async def reject_account_candidate(
    candidate_id: UUID,
    body: RejectRequest = Body(default_factory=RejectRequest),
    user=Depends(require_auth),
    db: asyncpg.Connection = Depends(get_db),
):
    n = await db.execute(
        """
        UPDATE bedrock.account_candidate
        SET status='rejected', notes=COALESCE($2, notes),
            reviewed_by=$3, reviewed_at=now(), updated_at=now()
        WHERE id=$1
        """,
        candidate_id, body.notes, user.get("email"),
    )
    if n.endswith(" 0"):
        raise HTTPException(404, "Candidate not found")
    return {"ok": True, "id": str(candidate_id), "status": "rejected"}


# ─── Contact promotions ──────────────────────────────────────────────

@router.post("/contacts/{candidate_id}/track")
async def track_contact_in_registry(
    candidate_id: UUID,
    user=Depends(require_auth),
    db: asyncpg.Connection = Depends(get_db),
):
    n = await db.execute(
        """
        UPDATE bedrock.contact_candidate
        SET status='in_registry', reviewed_by=$2, reviewed_at=now(), updated_at=now()
        WHERE id=$1 AND status NOT IN ('promoted','merged')
        """,
        candidate_id, user.get("email"),
    )
    if n.endswith(" 0"):
        raise HTTPException(404, "Candidate not found or already promoted/merged")
    return {"ok": True, "id": str(candidate_id), "status": "in_registry"}


@router.post("/contacts/{candidate_id}/promote-sf")
async def promote_contact_to_sf(
    candidate_id: UUID,
    body: PromoteSFContactRequest,
    user=Depends(require_auth),
    db: asyncpg.Connection = Depends(get_db),
    sf: UnifiedMCPClient = Depends(require_sf_mcp_client),
):
    cand = await db.fetchrow(
        "SELECT * FROM bedrock.contact_candidate WHERE id=$1", candidate_id,
    )
    if not cand:
        raise HTTPException(404, "Candidate not found")
    if cand["sf_contact_id"]:
        raise HTTPException(409, "Already promoted (sf_contact_id is set)")

    sf_account_id = body.sf_account_id or cand["sf_account_id"]
    if not sf_account_id:
        raise HTTPException(400, "No sf_account_id on candidate and none supplied — promote the account first or supply sf_account_id in request body")

    payload = {
        "FirstName": body.first_name,
        "LastName": body.last_name,
        "Email": cand["email"],
        "AccountId": sf_account_id,
    }
    if body.title:
        payload["Title"] = body.title

    try:
        created = await sf.create_record("Contact", payload)
    except Exception as e:
        logger.exception("SF Contact create failed for candidate %s", candidate_id)
        raise HTTPException(502, f"Salesforce Contact creation failed: {e}")

    new_sf_id = created.get("id") if isinstance(created, dict) else created
    if not new_sf_id:
        raise HTTPException(502, "Salesforce did not return a Contact Id")

    await db.execute(
        """
        UPDATE bedrock.contact_candidate
        SET sf_contact_id=$2, sf_account_id=$3, status='promoted',
            reviewed_by=$4, reviewed_at=now(), updated_at=now()
        WHERE id=$1
        """,
        candidate_id, new_sf_id, sf_account_id, user.get("email"),
    )
    return {"ok": True, "id": str(candidate_id), "sf_contact_id": new_sf_id, "status": "promoted"}


@router.post("/contacts/{candidate_id}/tag-existing")
async def tag_contact_to_existing_sf(
    candidate_id: UUID,
    body: TagExistingContactRequest,
    user=Depends(require_auth),
    db: asyncpg.Connection = Depends(get_db),
):
    n = await db.execute(
        """
        UPDATE bedrock.contact_candidate
        SET sf_contact_id=$2,
            sf_account_id=COALESCE($3, sf_account_id),
            status='merged',
            reviewed_by=$4, reviewed_at=now(), updated_at=now()
        WHERE id=$1
        """,
        candidate_id, body.sf_contact_id, body.sf_account_id, user.get("email"),
    )
    if n.endswith(" 0"):
        raise HTTPException(404, "Candidate not found")
    return {"ok": True, "id": str(candidate_id), "sf_contact_id": body.sf_contact_id, "status": "merged"}


@router.post("/contacts/{candidate_id}/reject")
async def reject_contact_candidate(
    candidate_id: UUID,
    body: RejectRequest = Body(default_factory=RejectRequest),
    user=Depends(require_auth),
    db: asyncpg.Connection = Depends(get_db),
):
    n = await db.execute(
        """
        UPDATE bedrock.contact_candidate
        SET status='rejected',
            reviewed_by=$2, reviewed_at=now(), updated_at=now()
        WHERE id=$1
        """,
        candidate_id, user.get("email"),
    )
    if n.endswith(" 0"):
        raise HTTPException(404, "Candidate not found")
    return {"ok": True, "id": str(candidate_id), "status": "rejected"}


# ─── Smart-suggestion detail endpoints ───────────────────────────────
#
# The list endpoints return enough to triage at a glance, but real promotion
# decisions need more: who at Pursuit corresponded with this person, what
# was the last subject, do we have a LinkedIn URL for them. The /detail
# endpoints do that lookup in one round-trip so the drawer UI doesn't
# need to fan out N requests.

_ANGLE_RE = re.compile(r"^\s*(.*?)\s*<([^>]+@[^>]+)>\s*$")


def _parse_name_from_header(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    m = _ANGLE_RE.match(raw)
    if not m:
        return None
    name = m.group(1).strip().strip('"').strip("'")
    return name or None


async def _internal_email_set(db: asyncpg.Connection) -> set[str]:
    rows = await db.fetch("SELECT email, aliases FROM bedrock.sync_staff WHERE enabled = true")
    s: set[str] = set()
    for r in rows:
        s.add(r["email"].lower())
        for a in (r["aliases"] or []):
            if a:
                s.add(a.lower())
    return s


def _serialize_pc(r) -> Optional[dict]:
    if not r:
        return None
    return {
        "contact_id": r["contact_id"],
        "full_name": r["full_name"],
        "first_name": r["first_name"],
        "last_name": r["last_name"],
        "email": r["email"],
        "linkedin_url": r["linkedin_url"],
        "current_title": r["current_title"],
        "current_company": r["current_company"],
        "sf_contact_id": r["sf_contact_id"],
        "sf_account_id": r["sf_account_id"],
    }


@router.get("/contacts/{candidate_id}/detail")
async def get_contact_candidate_detail(
    candidate_id: UUID,
    user=Depends(require_auth),
    db: asyncpg.Connection = Depends(get_db),
) -> dict:
    cand = await db.fetchrow(
        """
        SELECT cc.*, ac.primary_domain AS account_candidate_domain,
               ac.display_name AS account_candidate_display
        FROM bedrock.contact_candidate cc
        LEFT JOIN bedrock.account_candidate ac ON ac.id = cc.account_candidate_id
        WHERE cc.id = $1
        """,
        candidate_id,
    )
    if not cand:
        raise HTTPException(404, "Candidate not found")
    email = cand["email"]
    domain = email.split("@", 1)[1] if "@" in email else ""

    sf_acct_suggestion = await db.fetchrow(
        "SELECT sf_account_id, sf_account_name FROM bedrock.account_email_domain "
        "WHERE LOWER(domain) = LOWER($1) LIMIT 1",
        domain,
    )

    pc_exact = await db.fetchrow(
        """
        SELECT c.contact_id, c.full_name, c.first_name, c.last_name, c.email,
               c.linkedin_url, c.current_title, c.current_company,
               scl.sf_contact_id, scl.sf_account_id
        FROM public.contacts c
        LEFT JOIN bedrock.sf_contact_link scl ON scl.public_contact_id = c.contact_id
        WHERE LOWER(c.email) = LOWER($1)
        LIMIT 1
        """,
        email,
    )
    pc_same_domain = await db.fetch(
        """
        SELECT c.contact_id, c.full_name, c.first_name, c.last_name, c.email,
               c.linkedin_url, c.current_title, c.current_company,
               scl.sf_contact_id, scl.sf_account_id
        FROM public.contacts c
        LEFT JOIN bedrock.sf_contact_link scl ON scl.public_contact_id = c.contact_id
        WHERE LOWER(SPLIT_PART(c.email, '@', 2)) = LOWER($1)
          AND (c.email IS NULL OR LOWER(c.email) <> LOWER($2))
        ORDER BY (c.linkedin_url IS NOT NULL) DESC, c.full_name
        LIMIT 10
        """,
        domain, email,
    )

    activities = await db.fetch(
        """
        SELECT activity_date, source, subject, email_from, email_to, email_cc,
               email_snippet, type
        FROM bedrock.activity
        WHERE LOWER(COALESCE(email_from, '')) LIKE $1
           OR EXISTS (SELECT 1 FROM unnest(email_to) e WHERE LOWER(e) = $2)
           OR EXISTS (SELECT 1 FROM unnest(email_cc) e WHERE LOWER(e) = $2)
        ORDER BY activity_date DESC
        LIMIT 50
        """,
        f"%{email}%", email,
    )

    internal_set = await _internal_email_set(db)
    counterpart_counts: dict[str, int] = {}
    counterpart_names: dict[str, Optional[str]] = {}
    for a in activities:
        ef = a["email_from"] or ""
        ef_name = _parse_name_from_header(ef)
        m = _ANGLE_RE.match(ef)
        ef_email = (m.group(2).lower() if m else ef.strip().lower()) if ef else ""
        participants = []
        if ef_email and ef_email != email:
            participants.append((ef_email, ef_name))
        for et in (a["email_to"] or []):
            participants.append(((et or "").strip().lower(), None))
        for ec in (a["email_cc"] or []):
            participants.append(((ec or "").strip().lower(), None))
        for p_email, p_name in participants:
            if p_email and p_email in internal_set:
                counterpart_counts[p_email] = counterpart_counts.get(p_email, 0) + 1
                if p_name and p_email not in counterpart_names:
                    counterpart_names[p_email] = p_name

    staff_lookup = {
        r["email"].lower(): r["display_name"]
        for r in await db.fetch("SELECT email, display_name FROM bedrock.sync_staff")
    }
    internal_counterparts = [
        {
            "email": em,
            "display_name": staff_lookup.get(em) or counterpart_names.get(em) or em.split("@")[0],
            "interaction_count": cnt,
        }
        for em, cnt in sorted(counterpart_counts.items(), key=lambda kv: kv[1], reverse=True)[:5]
    ]

    recent = []
    for a in activities[:10]:
        recent.append({
            "activity_date": a["activity_date"].isoformat() if a["activity_date"] else None,
            "source": a["source"],
            "type": a["type"],
            "subject": a["subject"],
            "email_from": a["email_from"],
            "snippet": (a["email_snippet"] or "")[:280] if a["email_snippet"] else None,
        })

    display_name = cand["display_name"]
    if not display_name:
        for a in activities:
            n = _parse_name_from_header(a["email_from"])
            if n:
                display_name = n
                break

    return {
        "id": str(cand["id"]),
        "email": cand["email"],
        "display_name": display_name,
        "status": cand["status"],
        "signal_count": cand["signal_count"],
        "first_seen_at": cand["first_seen_at"].isoformat() if cand["first_seen_at"] else None,
        "last_seen_at": cand["last_seen_at"].isoformat() if cand["last_seen_at"] else None,
        "sf_account_id": cand["sf_account_id"],
        "sf_account_name": sf_acct_suggestion["sf_account_name"] if sf_acct_suggestion else None,
        "sf_contact_id": cand["sf_contact_id"],
        "account_candidate_id": str(cand["account_candidate_id"]) if cand["account_candidate_id"] else None,
        "account_candidate_domain": cand["account_candidate_domain"],
        "account_candidate_display": cand["account_candidate_display"],
        "internal_counterparts": internal_counterparts,
        "recent_activity": recent,
        "total_activity_count": len(activities),
        "public_contact_exact_match": _serialize_pc(pc_exact),
        "public_contacts_same_domain": [_serialize_pc(r) for r in pc_same_domain],
        "sf_account_suggestion": (
            {"sf_account_id": sf_acct_suggestion["sf_account_id"],
             "sf_account_name": sf_acct_suggestion["sf_account_name"]}
            if sf_acct_suggestion else None
        ),
    }


@router.get("/accounts/{candidate_id}/detail")
async def get_account_candidate_detail(
    candidate_id: UUID,
    user=Depends(require_auth),
    db: asyncpg.Connection = Depends(get_db),
) -> dict:
    cand = await db.fetchrow(
        "SELECT * FROM bedrock.account_candidate WHERE id = $1",
        candidate_id,
    )
    if not cand:
        raise HTTPException(404, "Candidate not found")
    domain = cand["primary_domain"]

    sf_acct = await db.fetchrow(
        "SELECT sf_account_id, sf_account_name FROM bedrock.account_email_domain "
        "WHERE LOWER(domain) = LOWER($1) LIMIT 1",
        domain,
    )
    pub_company = await db.fetchrow(
        "SELECT company_id, name, domain, logo_url, industry, size_bucket, hq_location "
        "FROM public.companies WHERE LOWER(domain) = LOWER($1) LIMIT 1",
        domain,
    )

    siblings = await db.fetch(
        """
        SELECT id, email, display_name, signal_count, last_seen_at, status,
               sf_contact_id, public_contact_id
        FROM bedrock.contact_candidate
        WHERE account_candidate_id = $1
        ORDER BY signal_count DESC, last_seen_at DESC
        LIMIT 10
        """,
        candidate_id,
    )

    internal_set = await _internal_email_set(db)
    activities = await db.fetch(
        """
        SELECT email_from, email_to, email_cc, activity_date
        FROM bedrock.activity
        WHERE LOWER(COALESCE(email_from, '')) LIKE $1
           OR EXISTS (SELECT 1 FROM unnest(email_to) e WHERE LOWER(SPLIT_PART(e, '@', 2)) = LOWER($2))
           OR EXISTS (SELECT 1 FROM unnest(email_cc) e WHERE LOWER(SPLIT_PART(e, '@', 2)) = LOWER($2))
        ORDER BY activity_date DESC
        LIMIT 200
        """,
        f"%@{domain}%", domain,
    )

    counterpart_counts: dict[str, int] = {}
    for a in activities:
        candidates_set = set()
        for slot in (a["email_to"] or []) + (a["email_cc"] or []):
            candidates_set.add((slot or "").strip().lower())
        ef = a["email_from"] or ""
        m = _ANGLE_RE.match(ef)
        candidates_set.add((m.group(2).lower() if m else ef.strip().lower()) if ef else "")
        for em in candidates_set:
            if em in internal_set:
                counterpart_counts[em] = counterpart_counts.get(em, 0) + 1

    staff_lookup = {
        r["email"].lower(): r["display_name"]
        for r in await db.fetch("SELECT email, display_name FROM bedrock.sync_staff")
    }
    internal_counterparts = [
        {
            "email": em,
            "display_name": staff_lookup.get(em) or em.split("@")[0],
            "interaction_count": cnt,
        }
        for em, cnt in sorted(counterpart_counts.items(), key=lambda kv: kv[1], reverse=True)[:5]
    ]

    return {
        "id": str(cand["id"]),
        "primary_domain": cand["primary_domain"],
        "display_name": cand["display_name"],
        "status": cand["status"],
        "signal_count": cand["signal_count"],
        "unique_people": cand["unique_people"],
        "first_seen_at": cand["first_seen_at"].isoformat() if cand["first_seen_at"] else None,
        "last_seen_at": cand["last_seen_at"].isoformat() if cand["last_seen_at"] else None,
        "sf_account_id": cand["sf_account_id"],
        "public_company_id": cand["public_company_id"],
        "sf_account_suggestion": (
            {"sf_account_id": sf_acct["sf_account_id"], "sf_account_name": sf_acct["sf_account_name"]}
            if sf_acct else None
        ),
        "public_company": (
            {
                "company_id": pub_company["company_id"],
                "name": pub_company["name"],
                "domain": pub_company["domain"],
                "logo_url": pub_company["logo_url"],
                "industry": pub_company["industry"],
                "size_bucket": pub_company["size_bucket"],
                "hq_location": pub_company["hq_location"],
            } if pub_company else None
        ),
        "top_people": [
            {
                "id": str(r["id"]),
                "email": r["email"],
                "display_name": r["display_name"],
                "signal_count": r["signal_count"],
                "last_seen_at": r["last_seen_at"].isoformat() if r["last_seen_at"] else None,
                "status": r["status"],
                "sf_contact_id": r["sf_contact_id"],
                "public_contact_id": r["public_contact_id"],
            }
            for r in siblings
        ],
        "internal_counterparts": internal_counterparts,
    }
