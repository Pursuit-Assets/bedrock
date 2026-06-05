"""Jobs pipeline API.

  GET    /api/jobs/opportunities              — list (filterable by stage, owner, account)
  POST   /api/jobs/opportunities              — create
  GET    /api/jobs/opportunities/:id          — get one with stage history + activity
  PATCH  /api/jobs/opportunities/:id          — update (stage change auto-logs history)
  DELETE /api/jobs/opportunities/:id          — soft delete
  GET    /api/jobs/opportunities/pipeline     — grouped stage counts for pipeline view
"""

import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import require_auth
from db import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/jobs", tags=["jobs"])

VALID_STAGES = {
    "lead_submitted", "initial_outreach",
    "active_in_discussions", "active_opportunity_confirmed", "active_builder_interview",
    "closed_won", "closed_lost",
    "on_hold_not_selected", "on_hold_not_interested", "on_hold_not_responsive",
}

VALID_DEAL_TYPES = {"ft", "pt_contract", "capstone", "volunteer", "workshop", "pilot"}

STAGE_LABELS = {
    "lead_submitted":               "Lead Submitted",
    "initial_outreach":             "Initial Outreach",
    "active_in_discussions":        "In Discussions",
    "active_opportunity_confirmed": "Opportunity Confirmed",
    "active_builder_interview":     "Builder Interview",
    "closed_won":                   "Closed — Won",
    "closed_lost":                  "Closed — Lost",
    "on_hold_not_selected":         "On Hold: Not Selected",
    "on_hold_not_interested":       "On Hold: Not Interested",
    "on_hold_not_responsive":       "On Hold: Not Responsive",
}


class OpportunityCreate(BaseModel):
    account_id: str
    account_name: Optional[str] = None
    stage: str = "lead_submitted"
    deal_type: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    salary_expected: Optional[int] = None
    source: Optional[str] = None
    owner_email: Optional[str] = None
    sf_contact_ids: list[str] = []
    builder_ids: list[str] = []
    follow_up_date: Optional[datetime] = None
    note: Optional[str] = None  # note for initial stage history entry


class OpportunityUpdate(BaseModel):
    stage: Optional[str] = None
    deal_type: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    salary_expected: Optional[int] = None
    source: Optional[str] = None
    owner_email: Optional[str] = None
    sf_contact_ids: Optional[list[str]] = None
    builder_ids: Optional[list[str]] = None
    follow_up_date: Optional[datetime] = None
    touch_count: Optional[int] = None
    sf_opportunity_id: Optional[str] = None
    note: Optional[str] = None  # optional note when changing stage


@router.get("/contacts/summary")
async def get_contacts_summary(user=Depends(require_auth), conn=Depends(get_db)):
    """Contacts & outreach metrics for the leadership dashboard."""
    stages = await conn.fetch("""
        SELECT contact_stage, count(*) AS count
        FROM public.contacts WHERE airtable_id IS NOT NULL
        GROUP BY contact_stage ORDER BY count DESC
    """)
    total   = sum(r["count"] for r in stages)
    engaged = sum(r["count"] for r in stages if r["contact_stage"] in ("initial_outreach", "active", "on_hold"))

    activity = await conn.fetchrow("""
        SELECT
            count(*) FILTER (WHERE a.activity_date >= now() - interval '7 days') AS outreach_this_week,
            count(*) FILTER (WHERE a.type='call' AND a.activity_date >= now() - interval '7 days') AS calls_this_week,
            count(*) FILTER (WHERE a.activity_date >= now() - interval '30 days') AS outreach_this_month,
            count(*) AS total_engagements,
            count(*) FILTER (WHERE a.type='call') AS total_calls,
            count(DISTINCT a.logged_by) AS active_owners
        FROM bedrock.activity a
        WHERE a.jobs_opportunity_id IS NOT NULL
          AND a.deleted_at IS NULL
    """)

    active_companies = await conn.fetchval("""
        SELECT count(*) FROM bedrock.jobs_opportunity
        WHERE deleted_at IS NULL AND stage LIKE 'active_%'
    """)

    return {
        "success": True,
        "data": {
            "contacts": {
                "total":    total,
                "engaged":  engaged,
                "by_stage": [{"stage": r["contact_stage"] or "none", "count": r["count"]} for r in stages],
            },
            "activity": dict(activity),
            "active_companies": active_companies,
        },
    }


class ContactCreate(BaseModel):
    full_name:       str
    email:           Optional[str] = None
    current_title:   Optional[str] = None
    current_company: Optional[str] = None
    contact_stage:   str = "lead"
    linkedin_url:    Optional[str] = None
    notes:           Optional[str] = None


@router.post("/contacts")
async def create_contact(
    body: ContactCreate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    import uuid as _uuid
    at_id = f"manual-{_uuid.uuid4().hex[:8]}"
    parts = body.full_name.split(" ", 1)
    first = parts[0]
    last  = parts[1] if len(parts) > 1 else ""
    cid = await conn.fetchval("""
        INSERT INTO public.contacts
            (first_name, last_name, full_name, email, current_title,
             current_company, linkedin_url, notes, source, airtable_id, contact_stage)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9,$10)
        RETURNING contact_id
    """, first, last, body.full_name, body.email, body.current_title,
        body.current_company, body.linkedin_url, body.notes, at_id, body.contact_stage)
    row = await conn.fetchrow("SELECT * FROM public.contacts WHERE contact_id=$1", cid)
    return {"success": True, "data": dict(row)}


@router.get("/contacts")
async def list_contacts(
    stage: Optional[str] = Query(None),
    company: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    limit: int = Query(200, le=500),
    offset: int = Query(0),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """All employer contacts from Airtable, with their linked deal where findable."""
    filters = ["c.airtable_id IS NOT NULL"]
    params: list = []
    i = 1

    if stage:
        filters.append(f"c.contact_stage = ${i}"); params.append(stage); i += 1
    if company:
        filters.append(f"(lower(c.current_company) LIKE lower(${i}) OR lower(c.full_name) LIKE lower(${i}))")
        params.append(f"%{company}%"); i += 1
    if search:
        filters.append(f"(lower(c.full_name) LIKE lower(${i}) OR lower(c.email) LIKE lower(${i}) OR lower(c.current_company) LIKE lower(${i}) OR lower(c.current_title) LIKE lower(${i}))")
        params.append(f"%{search}%"); i += 1

    where = " AND ".join(filters)
    rows = await conn.fetch(
        f"""
        SELECT
            c.contact_id,
            c.full_name,
            c.first_name,
            c.last_name,
            c.email,
            c.current_title,
            c.current_company,
            c.contact_stage,
            c.linkedin_url,
            c.notes,
            c.airtable_id,
            -- linked deal via sf_contact_ids
            jo.id           AS deal_id,
            jo.account_name AS deal_account,
            jo.stage        AS deal_stage,
            -- OR via company name match (fallback)
            jo2.id           AS deal_id_by_company,
            jo2.account_name AS deal_account_by_company,
            jo2.stage        AS deal_stage_by_company
        FROM public.contacts c
        -- direct link via sf_contact_ids airtable: ref
        LEFT JOIN bedrock.jobs_opportunity jo
            ON jo.deleted_at IS NULL
            AND ('airtable:' || c.airtable_id) = ANY(jo.sf_contact_ids)
        -- company name fuzzy match fallback
        LEFT JOIN bedrock.jobs_opportunity jo2
            ON jo2.deleted_at IS NULL
            AND jo.id IS NULL  -- only use fallback when no direct link
            AND (
                lower(jo2.account_name) = lower(c.current_company)
                OR lower(jo2.account_name) LIKE '%' || lower(split_part(c.current_company, '.', 1)) || '%'
                OR lower(c.current_company) LIKE '%' || lower(jo2.account_name) || '%'
            )
        WHERE {where}
        ORDER BY c.contact_stage NULLS LAST, c.full_name
        LIMIT ${i} OFFSET ${i+1}
        """,
        *params, limit, offset,
    )
    total = await conn.fetchval(
        f"SELECT count(*) FROM public.contacts c WHERE {where}", *params
    )
    return {
        "success": True,
        "total": total,
        "data": [
            {
                **{k: v for k, v in dict(r).items() if not k.startswith("deal_")},
                "deal": (
                    {"id": str(r["deal_id"]), "account_name": r["deal_account"], "stage": r["deal_stage"]}
                    if r["deal_id"] else
                    {"id": str(r["deal_id_by_company"]), "account_name": r["deal_account_by_company"], "stage": r["deal_stage_by_company"]}
                    if r["deal_id_by_company"] else None
                ),
            }
            for r in rows
        ],
    }


@router.get("/contacts/{contact_id}")
async def get_contact(
    contact_id: int,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Full contact detail — info, linked deal, and all engagement activity."""
    row = await conn.fetchrow(
        """
        SELECT c.*,
            jo.id           AS deal_id,
            jo.account_name AS deal_account,
            jo.stage        AS deal_stage,
            jo.owner_email  AS deal_owner,
            jo2.id           AS deal_id2,
            jo2.account_name AS deal_account2,
            jo2.stage        AS deal_stage2
        FROM public.contacts c
        LEFT JOIN bedrock.jobs_opportunity jo
            ON jo.deleted_at IS NULL
            AND ('airtable:' || c.airtable_id) = ANY(jo.sf_contact_ids)
        LEFT JOIN bedrock.jobs_opportunity jo2
            ON jo2.deleted_at IS NULL AND jo.id IS NULL
            AND (
                lower(jo2.account_name) = lower(c.current_company)
                OR lower(jo2.account_name) LIKE '%' || lower(split_part(c.current_company, '.', 1)) || '%'
                OR lower(c.current_company) LIKE '%' || lower(jo2.account_name) || '%'
            )
        WHERE c.contact_id = $1
        """,
        contact_id,
    )
    if not row:
        raise HTTPException(404, "Contact not found")

    deal_id    = row["deal_id"] or row["deal_id2"]
    deal_id2   = row["deal_id2"]
    contact_email = row["email"]
    contact_name  = row["full_name"] or ""
    first_name    = contact_name.split()[0] if contact_name else ""

    # Pull ALL activity for this contact:
    # 1. Jobs-tagged activity on their linked deal
    # 2. Gmail/Calendar/SF activity where email matches
    # 3. Activity where their name appears in description
    seen_ids: set = set()
    all_activity: list = []

    if deal_id:
        rows_deal = await conn.fetch(
            """
            SELECT a.id, a.type, a.subject, a.description, a.activity_date,
                   a.logged_by, a.source, a.email_from, a.email_snippet,
                   a.meeting_duration_minutes, a.deleted_at,
                   true AS is_jobs
            FROM bedrock.activity a
            WHERE a.deleted_at IS NULL AND a.jobs_opportunity_id = $1
            ORDER BY a.activity_date DESC NULLS LAST LIMIT 100
            """,
            deal_id,
        )
        for r in rows_deal:
            seen_ids.add(r["id"])
            all_activity.append(dict(r))

    if contact_email:
        rows_email = await conn.fetch(
            """
            SELECT a.id, a.type, a.subject, a.description, a.activity_date,
                   a.logged_by, a.source, a.email_from, a.email_snippet,
                   a.meeting_duration_minutes, a.deleted_at,
                   (a.jobs_opportunity_id IS NOT NULL) AS is_jobs
            FROM bedrock.activity a
            WHERE a.deleted_at IS NULL
              AND a.id != ALL($2::uuid[])
              AND (
                lower(a.email_from) LIKE lower($1)
                OR lower(a.email_from) LIKE '%<' || lower($1) || '>%'
              )
            ORDER BY a.activity_date DESC NULLS LAST LIMIT 100
            """,
            f"%{contact_email}%",
            list(seen_ids) or [__import__("uuid").uuid4()],
        )
        for r in rows_email:
            seen_ids.add(r["id"])
            all_activity.append(dict(r))

    if first_name and len(first_name) > 3:
        rows_name = await conn.fetch(
            """
            SELECT a.id, a.type, a.subject, a.description, a.activity_date,
                   a.logged_by, a.source, a.email_from, a.email_snippet,
                   a.meeting_duration_minutes, a.deleted_at,
                   (a.jobs_opportunity_id IS NOT NULL) AS is_jobs
            FROM bedrock.activity a
            WHERE a.deleted_at IS NULL
              AND a.id != ALL($2::uuid[])
              AND jobs_opportunity_id IS NOT NULL
              AND (lower(description) LIKE lower($1) OR lower(subject) LIKE lower($1))
            ORDER BY a.activity_date DESC NULLS LAST LIMIT 30
            """,
            f"%{first_name}%",
            list(seen_ids) or [__import__("uuid").uuid4()],
        )
        for r in rows_name:
            if r["id"] not in seen_ids:
                seen_ids.add(r["id"])
                all_activity.append(dict(r))

    all_activity.sort(key=lambda x: x.get("activity_date") or "", reverse=True)
    activity = all_activity[:150]

    deal = None
    if row["deal_id"]:
        deal = {"id": str(row["deal_id"]), "account_name": row["deal_account"], "stage": row["deal_stage"], "owner_email": row["deal_owner"]}
    elif row["deal_id2"]:
        deal = {"id": str(row["deal_id2"]), "account_name": row["deal_account2"], "stage": row["deal_stage2"], "owner_email": None}

    return {
        "success": True,
        "data": {
            "contact_id":      row["contact_id"],
            "full_name":       row["full_name"],
            "first_name":      row["first_name"],
            "last_name":       row["last_name"],
            "email":           row["email"],
            "current_title":   row["current_title"],
            "current_company": row["current_company"],
            "contact_stage":   row["contact_stage"],
            "linkedin_url":    row["linkedin_url"],
            "notes":           row["notes"],
            "airtable_id":     row["airtable_id"],
            "deal":            deal,
            "activity":        [dict(a) for a in activity],
        },
    }


async def _resolve_contacts(conn, sf_contact_ids: list[str]) -> list[dict]:
    """Resolve airtable:recXXX refs and SF IDs to contact records."""
    if not sf_contact_ids:
        return []
    airtable_ids = [cid.replace("airtable:", "") for cid in sf_contact_ids if cid.startswith("airtable:")]
    sf_ids       = [cid for cid in sf_contact_ids if not cid.startswith("airtable:")]
    contacts = []
    if airtable_ids:
        rows = await conn.fetch(
            "SELECT contact_id, first_name, last_name, full_name, email, current_title, current_company, contact_stage, linkedin_url, notes FROM public.contacts WHERE airtable_id = ANY($1::text[])",
            airtable_ids,
        )
        contacts.extend([dict(r) for r in rows])
    if sf_ids:
        rows = await conn.fetch(
            """SELECT c.contact_id, c.first_name, c.last_name, c.full_name, c.email, c.current_title, c.current_company, c.contact_stage, c.linkedin_url, c.notes
               FROM public.contacts c
               JOIN bedrock.sf_contact_link scl ON scl.public_contact_id = c.contact_id
               WHERE scl.sf_contact_id = ANY($1::text[])""",
            sf_ids,
        )
        contacts.extend([dict(r) for r in rows])
    return contacts


@router.get("/opportunities/pipeline")
async def get_pipeline_summary(user=Depends(require_auth), conn=Depends(get_db)):
    """Stage counts + deal-type breakdown for the pipeline dashboard."""
    rows = await conn.fetch(
        """
        SELECT
            stage,
            deal_type,
            count(*) AS count,
            avg(salary_expected) FILTER (WHERE salary_expected IS NOT NULL) AS avg_salary
        FROM bedrock.jobs_opportunity
        WHERE deleted_at IS NULL
        GROUP BY stage, deal_type
        ORDER BY stage, deal_type
        """
    )
    # Group into stage buckets
    pipeline = {}
    for r in rows:
        s = r["stage"]
        if s not in pipeline:
            pipeline[s] = {
                "stage": s,
                "label": STAGE_LABELS.get(s, s),
                "group": s.split("_")[0],
                "total": 0,
                "by_type": {},
                "avg_salary": None,
            }
        pipeline[s]["total"] += r["count"]
        if r["deal_type"]:
            pipeline[s]["by_type"][r["deal_type"]] = r["count"]
        if r["avg_salary"]:
            pipeline[s]["avg_salary"] = round(float(r["avg_salary"]))

    return {"success": True, "data": list(pipeline.values())}


@router.get("/opportunities")
async def list_opportunities(
    stage: Optional[str] = Query(None),
    stage_group: Optional[str] = Query(None, description="active | on_hold | closed"),
    owner_email: Optional[str] = Query(None),
    account_id: Optional[str] = Query(None),
    deal_type: Optional[str] = Query(None),
    limit: int = Query(200, le=500),
    offset: int = Query(0),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    filters = ["o.deleted_at IS NULL"]
    params: list = []
    i = 1

    if stage:
        filters.append(f"o.stage = ${i}"); params.append(stage); i += 1
    elif stage_group:
        filters.append(f"o.stage LIKE ${i}"); params.append(f"{stage_group}%"); i += 1

    if owner_email:
        filters.append(f"o.owner_email = ${i}"); params.append(owner_email); i += 1
    if account_id:
        filters.append(f"o.account_id = ${i}"); params.append(account_id); i += 1
    if deal_type:
        filters.append(f"o.deal_type = ${i}"); params.append(deal_type); i += 1

    where = " AND ".join(filters)
    rows = await conn.fetch(
        f"""
        SELECT
            o.*,
            (
                SELECT count(*) FROM bedrock.activity a
                WHERE a.jobs_opportunity_id = o.id
            ) AS activity_count
        FROM bedrock.jobs_opportunity o
        WHERE {where}
        ORDER BY o.updated_at DESC
        LIMIT ${i} OFFSET ${i+1}
        """,
        *params, limit, offset,
    )
    total = await conn.fetchval(
        f"SELECT count(*) FROM bedrock.jobs_opportunity o WHERE {where}", *params
    )
    return {"success": True, "data": [dict(r) for r in rows], "total": total}


@router.post("/opportunities")
async def create_opportunity(
    body: OpportunityCreate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    if body.stage not in VALID_STAGES:
        raise HTTPException(400, f"Invalid stage: {body.stage}")
    if body.deal_type and body.deal_type not in VALID_DEAL_TYPES:
        raise HTTPException(400, f"Invalid deal_type: {body.deal_type}")

    user_email = user.get("email") if isinstance(user, dict) else getattr(user, "email", None)

    async with conn.transaction():
        row_id = await conn.fetchval(
            """
            INSERT INTO bedrock.jobs_opportunity (
                account_id, account_name, stage, deal_type,
                title, description, salary_expected,
                source, owner_email, sf_contact_ids, builder_ids, follow_up_date
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            RETURNING id
            """,
            body.account_id, body.account_name, body.stage, body.deal_type,
            body.title, body.description, body.salary_expected,
            body.source, body.owner_email,
            body.sf_contact_ids, body.builder_ids, body.follow_up_date,
        )
        await conn.execute(
            """
            INSERT INTO bedrock.jobs_stage_history
                (opportunity_id, from_stage, to_stage, changed_by, note)
            VALUES ($1, NULL, $2, $3, $4)
            """,
            row_id, body.stage, user_email, body.note,
        )

    row = await conn.fetchrow(
        "SELECT * FROM bedrock.jobs_opportunity WHERE id=$1", row_id
    )
    return {"success": True, "data": dict(row)}


@router.get("/opportunities/{opp_id}")
async def get_opportunity(
    opp_id: UUID,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    row = await conn.fetchrow(
        "SELECT * FROM bedrock.jobs_opportunity WHERE id=$1 AND deleted_at IS NULL",
        opp_id,
    )
    if not row:
        raise HTTPException(404, "Opportunity not found")

    history = await conn.fetch(
        """
        SELECT * FROM bedrock.jobs_stage_history
        WHERE opportunity_id=$1 ORDER BY changed_at DESC
        """,
        opp_id,
    )
    contacts = await _resolve_contacts(conn, list(row["sf_contact_ids"] or []))

    account_id = row["account_id"]

    # All activity for this account (Gmail, Calendar, SF, manual) + jobs-tagged
    activity = await conn.fetch(
        """
        SELECT
            a.id, a.type, a.subject, a.description, a.activity_date,
            a.source, a.logged_by, a.synced_at, a.email_from, a.email_snippet,
            a.meeting_duration_minutes, a.meeting_attendees, a.deleted_at,
            (a.jobs_opportunity_id = $1) AS is_jobs
        FROM bedrock.activity a
        WHERE a.deleted_at IS NULL
          AND (
            a.jobs_opportunity_id = $1
            OR (a.account_id = $2 AND $2 != 'UNKNOWN')
          )
        ORDER BY a.activity_date DESC NULLS LAST
        LIMIT 250
        """,
        opp_id,
        account_id,
    )
    return {
        "success": True,
        "data": {
            **dict(row),
            "stage_history": [dict(h) for h in history],
            "activity":      [dict(a) for a in activity],
            "contacts":      contacts,
        },
    }


@router.patch("/opportunities/{opp_id}")
async def update_opportunity(
    opp_id: UUID,
    body: OpportunityUpdate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    existing = await conn.fetchrow(
        "SELECT * FROM bedrock.jobs_opportunity WHERE id=$1 AND deleted_at IS NULL", opp_id
    )
    if not existing:
        raise HTTPException(404, "Opportunity not found")

    if body.stage and body.stage not in VALID_STAGES:
        raise HTTPException(400, f"Invalid stage: {body.stage}")
    if body.deal_type and body.deal_type not in VALID_DEAL_TYPES:
        raise HTTPException(400, f"Invalid deal_type: {body.deal_type}")

    user_email = user.get("email") if isinstance(user, dict) else getattr(user, "email", None)
    stage_changed = body.stage and body.stage != existing["stage"]

    sets = []
    params: list = []
    i = 1

    for field in ("stage", "deal_type", "title", "description", "salary_expected",
                  "source", "owner_email", "sf_contact_ids", "builder_ids",
                  "follow_up_date", "touch_count", "sf_opportunity_id"):
        val = getattr(body, field, None)
        if val is not None:
            sets.append(f"{field} = ${i}"); params.append(val); i += 1

    # Auto-set closed_at
    if body.stage in ("closed_won", "closed_lost") and not existing["closed_at"]:
        sets.append(f"closed_at = ${i}"); params.append(datetime.now(timezone.utc)); i += 1
    elif body.stage and not body.stage.startswith("closed_") and existing["closed_at"]:
        sets.append(f"closed_at = ${i}"); params.append(None); i += 1

    if not sets:
        return {"success": True, "data": dict(existing)}

    params.append(opp_id)
    async with conn.transaction():
        await conn.execute(
            f"UPDATE bedrock.jobs_opportunity SET {', '.join(sets)} WHERE id=${i}",
            *params,
        )
        if stage_changed:
            await conn.execute(
                """
                INSERT INTO bedrock.jobs_stage_history
                    (opportunity_id, from_stage, to_stage, changed_by, note)
                VALUES ($1,$2,$3,$4,$5)
                """,
                opp_id, existing["stage"], body.stage, user_email, body.note,
            )

    row = await conn.fetchrow("SELECT * FROM bedrock.jobs_opportunity WHERE id=$1", opp_id)
    return {"success": True, "data": dict(row)}


@router.delete("/opportunities/{opp_id}")
async def delete_opportunity(
    opp_id: UUID,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    user_email = user.get("email") if isinstance(user, dict) else getattr(user, "email", None)
    result = await conn.execute(
        """
        UPDATE bedrock.jobs_opportunity
        SET deleted_at=now(), deleted_by=$2
        WHERE id=$1 AND deleted_at IS NULL
        """,
        opp_id, user_email,
    )
    if result == "UPDATE 0":
        raise HTTPException(404, "Opportunity not found")
    return {"success": True, "data": {"deleted": True}}


# ── Activity delete ──────────────────────────────────────────────────────────

@router.delete("/activity/{activity_id}")
async def delete_activity(
    activity_id: UUID,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    result = await conn.execute(
        "UPDATE bedrock.activity SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL",
        activity_id,
    )
    if result == "UPDATE 0":
        raise HTTPException(404, "Activity not found")
    return {"success": True, "data": {"deleted": True}}


# ── Builders search ───────────────────────────────────────────────────────────

@router.get("/builders")
async def list_builders(
    search: Optional[str] = Query(None),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Return known builders from across all deal builder_ids arrays."""
    rows = await conn.fetch(
        """
        SELECT DISTINCT unnest(builder_ids) AS email
        FROM bedrock.jobs_opportunity
        WHERE deleted_at IS NULL AND array_length(builder_ids, 1) > 0
        ORDER BY 1
        """
    )
    emails = [r["email"] for r in rows if r["email"]]
    if search:
        s = search.lower()
        emails = [e for e in emails if s in e.lower()]
    # Format as {email, name} objects
    def _name(email: str) -> str:
        local = email.split("@")[0].replace(".", " ")
        return " ".join(p.capitalize() for p in local.split())
    return {
        "success": True,
        "data": [{"email": e, "name": _name(e)} for e in emails],
    }


# ── Contact PATCH ────────────────────────────────────────────────────────────

class ContactUpdate(BaseModel):
    full_name:       Optional[str] = None
    email:           Optional[str] = None
    current_title:   Optional[str] = None
    current_company: Optional[str] = None
    contact_stage:   Optional[str] = None
    linkedin_url:    Optional[str] = None
    notes:           Optional[str] = None


@router.patch("/contacts/{contact_id}")
async def update_contact(
    contact_id: int,
    body: ContactUpdate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    existing = await conn.fetchrow(
        "SELECT contact_id FROM public.contacts WHERE contact_id=$1 AND airtable_id IS NOT NULL",
        contact_id,
    )
    if not existing:
        raise HTTPException(404, "Contact not found")

    sets, params = [], []
    i = 1
    for field in ("full_name", "email", "current_title", "current_company",
                  "contact_stage", "linkedin_url", "notes"):
        val = getattr(body, field, None)
        if val is not None:
            sets.append(f"{field} = ${i}"); params.append(val); i += 1

    if not sets:
        row = await conn.fetchrow("SELECT * FROM public.contacts WHERE contact_id=$1", contact_id)
        return {"success": True, "data": dict(row)}

    params.append(contact_id)
    await conn.execute(
        f"UPDATE public.contacts SET {', '.join(sets)}, updated_at=now() WHERE contact_id=${i}",
        *params,
    )
    row = await conn.fetchrow("SELECT * FROM public.contacts WHERE contact_id=$1", contact_id)
    return {"success": True, "data": dict(row)}


# ── Activity logging ─────────────────────────────────────────────────────────

class ActivityCreate(BaseModel):
    jobs_opportunity_id: str
    type:                str          # email | call | meeting | note
    description:         str
    activity_date:       Optional[datetime] = None
    subject:             Optional[str] = None


@router.post("/activity")
async def log_activity(
    body: ActivityCreate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    user_email = user.get("email") if isinstance(user, dict) else getattr(user, "email", None)
    if body.type not in ("email", "call", "meeting", "note"):
        raise HTTPException(400, f"Invalid type: {body.type}")

    import uuid as _uuid
    opp_id = _uuid.UUID(body.jobs_opportunity_id)

    row_id = await conn.fetchval(
        """
        INSERT INTO bedrock.activity
            (type, subject, description, activity_date, source, jobs_opportunity_id, logged_by)
        VALUES ($1, $2, $3, COALESCE($4, now()), 'manual', $5, $6)
        RETURNING id
        """,
        body.type,
        body.subject or f"{body.type.capitalize()} — {user_email}",
        body.description,
        body.activity_date,
        opp_id,
        user_email,
    )
    row = await conn.fetchrow("SELECT * FROM bedrock.activity WHERE id=$1", row_id)
    return {"success": True, "data": dict(row)}
