"""Jobs pipeline API.

  GET    /api/jobs/opportunities              — list (filterable by stage, owner, account)
  POST   /api/jobs/opportunities              — create
  GET    /api/jobs/opportunities/:id          — get one with stage history + activity
  PATCH  /api/jobs/opportunities/:id          — update (stage change auto-logs history)
  DELETE /api/jobs/opportunities/:id          — soft delete
  GET    /api/jobs/opportunities/pipeline     — grouped stage counts for pipeline view
"""

import logging
from datetime import date, datetime, timezone
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

# SQL predicate (alias `a`) selecting activity relevant to the jobs pipeline:
# manual logs + synced (gmail/calendar) touches tied to a jobs opportunity
# (its SF account or the deal itself) or to a jobs prospect. This is what makes
# the Performance dashboard's Outreach / Calls reflect the nightly sync.
JOBS_ACTIVITY_SCOPE = """
    a.source = 'manual'
    OR a.jobs_opportunity_id IS NOT NULL
    OR a.account_id IN (
        SELECT account_id FROM bedrock.jobs_opportunity
        WHERE deleted_at IS NULL AND account_id IS NOT NULL AND account_id <> ''
    )
    OR a.participant_public_contact_id IN (
        SELECT contact_id FROM public.contacts WHERE is_jobs_contact = true
    )
"""

# The jobs team's mailboxes. The Outreach and Calls/Mtgs dashboard metrics count
# FIRST TOUCHES by these senders only: each external contact counts once, ever,
# across the whole team (3 emails to the same person in a week = 1; emailing
# someone the team already reached before = 0). Synced gmail/calendar only —
# manual deal-logs have no counterpart email to dedupe on.
JOBS_TEAM_EMAILS = ["avni@pursuit.org", "damon.kornhauser@pursuit.org"]

_FT_EXTERNAL = """
        WHERE counterpart NOT LIKE '%@pursuit.org' AND counterpart NOT LIKE '%@pursuit.com'
          AND counterpart NOT LIKE '%.calendar.google.com' AND counterpart <> ''
"""


def _first_touch_email_cte() -> str:
    """CTE `ext(counterpart, first_touch)`: external recipients of outbound
    emails sent by the jobs team, with each contact's first-ever touch date."""
    sender = " OR ".join(f"a.email_from ILIKE '%{e}%'" for e in JOBS_TEAM_EMAILS)
    return f"""
    WITH outbound AS (
      SELECT lower(e) AS counterpart, a.activity_date
      FROM bedrock.activity a,
           unnest(coalesce(a.email_to,'{{}}') || coalesce(a.email_cc,'{{}}')) e
      WHERE a.source = 'gmail-sync' AND a.deleted_at IS NULL AND ({sender})
    ),
    ext AS (
      SELECT counterpart, min(activity_date) AS first_touch
      FROM outbound {_FT_EXTERNAL}
      GROUP BY counterpart
    )
    """


def _first_touch_meeting_cte() -> str:
    """CTE `ext(counterpart, first_touch)`: external attendees of meetings on
    the jobs team's calendars, with each person's first-ever meeting date."""
    team = ", ".join(f"'{e}'" for e in JOBS_TEAM_EMAILS)
    return f"""
    WITH mtg AS (
      SELECT lower(att->>'email') AS counterpart, a.activity_date
      FROM bedrock.activity a, jsonb_array_elements(a.meeting_attendees) att
      WHERE a.source = 'calendar-sync' AND a.deleted_at IS NULL
        AND lower(a.logged_by) IN ({team})
    ),
    ext AS (
      SELECT counterpart, min(activity_date) AS first_touch
      FROM mtg {_FT_EXTERNAL}
      GROUP BY counterpart
    )
    """

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


VALID_LIKELIHOODS = {"low", "medium", "high"}


class OpportunityCreate(BaseModel):
    account_id: str
    account_name: Optional[str] = None
    stage: str = "lead_submitted"
    deal_type: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    salary_expected: Optional[int] = None
    num_roles: Optional[int] = None
    likelihood: Optional[str] = None
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
    num_roles: Optional[int] = None
    likelihood: Optional[str] = None
    source: Optional[str] = None
    owner_email: Optional[str] = None
    sf_contact_ids: Optional[list[str]] = None
    builder_ids: Optional[list[str]] = None
    follow_up_date: Optional[datetime] = None
    touch_count: Optional[int] = None
    sf_opportunity_id: Optional[str] = None
    note: Optional[str] = None  # optional note when changing stage


@router.get("/metrics/{key}")
async def metric_drilldown(
    key: str,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Return the underlying records behind a leadership-dashboard metric.

    Generic shape: {title, columns:[{key,label}], rows:[{...}], count}.
    Lets the frontend render any metric's detail in one table component.
    """
    ENGAGED = ("initial_outreach", "active", "on_hold")

    # ---- contact-based metrics ----
    contact_cols = [
        {"key": "full_name", "label": "Name"},
        {"key": "current_company", "label": "Company"},
        {"key": "current_title", "label": "Title"},
        {"key": "contact_stage", "label": "Stage"},
        {"key": "email", "label": "Email"},
    ]
    # ---- deal-based metrics ----
    deal_cols = [
        {"key": "account_name", "label": "Company"},
        {"key": "stage", "label": "Stage"},
        {"key": "deal_type", "label": "Type"},
        {"key": "owner_email", "label": "Owner"},
        {"key": "title", "label": "Role"},
    ]
    # ---- activity-based metrics ----
    activity_cols = [
        {"key": "type", "label": "Type"},
        {"key": "subject", "label": "Subject"},
        {"key": "activity_date", "label": "Date"},
        {"key": "logged_by", "label": "Logged By"},
    ]
    # ---- application-based metrics ----
    app_cols = [
        {"key": "company_name", "label": "Company"},
        {"key": "role_title", "label": "Role"},
        {"key": "stage", "label": "Stage"},
        {"key": "date_applied", "label": "Applied"},
    ]

    async def contacts(where: str):
        rows = await conn.fetch(
            f"SELECT contact_id AS id, full_name, current_company, current_title, contact_stage, email "
            f"FROM public.contacts WHERE is_jobs_contact=true AND {where} "
            f"ORDER BY full_name"
        )
        return contact_cols, [dict(r) for r in rows], "contact"

    async def deals(where: str):
        rows = await conn.fetch(
            f"SELECT id, account_name, stage, deal_type, owner_email, title "
            f"FROM bedrock.jobs_opportunity WHERE deleted_at IS NULL AND {where} "
            f"ORDER BY account_name"
        )
        return deal_cols, [dict(r) for r in rows], "deal"

    async def activity(where: str):
        # Jobs-scoped activity = manual logs + synced (gmail/calendar) touches tied
        # to a jobs opportunity (account or deal) or a jobs prospect. Keeps the
        # Outreach/Calls metrics reflecting the nightly Gmail/Calendar sync.
        rows = await conn.fetch(
            f"SELECT id, type, subject, activity_date, logged_by, description "
            f"FROM bedrock.activity a WHERE a.deleted_at IS NULL AND ({JOBS_ACTIVITY_SCOPE}) AND {where} "
            f"ORDER BY activity_date DESC NULLS LAST LIMIT 500"
        )
        return activity_cols, [dict(r) for r in rows], "activity"

    async def engaged_prospects(_where: str):
        # Distinct jobs prospects we've actually had activity with (linked via
        # participant_public_contact_id by the jobs-activity-link pass).
        rows = await conn.fetch(
            "SELECT contact_id AS id, full_name, current_company, current_title, contact_stage, email "
            "FROM public.contacts ct WHERE ct.is_jobs_contact=true AND EXISTS("
            "  SELECT 1 FROM bedrock.activity a "
            "  WHERE a.participant_public_contact_id = ct.contact_id AND a.deleted_at IS NULL) "
            "ORDER BY full_name"
        )
        return contact_cols, [dict(r) for r in rows], "contact"

    # First-touch drill: one row per external contact, with their first-ever
    # touch by the jobs team and (when their email matches a jobs prospect)
    # the known prospect name/company.
    ft_cols = [
        {"key": "email", "label": "Contact"},
        {"key": "full_name", "label": "Known Prospect"},
        {"key": "current_company", "label": "Company"},
        {"key": "first_touch", "label": "First Touch"},
    ]

    async def first_touch(kind: str, where: str):
        cte = _first_touch_email_cte() if kind == "email" else _first_touch_meeting_cte()
        rows = await conn.fetch(f"""
            {cte}
            SELECT ext.counterpart AS email, ext.first_touch,
                   p.full_name, p.current_company
            FROM ext
            LEFT JOIN LATERAL (
                SELECT full_name, current_company FROM public.contacts c
                WHERE lower(c.email) = ext.counterpart AND c.is_jobs_contact = true
                LIMIT 1
            ) p ON true
            WHERE {where}
            ORDER BY ext.first_touch DESC
            LIMIT 500
        """)
        return ft_cols, [dict(r) for r in rows], "activity"

    # Company-level rollup for the "Companies with…" metrics — one row per company.
    company_cols = [
        {"key": "company_name", "label": "Company"},
        {"key": "candidates", "label": "# Candidates"},
        {"key": "roles", "label": "Roles"},
    ]

    async def companies(where: str):
        rows = await conn.fetch(
            f"""
            SELECT company_name,
                   count(*)                              AS candidates,
                   string_agg(DISTINCT role_title, ', ') AS roles
            FROM public.job_applications
            WHERE source_type='Pursuit_referred' AND {where}
            GROUP BY company_name
            ORDER BY count(*) DESC, company_name
            """
        )
        return company_cols, [dict(r) for r in rows], "company"

    def _type_label(t):
        if t == "full_time":
            return "Full-Time"
        if t in ("contract", "freelance"):
            return "PT / Contract"
        return (t or "—").replace("_", " ").title()

    async def placements(where: str):
        # Grouped by BUILDER → expandable to all their paid placements.
        rows = await conn.fetch(
            f"SELECT * FROM bedrock.secured_jobs() WHERE payment_amount > 0 AND {where} ORDER BY builder"
        )
        groups: dict = {}
        for r in rows:
            uid = r["user_id"]
            g = groups.setdefault(uid, {"builder": r["builder"], "ft": False, "children": []})
            if r["employment_type"] == "full_time":
                g["ft"] = True
            g["children"].append({
                "role_title": r["role_title"] or "—",
                "company_name": r["company_name"] or "—",
                "employment_type": _type_label(r["employment_type"]),
                "salary": f"${int(r['payment_amount']):,}" if r["payment_amount"] else "—",
                "influence": ("Influenced" if r["influenced"] is True
                              else "Self-sourced" if r["influenced"] is False else "Unclassified"),
                "source": r["source"],
            })
        out = []
        for g in sorted(groups.values(), key=lambda x: (not x["ft"], x["builder"] or "")):
            out.append({
                "builder": g["builder"],
                "placements": str(len(g["children"])),
                "status": "Full-Time" if g["ft"] else "PT / Contract",
                "_children": g["children"],
            })
        cols = [
            {"key": "builder", "label": "Builder"},
            {"key": "status", "label": "Status"},
            {"key": "placements", "label": "# Placements"},
        ]
        child_cols = [
            {"key": "company_name", "label": "Company"},
            {"key": "role_title", "label": "Role"},
            {"key": "employment_type", "label": "Type"},
            {"key": "salary", "label": "Pay"},
            {"key": "influence", "label": "Influence"},
            {"key": "source", "label": "Source"},
        ]
        return {"columns": cols, "child_columns": child_cols}, out, "placement"

    DISPATCH = {
        "total_leads":          ("Total Leads",              lambda: contacts("true")),
        "engaged_leads":        ("Engaged Prospects",        lambda: engaged_prospects("true")),
        "outreach_week":        ("New Contacts Emailed — Last 7 Days", lambda: first_touch("email", "ext.first_touch >= now() - interval '7 days'")),
        "outreach_total":       ("Contacts Emailed — All Time",        lambda: first_touch("email", "true")),
        "calls_total":          ("Contacts Met — All Time",            lambda: first_touch("meeting", "true")),
        "calls_week":           ("New Contacts Met — Last 7 Days",     lambda: first_touch("meeting", "ext.first_touch >= now() - interval '7 days'")),
        "active_orgs":          ("Active Orgs",              lambda: deals("stage LIKE 'active_%'")),
        "active_companies":     ("Active Companies",         lambda: deals("stage LIKE 'active_%'")),
        "in_discussion":        ("In Discussion",            lambda: deals("stage='active_in_discussions'")),
        "builder_interviews":   ("Builder Interview",        lambda: deals("stage='active_builder_interview'")),
        "placements":           ("Secured Jobs (Placements)", lambda: placements("true")),
        "candidates_submitted": ("Companies w/ Candidates Submitted", lambda: companies("stage IN ('applied','interview','accepted')")),
        "interviewing":         ("Companies Interviewing Builders",   lambda: companies("stage='interview'")),
    }

    if key not in DISPATCH:
        raise HTTPException(404, f"Unknown metric: {key}")

    title, fn = DISPATCH[key]
    columns, rows, entity = await fn()
    # columns may be a list (flat table) or a dict {columns, child_columns} (expandable)
    child_columns = None
    if isinstance(columns, dict):
        child_columns = columns.get("child_columns")
        columns = columns["columns"]
    # serialize dates + ids
    for r in rows:
        for k, v in list(r.items()):
            if hasattr(v, "isoformat"):
                r[k] = v.isoformat()
            elif k == "id" and v is not None:
                r[k] = str(v)
    return {
        "success": True,
        "data": {
            "title": title, "columns": columns, "rows": rows,
            "count": len(rows), "entity": entity, "child_columns": child_columns,
        },
    }


@router.get("/placements")
async def get_placements(user=Depends(require_auth), conn=Depends(get_db)):
    """Secured jobs — single source of truth = public.employment_records.

    Counts ALL placements (incl. builder self-sourced, no deal link) and
    separates by `influenced` (jobs-team influenced / self-sourced / unclassified).
    """
    rows = await conn.fetch("SELECT * FROM bedrock.secured_jobs() WHERE payment_amount > 0")

    # Metric is DISTINCT BUILDERS placed (a builder with 2 PT jobs counts once).
    # Two tracked numbers: any paid work, and full-time.
    def best(a, b):
        """Pick the more representative placement for a builder: FT > influenced > higher pay."""
        ka = (a["employment_type"] == "full_time", a["influenced"] is True, a["payment_amount"] or 0)
        kb = (b["employment_type"] == "full_time", b["influenced"] is True, b["payment_amount"] or 0)
        return a if ka >= kb else b

    by_builder: dict = {}
    for r in rows:
        uid = r["user_id"]
        by_builder[uid] = best(by_builder[uid], r) if uid in by_builder else r

    # A builder is FT-placed if ANY of their paid records is full_time.
    ft_uids   = {r["user_id"] for r in rows if r["employment_type"] == "full_time"}
    any_uids  = set(by_builder.keys())
    infl_uids = {r["user_id"] for r in rows if r["influenced"] is True}

    ft_builders   = len(ft_uids)
    any_builders  = len(any_uids)
    infl_ft       = len(ft_uids & infl_uids)
    infl_any      = len(any_uids & infl_uids)

    # One row per builder for the drill list (their representative placement)
    out = []
    for uid, r in sorted(by_builder.items(),
                         key=lambda kv: (kv[1]["employment_type"] != "full_time", kv[1]["builder"] or "")):
        et = r["employment_type"]
        type_label = ("Full-Time" if et == "full_time"
                      else "PT / Contract" if et in ("contract", "freelance")
                      else (et or "—").replace("_", " ").title())
        out.append({
            "id": str(r["id"]),
            "builder": r["builder"],
            "role_title": r["role_title"] or "—",
            "company_name": r["company_name"] or "—",
            "employment_type": type_label,
            "ft_placed": uid in ft_uids,
            "influenced": r["influenced"],
            "salary": int(r["payment_amount"]) if r["payment_amount"] else None,
            "source": r["source"],
        })

    return {
        "success": True,
        "data": {
            "ft_builders":  ft_builders,
            "any_builders": any_builders,
            "influenced_ft":  infl_ft,
            "influenced_any": infl_any,
            "rows": out,
        },
    }


@router.get("/staff")
async def list_staff(
    q: Optional[str] = Query(None),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Active Pursuit staff (for owner pickers). Deduped by email."""
    rows = await conn.fetch("""
        SELECT DISTINCT ON (lower(email)) email, display_name
        FROM public.org_users
        WHERE is_active = true AND email IS NOT NULL
        ORDER BY lower(email), display_name
    """)
    out = [{"email": r["email"], "name": r["display_name"] or r["email"]} for r in rows]
    if q:
        ql = q.lower()
        out = [s for s in out if ql in s["email"].lower() or ql in (s["name"] or "").lower()]
    out.sort(key=lambda s: s["name"])
    return {"success": True, "data": out[:50]}


@router.get("/placements/unlinked")
async def search_unlinked_placements(
    q: Optional[str] = Query(None),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Existing employment_records not yet tied to an opportunity (for linking on win)."""
    rows = await conn.fetch("""
        SELECT er.id, er.role_title, er.company_name, er.employment_type,
               COALESCE(NULLIF(trim(u.first_name||' '||u.last_name),''),
                        'Builder #'||er.user_id) AS builder
        FROM public.employment_records er
        LEFT JOIN public.users u ON u.user_id = er.user_id
        WHERE er.opportunity_id IS NULL
        ORDER BY er.id DESC LIMIT 200
    """)
    out = [
        {"id": str(r["id"]), "builder": r["builder"], "role_title": r["role_title"],
         "company_name": r["company_name"], "employment_type": r["employment_type"]}
        for r in rows
    ]
    if q:
        ql = q.lower()
        out = [r for r in out if ql in (r["builder"] or "").lower()
               or ql in (r["company_name"] or "").lower()
               or ql in (r["role_title"] or "").lower()]
    return {"success": True, "data": out[:30]}


@router.get("/opportunities/{opp_id}/placements")
async def list_opp_placements(
    opp_id: UUID,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Placements already linked to this opportunity."""
    rows = await conn.fetch("""
        SELECT er.id, er.role_title, er.company_name, er.employment_type,
               er.payment_amount, er.user_id,
               COALESCE(NULLIF(trim(u.first_name||' '||u.last_name),''),
                        'Builder #'||er.user_id) AS builder
        FROM public.employment_records er
        LEFT JOIN public.users u ON u.user_id = er.user_id
        WHERE er.opportunity_id = $1
        ORDER BY er.id
    """, opp_id)
    return {"success": True, "data": [
        {"id": str(r["id"]), "builder": r["builder"], "role_title": r["role_title"],
         "company_name": r["company_name"], "employment_type": r["employment_type"],
         "salary": int(r["payment_amount"]) if r["payment_amount"] else None}
        for r in rows
    ]}


class PlacementCreate(BaseModel):
    builder_user_id: Optional[int] = None   # link to a platform builder if known
    builder_name:    Optional[str] = None   # free-text fallback
    role_title:      Optional[str] = None
    employment_type: str = "full_time"      # full_time | contract | freelance | pro_bono
    salary:          Optional[int] = None


@router.post("/opportunities/{opp_id}/placements")
async def create_opp_placement(
    opp_id: UUID,
    body: PlacementCreate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Create a new secured-job placement under this opportunity (jobs-team influenced)."""
    opp = await conn.fetchrow(
        "SELECT account_id, account_name FROM bedrock.jobs_opportunity WHERE id=$1 AND deleted_at IS NULL",
        opp_id,
    )
    if not opp:
        raise HTTPException(404, "Opportunity not found")

    user_email = user.get("email") if isinstance(user, dict) else getattr(user, "email", None)
    # employment_records.user_id is NOT NULL — require a builder_user_id, or store name in story/notes
    if not body.builder_user_id and not body.builder_name:
        raise HTTPException(400, "Provide builder_user_id or builder_name")

    role = body.role_title or "(role TBD)"
    notes = f"{body.builder_name}: jobs-team placement" if body.builder_name else "jobs-team placement"

    if body.builder_user_id:
        # Dedup guard: if this builder already has a placement at this company,
        # enrich it with jobs-team attribution instead of creating a duplicate.
        existing = await conn.fetchrow("""
            SELECT id FROM public.employment_records
            WHERE user_id = $1 AND lower(company_name) = lower($2)
            ORDER BY id LIMIT 1
        """, body.builder_user_id, opp["account_name"])
        if existing:
            await conn.execute("""
                UPDATE public.employment_records
                SET opportunity_id=$1, influenced=true,
                    role_title=COALESCE(role_title, $2),
                    employment_type=COALESCE(NULLIF(employment_type,''), $3),
                    payment_amount=COALESCE(payment_amount, $4),
                    updated_at=now()
                WHERE id=$5
            """, opp_id, role, body.employment_type, body.salary, existing["id"])
            return {"success": True, "data": {"id": str(existing["id"]), "merged": True}}

        new_id = await conn.fetchval("""
            INSERT INTO public.employment_records
                (user_id, role_title, company_name, employment_type, engagement_stage,
                 payment_amount, source, opportunity_id, influenced, notes)
            VALUES ($1,$2,$3,$4,'completed',$5,'staff_created',$6,true,$7)
            RETURNING id
        """, body.builder_user_id, role, opp["account_name"], body.employment_type,
            body.salary, opp_id, notes)
    else:
        # No platform user — store as a name-only record (user_id required, use 0 sentinel won't work
        # if FK; instead reject). Most placements should link a real builder.
        raise HTTPException(400, "builder_user_id required to create a placement (name-only not supported)")

    return {"success": True, "data": {"id": str(new_id)}}


@router.post("/opportunities/{opp_id}/placements/{placement_id}/link")
async def link_opp_placement(
    opp_id: UUID,
    placement_id: int,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Link an existing employment_record to this opportunity (mark jobs-team influenced)."""
    result = await conn.execute(
        "UPDATE public.employment_records SET opportunity_id=$1, influenced=true, updated_at=now() WHERE id=$2",
        opp_id, placement_id,
    )
    if result == "UPDATE 0":
        raise HTTPException(404, "Placement not found")
    return {"success": True, "data": {"id": str(placement_id), "opportunity_id": str(opp_id)}}


class PlacementUpdate(BaseModel):
    influenced: Optional[bool] = None  # true / false / null (unclassify)


@router.patch("/placements/{placement_id}")
async def update_placement(
    placement_id: int,
    body: PlacementUpdate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Set the influence attribution on a secured job."""
    result = await conn.execute(
        "UPDATE public.employment_records SET influenced=$1, updated_at=now() WHERE id=$2",
        body.influenced, placement_id,
    )
    if result == "UPDATE 0":
        raise HTTPException(404, "Placement not found")
    return {"success": True, "data": {"id": placement_id, "influenced": body.influenced}}


# ── Roles (jobs_role) — open roles on an opportunity ──────────────────────────

VALID_ROLE_STATUSES = {"open", "filled", "cancelled"}


def _role_dict(r) -> dict:
    """Serialize a bedrock.jobs_role row for the API."""
    d = dict(r)
    d["id"] = str(d["id"])
    if d.get("opportunity_id") is not None:
        d["opportunity_id"] = str(d["opportunity_id"])
    for k in ("start_date", "created_at", "updated_at"):
        v = d.get(k)
        if v is not None and hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


class RoleCreate(BaseModel):
    title:           str
    approx_salary:   Optional[int] = None
    employment_type: Optional[str] = None
    start_date:      Optional[date] = None
    notes:           Optional[str] = None


class RoleUpdate(BaseModel):
    title:           Optional[str] = None
    approx_salary:   Optional[int] = None
    employment_type: Optional[str] = None
    start_date:      Optional[date] = None
    status:          Optional[str] = None
    notes:           Optional[str] = None


@router.get("/opportunities/{opp_id}/roles")
async def list_opp_roles(
    opp_id: UUID,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """All roles (any status) for an opportunity, oldest first."""
    rows = await conn.fetch(
        "SELECT * FROM bedrock.jobs_role WHERE opportunity_id=$1 ORDER BY created_at",
        opp_id,
    )
    return {"success": True, "data": [_role_dict(r) for r in rows]}


@router.post("/opportunities/{opp_id}/roles")
async def create_opp_role(
    opp_id: UUID,
    body: RoleCreate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Create an open role on an opportunity."""
    opp = await conn.fetchrow(
        "SELECT id FROM bedrock.jobs_opportunity WHERE id=$1 AND deleted_at IS NULL",
        opp_id,
    )
    if not opp:
        raise HTTPException(404, "Opportunity not found")

    row = await conn.fetchrow(
        """
        INSERT INTO bedrock.jobs_role
            (opportunity_id, title, approx_salary, employment_type, start_date, status, notes)
        VALUES ($1,$2,$3,$4,$5,'open',$6)
        RETURNING *
        """,
        opp_id, body.title, body.approx_salary, body.employment_type,
        body.start_date, body.notes,
    )
    return {"success": True, "data": _role_dict(row)}


@router.patch("/roles/{role_id}")
async def update_role(
    role_id: UUID,
    body: RoleUpdate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Update any of title/approx_salary/employment_type/start_date/status/notes."""
    if body.status is not None and body.status not in VALID_ROLE_STATUSES:
        raise HTTPException(400, f"Invalid status: {body.status}")

    existing = await conn.fetchrow("SELECT * FROM bedrock.jobs_role WHERE id=$1", role_id)
    if not existing:
        raise HTTPException(404, "Role not found")

    sets, params = [], []
    i = 1
    for field in ("title", "approx_salary", "employment_type", "start_date", "status", "notes"):
        val = getattr(body, field, None)
        if val is not None:
            sets.append(f"{field} = ${i}"); params.append(val); i += 1

    if not sets:
        return {"success": True, "data": _role_dict(existing)}

    params.append(role_id)
    row = await conn.fetchrow(
        f"UPDATE bedrock.jobs_role SET {', '.join(sets)}, updated_at=now() WHERE id=${i} RETURNING *",
        *params,
    )
    return {"success": True, "data": _role_dict(row)}


@router.delete("/roles/{role_id}")
async def delete_role(
    role_id: UUID,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Hard-delete a role (jobs-team owned, low volume)."""
    result = await conn.execute("DELETE FROM bedrock.jobs_role WHERE id=$1", role_id)
    if result == "DELETE 0":
        raise HTTPException(404, "Role not found")
    return {"success": True, "data": {"deleted": True}}


class RoleHire(BaseModel):
    user_id:         int
    start_date:      Optional[date] = None
    salary:          Optional[int] = None
    employment_type: Optional[str] = None


@router.post("/roles/{role_id}/hire")
async def hire_into_role(
    role_id: UUID,
    body: RoleHire,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Fill a role: create the employment_record placement and mark the role filled."""
    role = await conn.fetchrow("SELECT * FROM bedrock.jobs_role WHERE id=$1", role_id)
    if not role:
        raise HTTPException(404, "Role not found")
    opp = await conn.fetchrow(
        "SELECT id, account_name FROM bedrock.jobs_opportunity WHERE id=$1 AND deleted_at IS NULL",
        role["opportunity_id"],
    )
    if not opp:
        raise HTTPException(404, "Opportunity not found")

    employment_type = body.employment_type or role["employment_type"] or "full_time"
    payment_amount  = body.salary if body.salary is not None else role["approx_salary"]
    start_date      = body.start_date or role["start_date"]

    async with conn.transaction():
        new_id = await conn.fetchval(
            """
            INSERT INTO public.employment_records
                (user_id, role_title, company_name, employment_type, engagement_stage,
                 payment_amount, source, opportunity_id, influenced, start_date)
            VALUES ($1,$2,$3,$4,'active',$5,'staff_created',$6,true,$7)
            RETURNING id
            """,
            body.user_id, role["title"], opp["account_name"], employment_type,
            payment_amount, opp["id"], start_date,
        )
        updated = await conn.fetchrow(
            """
            UPDATE bedrock.jobs_role
            SET status='filled', filled_by_user_id=$1, employment_record_id=$2, updated_at=now()
            WHERE id=$3
            RETURNING *
            """,
            body.user_id, new_id, role_id,
        )
    return {"success": True, "data": {"role": _role_dict(updated), "employment_record_id": new_id}}


# ── Builder activity on an opportunity ────────────────────────────────────────

@router.get("/opportunities/{opp_id}/builder-activity")
async def opp_builder_activity(
    opp_id: UUID,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Builder submissions/interviews/hires tied to this opportunity.

    Rows come from public.job_applications where jobs_opportunity_id matches.
    Includes a stage summary {applied, interview, accepted}.
    """
    rows = await conn.fetch(
        """
        SELECT job_application_id,
               trim(split_part(notes, ':', 1)) AS builder,
               company_name, role_title, stage, jobs_role_id, date_applied
        FROM public.job_applications
        WHERE jobs_opportunity_id = $1
        ORDER BY date_applied DESC NULLS LAST
        """,
        opp_id,
    )
    out = []
    summary = {"applied": 0, "interview": 0, "accepted": 0}
    for r in rows:
        if r["stage"] in summary:
            summary[r["stage"]] += 1
        out.append({
            "job_application_id": r["job_application_id"],
            "builder":            r["builder"],
            "company_name":       r["company_name"],
            "role_title":         r["role_title"],
            "stage":              r["stage"],
            "jobs_role_id":       str(r["jobs_role_id"]) if r["jobs_role_id"] else None,
            "date_applied":       r["date_applied"].isoformat() if r["date_applied"] else None,
        })
    return {"success": True, "data": {"rows": out, "summary": summary}}


@router.get("/funnel/{ftype}")
async def get_funnel(ftype: str, user=Depends(require_auth), conn=Depends(get_db)):
    """Unified funnel for the three pipelines: opportunities | prospects | builders.

    Returns ordered stages with counts, conversion-to-next, and the records in
    each stage (for inline expand). Opportunities also include recent
    progression (advanced/regressed) from bedrock.jobs_stage_history.
    """
    movement_by_stage: dict = {}  # stage_key -> list of recent transitions touching it

    if ftype == "opportunities":
        stage_order = [
            ("lead_submitted", "Lead Submitted"),
            ("initial_outreach", "Initial Outreach"),
            ("active_in_discussions", "In Discussions"),
            ("active_opportunity_confirmed", "Opportunity Confirmed"),
            ("active_builder_interview", "Builder Interview"),
            ("closed_won", "Closed — Won"),
        ]
        record_columns = [
            {"key": "name", "label": "Company"},
            {"key": "deal_type", "label": "Type"},
            {"key": "owner", "label": "Owner"},
        ]
        rows = await conn.fetch("""
            SELECT stage, account_name AS name, deal_type, owner_email AS owner
            FROM bedrock.jobs_opportunity
            WHERE deleted_at IS NULL ORDER BY account_name
        """)
        by_stage: dict = {}
        for r in rows:
            by_stage.setdefault(r["stage"], []).append(
                {"name": r["name"], "deal_type": r["deal_type"], "owner": r["owner"]}
            )

        idx = {k: i for i, (k, _) in enumerate(stage_order)}
        label_of = dict(stage_order)
        hist = await conn.fetch("""
            SELECT h.from_stage, h.to_stage, h.changed_at, o.account_name
            FROM bedrock.jobs_stage_history h
            JOIN bedrock.jobs_opportunity o ON o.id = h.opportunity_id
            WHERE h.from_stage IS NOT NULL
              AND h.changed_at >= now() - interval '30 days'
            ORDER BY h.changed_at DESC LIMIT 100
        """)
        for h in hist:
            fi, ti = idx.get(h["from_stage"]), idx.get(h["to_stage"])
            direction = "advanced" if (fi is not None and ti is not None and ti > fi) else "regressed"
            item = {
                "name": h["account_name"],
                "from_label": label_of.get(h["from_stage"], h["from_stage"]),
                "to_label": label_of.get(h["to_stage"], h["to_stage"]),
                "direction": direction,
                "when": h["changed_at"].isoformat() if h["changed_at"] else None,
            }
            # attach to the destination stage (moved into) and origin stage (moved out of)
            movement_by_stage.setdefault(h["to_stage"], []).append({**item, "flow": "in"})
            movement_by_stage.setdefault(h["from_stage"], []).append({**item, "flow": "out"})

    elif ftype == "prospects":
        stage_order = [
            ("lead", "Lead"),
            ("initial_outreach", "Initial Outreach"),
            ("active", "Active"),
            ("on_hold", "On Hold"),
        ]
        record_columns = [
            {"key": "name", "label": "Contact"},
            {"key": "company", "label": "Company"},
        ]
        rows = await conn.fetch("""
            SELECT contact_stage AS stage, full_name AS name, current_company AS company
            FROM public.contacts WHERE is_jobs_contact=true ORDER BY full_name
        """)
        by_stage = {}
        for r in rows:
            by_stage.setdefault(r["stage"], []).append({"name": r["name"], "company": r["company"]})

    elif ftype == "builders":
        stage_order = [
            ("applied", "Applied"),
            ("interview", "Interviewing"),
            ("accepted", "Hired"),
        ]
        record_columns = [
            {"key": "name", "label": "Builder"},
            {"key": "company", "label": "Company"},
            {"key": "role", "label": "Role"},
        ]
        rows = await conn.fetch("""
            SELECT stage, trim(split_part(notes,':',1)) AS name,
                   company_name AS company, role_title AS role
            FROM public.job_applications WHERE source_type='Pursuit_referred'
            ORDER BY company_name
        """)
        by_stage = {}
        for r in rows:
            by_stage.setdefault(r["stage"], []).append(
                {"name": r["name"], "company": r["company"], "role": r["role"]}
            )
    else:
        raise HTTPException(404, f"Unknown funnel: {ftype}")

    stages = []
    counts = [len(by_stage.get(k, [])) for k, _ in stage_order]
    max_count = max(counts) if counts else 1
    for i, (k, label) in enumerate(stage_order):
        recs = by_stage.get(k, [])
        cnt = len(recs)
        nxt = counts[i + 1] if i + 1 < len(counts) else None
        conv = round(100 * nxt / cnt) if (nxt is not None and cnt > 0) else None
        mv = movement_by_stage.get(k, [])
        stages.append({
            "key": k, "label": label, "count": cnt,
            "pct_of_max": round(100 * cnt / max_count) if max_count else 0,
            "conversion_to_next": conv,
            "records": recs,
            "movement": mv,
            "advanced_in": sum(1 for m in mv if m["flow"] == "in" and m["direction"] == "advanced"),
            "regressed_in": sum(1 for m in mv if m["flow"] == "in" and m["direction"] == "regressed"),
        })

    return {"success": True, "data": {"type": ftype, "stages": stages, "record_columns": record_columns}}


@router.get("/roles")
async def get_roles(user=Depends(require_auth), conn=Depends(get_db)):
    """Jobs / roles view — hired counts (from placements) + pipeline rows.

    Hired is counted by DISTINCT BUILDER from paid placements
    (public.employment_records, the single source of truth), matching the North
    Star numbers — NOT by application:
      hired_ft       = distinct builders with any paid FULL-TIME placement
      hired_contract = distinct builders in any paid work that is NOT full-time
                       (so the two partition the "in any paid work" total)
      avg_salary_ft  = avg pay of those FT builders' FT placements
    Interviewing / applied / rejected / withdrawn come from the submission
    funnel (public.job_applications, Pursuit-referred). Builder name comes from
    the 'Name: …' prefix stored in notes on import.
    """
    # ── Hired: placements from employment_records ────────────────────────────
    # COUNTS (cards) are by DISTINCT BUILDER with a recorded amount (payment > 0)
    # — "don't count them unless >0". But the table SHOWS every placement record,
    # including ones with no amount yet ("show all, even with $0"), so the team
    # can see (and backfill) them. Excludes pro_bono (never paid) and pipeline
    # (not an actual placement yet).
    plc = await conn.fetch("""
        SELECT * FROM bedrock.secured_jobs()
        WHERE employment_type <> 'pro_bono'
          AND (engagement_stage IS NULL OR engagement_stage NOT IN ('pipeline'))
        ORDER BY (payment_amount > 0) DESC NULLS LAST, payment_amount DESC NULLS LAST, builder
    """)

    out_rows = []
    ft_builders: set = set()
    other_builders: set = set()
    ft_salaries: list[int] = []
    for r in plc:
        is_ft = r["employment_type"] == "full_time"
        salary = int(r["payment_amount"]) if r["payment_amount"] is not None else None
        # distinct-builder counts only credit recorded paid work (payment > 0)
        if salary and salary > 0:
            if is_ft:
                ft_builders.add(r["user_id"])
                ft_salaries.append(salary)
            else:
                other_builders.add(r["user_id"])
        out_rows.append({
            "id": str(r["id"]),
            "builder": r["builder"] or "—",
            "role_title": r["role_title"] or "—",
            "company_name": r["company_name"] or "—",
            "salary": salary,
            "stage": "accepted",
            "segment": "hired_ft" if is_ft else "hired_contract",
        })

    # A builder counted as FT shouldn't also be counted under "other paid".
    other_builders -= ft_builders
    hired_ft = len(ft_builders)
    hired_contract = len(other_builders)

    # ── Pipeline (not-yet-hired): submission funnel from job_applications ─────
    apps = await conn.fetch("""
        SELECT
            ja.job_application_id AS id,
            trim(split_part(ja.notes, ':', 1)) AS builder,
            ja.role_title,
            ja.company_name,
            CASE WHEN ja.salary ~ '^[0-9]+$' THEN ja.salary::int ELSE NULL END AS salary,
            ja.stage
        FROM public.job_applications ja
        WHERE ja.source_type='Pursuit_referred' AND ja.stage <> 'accepted'
        ORDER BY
            CASE ja.stage WHEN 'interview' THEN 1 WHEN 'applied' THEN 2 ELSE 3 END,
            (ja.salary ~ '^[0-9]+$') DESC, ja.company_name
    """)
    seg_map = {"interview": "interviewing", "applied": "applied",
               "rejected": "rejected", "withdrawn": "withdrawn"}
    for r in apps:
        out_rows.append({
            "id": str(r["id"]),
            "builder": r["builder"] or "—",
            "role_title": r["role_title"] or "—",
            "company_name": r["company_name"] or "—",
            "salary": r["salary"],
            "stage": r["stage"],
            "segment": seg_map.get(r["stage"], "other"),
        })

    interviewing = sum(1 for r in out_rows if r["segment"] == "interviewing")
    avg_ft = round(sum(ft_salaries) / len(ft_salaries)) if ft_salaries else None

    return {
        "success": True,
        "data": {
            "committed":       hired_ft + hired_contract + interviewing,  # hired + interviewing
            "hired_ft":        hired_ft,
            "hired_contract":  hired_contract,  # = builders in any paid work, not FT
            "hired_total":     hired_ft + hired_contract,
            "avg_salary_ft":   avg_ft,
            "rows": out_rows,
        },
    }


@router.get("/contacts/summary")
async def get_contacts_summary(user=Depends(require_auth), conn=Depends(get_db)):
    """Contacts & outreach metrics for the leadership dashboard.

    Mirrors the legacy Airtable "Job Outcomes Dash":
      Contacts & Leads:
        Total Leads   = every contact in the jobs pipeline (is_jobs_contact)
        Engaged Leads = those past the lead stage (initial outreach & beyond),
                        i.e. contact_stage IN (initial_outreach, active, on_hold)
      Employer Outreach (manually-logged engagements; source='manual'):
        All Outreach (last week) = engagements logged in the trailing 7 days
        Calls in total           = all call-type engagements
        Calls in last week       = call-type engagements in the trailing 7 days
    """
    stages = await conn.fetch("""
        SELECT contact_stage, count(*) AS count
        FROM public.contacts WHERE is_jobs_contact = true
        GROUP BY contact_stage ORDER BY count DESC
    """)
    total = sum(r["count"] for r in stages)

    # Engaged = distinct jobs prospects we've actually had activity with (manual
    # or synced gmail/calendar), linked via participant_public_contact_id by the
    # jobs-activity-link pass. Grows as the nightly scrape lands new touches.
    engaged = await conn.fetchval("""
        SELECT count(DISTINCT ct.contact_id)
        FROM public.contacts ct
        WHERE ct.is_jobs_contact = true
          AND EXISTS (
            SELECT 1 FROM bedrock.activity a
            WHERE a.participant_public_contact_id = ct.contact_id AND a.deleted_at IS NULL
          )
    """)

    # Outreach / Calls = FIRST TOUCHES by the jobs team (JOBS_TEAM_EMAILS).
    # Outreach: each external contact counts once — the week number is contacts
    # whose first-ever outbound email from the team landed in the last 7 days.
    # Calls/Mtgs: same first-touch rule over external attendees of meetings on
    # the team's calendars.
    em = await conn.fetchrow(f"""
        {_first_touch_email_cte()}
        SELECT count(*) FILTER (WHERE first_touch >= now() - interval '7 days')  AS wk,
               count(*) FILTER (WHERE first_touch >= now() - interval '30 days') AS mo,
               count(*)                                                          AS total
        FROM ext
    """)
    mt = await conn.fetchrow(f"""
        {_first_touch_meeting_cte()}
        SELECT count(*) FILTER (WHERE first_touch >= now() - interval '7 days') AS wk,
               count(*)                                                         AS total
        FROM ext
    """)
    activity = {
        "outreach_total":     em["total"],
        "outreach_this_week": em["wk"],
        "outreach_this_month": em["mo"],
        "calls_total":        mt["total"],
        "calls_this_week":    mt["wk"],
        "meetings_total":     mt["total"],
        "active_owners":      len(JOBS_TEAM_EMAILS),
    }

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


@router.get("/contacts/search")
async def search_all_contacts(
    q: str = Query(..., min_length=2),
    limit: int = Query(20, le=50),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Search ALL contacts in the DB (LinkedIn, SF-linked, Airtable) for the picker UI."""
    rows = await conn.fetch(
        """
        SELECT
            c.contact_id,
            c.full_name,
            c.email,
            c.current_title,
            c.current_company,
            c.source,
            c.airtable_id,
            c.contact_stage,
            scl.sf_contact_id IS NOT NULL AS in_sf,
            -- Reference key to use when linking to a deal
            CASE
                WHEN c.airtable_id IS NOT NULL THEN 'airtable:' || c.airtable_id
                WHEN scl.sf_contact_id IS NOT NULL THEN scl.sf_contact_id
                ELSE 'pub:' || c.contact_id::text
            END AS contact_ref
        FROM public.contacts c
        LEFT JOIN bedrock.sf_contact_link scl ON scl.public_contact_id = c.contact_id
        WHERE
            lower(c.full_name) LIKE lower($1)
            OR lower(c.email) LIKE lower($1)
            OR lower(c.current_company) LIKE lower($1)
        ORDER BY
            CASE WHEN c.airtable_id IS NOT NULL THEN 0
                 WHEN scl.sf_contact_id IS NOT NULL THEN 1
                 ELSE 2 END,
            c.full_name
        LIMIT $2
        """,
        f"%{q}%",
        limit,
    )
    return {
        "success": True,
        "data": [dict(r) for r in rows],
    }


@router.get("/contacts/by-account")
async def contacts_by_account(
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Jobs prospects grouped into account rows by company name.

    No hard account_id on contacts, so we group by the company text
    (COALESCE(NULLIF(trim(current_company),''),'(no company)')). Accounts are
    ordered by contact_count desc, then name.
    """
    rows = await conn.fetch(
        """
        SELECT
            COALESCE(NULLIF(trim(current_company), ''), '(no company)') AS account,
            contact_id, full_name, email, current_title, contact_stage, linkedin_url
        FROM public.contacts
        WHERE is_jobs_contact = true
        ORDER BY account, full_name
        """
    )
    accounts: dict = {}
    for r in rows:
        acct = r["account"]
        g = accounts.setdefault(acct, {"account": acct, "contact_count": 0, "contacts": []})
        g["contact_count"] += 1
        g["contacts"].append({
            "contact_id":    r["contact_id"],
            "full_name":     r["full_name"],
            "email":         r["email"],
            "current_title": r["current_title"],
            "contact_stage": r["contact_stage"],
            "linkedin_url":  r["linkedin_url"],
        })
    out = sorted(accounts.values(), key=lambda a: (-a["contact_count"], a["account"]))
    return {"success": True, "data": out}


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
    """All contacts in the jobs pipeline (is_jobs_contact=true or linked to a deal)."""
    filters = ["""(
        c.is_jobs_contact = true
        OR EXISTS (
            SELECT 1 FROM bedrock.jobs_opportunity jo
            WHERE jo.deleted_at IS NULL
              AND (
                (c.airtable_id IS NOT NULL AND ('airtable:' || c.airtable_id) = ANY(jo.sf_contact_ids))
                OR ('pub:' || c.contact_id::text) = ANY(jo.sf_contact_ids)
              )
        )
    )"""]
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
        -- direct link via sf_contact_ids (airtable: or pub: ref)
        LEFT JOIN bedrock.jobs_opportunity jo
            ON jo.deleted_at IS NULL
            AND (
                (c.airtable_id IS NOT NULL AND ('airtable:' || c.airtable_id) = ANY(jo.sf_contact_ids))
                OR ('pub:' || c.contact_id::text) = ANY(jo.sf_contact_ids)
            )
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


CONTACT_SELECT = """
    SELECT contact_id, first_name, last_name, full_name, email,
           current_title, current_company, contact_stage, linkedin_url, notes, source, airtable_id
"""

async def _resolve_contacts(conn, sf_contact_ids: list[str]) -> list[dict]:
    """Resolve contact refs to public.contacts records.

    Supported ref formats:
      airtable:{airtable_id}  — from Airtable employer contacts
      pub:{contact_id}        — any public.contacts row by PK
      {sf_contact_id}         — 15/18-char SF contact ID via sf_contact_link
    """
    if not sf_contact_ids:
        return []

    airtable_ids = [r.replace("airtable:", "") for r in sf_contact_ids if r.startswith("airtable:")]
    pub_ids      = [int(r.replace("pub:", "")) for r in sf_contact_ids if r.startswith("pub:")]
    sf_ids       = [r for r in sf_contact_ids if not r.startswith("airtable:") and not r.startswith("pub:")]

    contacts = []
    if airtable_ids:
        rows = await conn.fetch(
            CONTACT_SELECT + "FROM public.contacts WHERE airtable_id = ANY($1::text[])",
            airtable_ids,
        )
        contacts.extend([dict(r) for r in rows])
    if pub_ids:
        rows = await conn.fetch(
            CONTACT_SELECT + "FROM public.contacts WHERE contact_id = ANY($1::int[])",
            pub_ids,
        )
        contacts.extend([dict(r) for r in rows])
    if sf_ids:
        rows = await conn.fetch(
            CONTACT_SELECT + """FROM public.contacts c
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
    if body.likelihood and body.likelihood not in VALID_LIKELIHOODS:
        raise HTTPException(400, f"Invalid likelihood: {body.likelihood}")

    user_email = user.get("email") if isinstance(user, dict) else getattr(user, "email", None)

    async with conn.transaction():
        row_id = await conn.fetchval(
            """
            INSERT INTO bedrock.jobs_opportunity (
                account_id, account_name, stage, deal_type,
                title, description, salary_expected, num_roles, likelihood,
                source, owner_email, sf_contact_ids, builder_ids, follow_up_date
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            RETURNING id
            """,
            body.account_id, body.account_name, body.stage, body.deal_type,
            body.title, body.description, body.salary_expected, body.num_roles, body.likelihood,
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
    if body.likelihood and body.likelihood not in VALID_LIKELIHOODS:
        raise HTTPException(400, f"Invalid likelihood: {body.likelihood}")

    user_email = user.get("email") if isinstance(user, dict) else getattr(user, "email", None)
    stage_changed = body.stage and body.stage != existing["stage"]

    sets = []
    params: list = []
    i = 1

    for field in ("stage", "deal_type", "title", "description", "salary_expected",
                  "num_roles", "likelihood",
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
    search: Optional[str] = Query(None, min_length=1),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Search all platform builders via SECURITY DEFINER function (bypasses RLS)."""
    rows = await conn.fetch(
        "SELECT user_id, full_name, email, cohort FROM bedrock.search_builders($1)",
        search or "",
    )
    return {
        "success": True,
        "data": [
            {
                "user_id": r["user_id"],
                "email":   r["email"] or "",
                "name":    r["full_name"] or r["email"] or "",
                "cohort":  r["cohort"] or "",
            }
            for r in rows
            if r["email"]
        ],
    }


@router.post("/contacts/{contact_id}/add-to-jobs")
async def add_contact_to_jobs(
    contact_id: int,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Flag any contact (SF, LinkedIn, manual) as a jobs pipeline contact."""
    result = await conn.execute(
        "UPDATE public.contacts SET is_jobs_contact=true, updated_at=now() WHERE contact_id=$1",
        contact_id,
    )
    if result == "UPDATE 0":
        raise HTTPException(404, "Contact not found")
    return {"success": True, "data": {"contact_id": contact_id, "is_jobs_contact": True}}


@router.delete("/contacts/{contact_id}/add-to-jobs")
async def remove_contact_from_jobs(
    contact_id: int,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Remove a contact from the jobs pipeline (unflag)."""
    await conn.execute(
        "UPDATE public.contacts SET is_jobs_contact=false, updated_at=now() WHERE contact_id=$1",
        contact_id,
    )
    return {"success": True, "data": {"contact_id": contact_id, "is_jobs_contact": False}}


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
    jobs_opportunity_id: Optional[str] = None
    contact_id:          Optional[int] = None   # log against a prospect instead of a deal
    type:                str                     # call | text | linkedin
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
    if body.type not in ("call", "text", "linkedin"):
        raise HTTPException(400, f"Invalid type: {body.type}")
    if not body.jobs_opportunity_id and not body.contact_id:
        raise HTTPException(400, "Provide jobs_opportunity_id or contact_id")

    import uuid as _uuid

    if body.jobs_opportunity_id:
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
    else:
        # Prospect-scoped log: tie to the public.contacts row, leave the deal null.
        row_id = await conn.fetchval(
            """
            INSERT INTO bedrock.activity
                (type, subject, description, activity_date, source,
                 participant_public_contact_id, logged_by)
            VALUES ($1, $2, $3, COALESCE($4, now()), 'manual', $5, $6)
            RETURNING id
            """,
            body.type,
            body.subject or f"{body.type.capitalize()} — {user_email}",
            body.description,
            body.activity_date,
            body.contact_id,
            user_email,
        )

    row = await conn.fetchrow("SELECT * FROM bedrock.activity WHERE id=$1", row_id)
    return {"success": True, "data": dict(row)}


# ============================================================================
# Builders tab — per-builder job-search view (L3 population)
# ============================================================================
# Reads identity/apps/placements/intake/learning from platform+bedrock sources;
# the editable coach/readiness/competency overlay lives in
# bedrock.builder_job_profile. Status is auto-derived with a manual override.

BUILDER_STATUSES = {"not_started", "actively_applying", "interviewing", "placed", "paused"}
_READY_KEYS = ("ready_lookbook", "ready_linkedin", "ready_github", "ready_cv", "ready_mock")


def _derive_builder_status(placed: bool, interviewing: bool, applying: bool) -> str:
    if placed:
        return "placed"
    if interviewing:
        return "interviewing"
    if applying:
        return "actively_applying"
    return "not_started"


def _is_placed(payment_amount, engagement_stage) -> bool:
    # "Placed" = a PAID placement, consistent with the placements / North-Star
    # definition. Unpaid active/completed freelance projects don't count — those
    # builders are still job-searching.
    return (payment_amount or 0) > 0


@router.get("/builders/board")
async def builders_board(user=Depends(require_auth), conn=Depends(get_db)):
    """One row per L3 builder: derived status, counts, readiness, coach."""
    builders = await conn.fetch("SELECT * FROM bedrock.l3_builders() ORDER BY full_name")

    apps = await conn.fetch("""
        SELECT builder_id,
               count(*)                                                    AS total,
               count(*) FILTER (WHERE stage = 'interview')                 AS interviews,
               bool_or(date_applied >= CURRENT_DATE - INTERVAL '60 days')  AS recent
        FROM public.job_applications
        WHERE source_type = 'Pursuit_referred'
        GROUP BY builder_id
    """)
    apps_by = {r["builder_id"]: r for r in apps}

    plc_by: dict = {}
    for r in await conn.fetch("SELECT user_id, payment_amount, engagement_stage, opportunity_id FROM bedrock.secured_jobs()"):
        b = plc_by.setdefault(r["user_id"], {"count": 0, "placed": False, "deals": set()})
        b["count"] += 1
        if _is_placed(r["payment_amount"], r["engagement_stage"]):
            b["placed"] = True
        if r["opportunity_id"]:
            b["deals"].add(r["opportunity_id"])

    enrolled = {r["builder_id"] for r in await conn.fetch("SELECT DISTINCT builder_id FROM public.job_strategy_enrollments")}
    profs = {r["user_id"]: r for r in await conn.fetch("SELECT * FROM bedrock.builder_job_profile")}

    out = []
    status_counts = {s: 0 for s in BUILDER_STATUSES}
    for b in builders:
        uid = b["user_id"]
        a, p, prof = apps_by.get(uid), plc_by.get(uid), profs.get(uid)
        interviews = a["interviews"] if a else 0
        placed = bool(p and p["placed"])
        applying = (uid in enrolled) or bool(a and a["recent"])
        derived = _derive_builder_status(placed, interviews > 0, applying)
        overridden = bool(prof and prof["status_overridden"])
        status = prof["job_search_status"] if (overridden and prof and prof["job_search_status"]) else derived
        status_counts[status] = status_counts.get(status, 0) + 1
        ready = {k: bool(prof[k]) if prof else False for k in _READY_KEYS}
        out.append({
            "user_id": uid, "name": b["full_name"], "email": b["email"],
            "cohort": b["cohort"], "cohort_completed": b["cohort_completed"],
            "status": status, "status_overridden": overridden,
            "coach": prof["pursuit_coach"] if prof else None,
            "counts": {
                "applications": (a["total"] if a else 0),
                "interviews": interviews,
                "placements": (p["count"] if p else 0),
                "deal_matches": (len(p["deals"]) if p else 0),
            },
            "readiness": {"complete": sum(ready.values()), "total": len(_READY_KEYS),
                          **{k.replace("ready_", ""): v for k, v in ready.items()}},
            "prof_strength": prof["prof_strength"] if prof else None,
            "technical_strength": prof["technical_strength"] if prof else None,
            "has_profile": prof is not None,
        })
    return {"success": True, "data": {"builders": out, "status_counts": status_counts}}


def _jsonb(v):
    import json as _json
    if v is None:
        return None
    return _json.loads(v) if isinstance(v, str) else v


@router.get("/builders/{user_id}")
async def builder_detail(user_id: int, user=Depends(require_auth), conn=Depends(get_db)):
    """Full per-builder detail: identity + apps/interviews/placements/deals +
    platform intake + learning model + editable job profile + derived status."""
    ident = await conn.fetchrow("SELECT * FROM bedrock.l3_builders() WHERE user_id = $1", user_id)
    if not ident:
        raise HTTPException(404, "Builder not found in the L3 population")

    apps = await conn.fetch("""
        SELECT job_application_id AS id, company_name, role_title, stage,
               date_applied, salary, job_url, response_date
        FROM public.job_applications
        WHERE builder_id = $1 AND source_type = 'Pursuit_referred'
        ORDER BY date_applied DESC NULLS LAST
    """, user_id)
    placements = await conn.fetch("""
        SELECT id, role_title, company_name, employment_type, payment_amount,
               engagement_stage, influenced, opportunity_id, start_date
        FROM bedrock.secured_jobs() WHERE user_id = $1
        ORDER BY (payment_amount > 0) DESC NULLS LAST, payment_amount DESC NULLS LAST
    """, user_id)
    deal_ids = [r["opportunity_id"] for r in placements if r["opportunity_id"]]
    deals = []
    if deal_ids:
        deals = await conn.fetch("""
            SELECT id, account_name, stage, deal_type, owner_email
            FROM bedrock.jobs_opportunity WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
        """, deal_ids)

    quiz = await conn.fetch("""
        SELECT question_key, response_text, response_structured
        FROM public.job_strategy_quiz_responses WHERE builder_id = $1
    """, user_id)
    enrollment = await conn.fetchrow("""
        SELECT current_profile, onboarding_completed_at, has_coach
        FROM public.job_strategy_enrollments WHERE builder_id = $1
        ORDER BY updated_at DESC NULLS LAST LIMIT 1
    """, user_id)
    learning = await conn.fetchrow("""
        SELECT skill_levels, competencies, interview_readiness
        FROM public.builder_profiles WHERE user_id = $1
    """, user_id)
    prof = await conn.fetchrow("SELECT * FROM bedrock.builder_job_profile WHERE user_id = $1", user_id)

    placed = any(_is_placed(r["payment_amount"], r["engagement_stage"]) for r in placements)
    interviewing = any(r["stage"] == "interview" for r in apps)
    recent = any(r["date_applied"] and (datetime.now().date() - r["date_applied"]).days <= 60 for r in apps)
    applying = enrollment is not None or recent
    derived = _derive_builder_status(placed, interviewing, applying)
    overridden = bool(prof and prof["status_overridden"])
    status = prof["job_search_status"] if (overridden and prof and prof["job_search_status"]) else derived

    profile = None
    if prof:
        profile = dict(prof)
        profile["intake"] = _jsonb(profile.get("intake"))

    return {"success": True, "data": {
        "identity": {
            "user_id": ident["user_id"], "name": ident["full_name"], "email": ident["email"],
            "cohort": ident["cohort"], "cohort_completed": ident["cohort_completed"],
            "linkedin_url": ident["linkedin_url"], "github_url": ident["github_url"],
        },
        "status": status, "status_overridden": overridden, "derived_status": derived,
        "applications": [dict(r) for r in apps],
        "placements": [dict(r) for r in placements],
        "deal_matches": [dict(r) for r in deals],
        "intake_quiz": [{"question_key": r["question_key"], "response_text": r["response_text"],
                         "response_structured": _jsonb(r["response_structured"])} for r in quiz],
        "enrollment": dict(enrollment) if enrollment else None,
        "learning": ({"skill_levels": _jsonb(learning["skill_levels"]),
                      "competencies": _jsonb(learning["competencies"]),
                      "interview_readiness": learning["interview_readiness"]} if learning else None),
        "profile": profile,
    }}


class BuilderProfileUpdate(BaseModel):
    job_search_status:      Optional[str] = None
    status_overridden:      Optional[bool] = None
    pursuit_coach:          Optional[str] = None
    gen_notes:              Optional[str] = None
    coach_notes:            Optional[str] = None
    coach_flags:            Optional[list[str]] = None
    improvement_tags:       Optional[list[str]] = None
    ready_lookbook:         Optional[bool] = None
    ready_linkedin:         Optional[bool] = None
    ready_github:           Optional[bool] = None
    ready_cv:               Optional[bool] = None
    ready_mock:             Optional[bool] = None
    technical_capability:   Optional[str] = None
    ai_reasoning:           Optional[str] = None
    problem_solving:        Optional[str] = None
    presentation:           Optional[str] = None
    professional_behaviors: Optional[str] = None
    prof_strength:          Optional[str] = None
    technical_strength:     Optional[str] = None
    target_industries:      Optional[list[str]] = None
    preferred_modes:        Optional[list[str]] = None
    certifications:         Optional[list[str]] = None
    resume_url:             Optional[str] = None
    lookbook_url:           Optional[str] = None
    university:             Optional[str] = None
    degree:                 Optional[str] = None
    graduation_year:        Optional[int] = None
    languages:              Optional[list[str]] = None
    applying_regularly:     Optional[bool] = None
    networking_regularly:   Optional[bool] = None
    intake:                 Optional[dict] = None


@router.patch("/builders/{user_id}")
async def update_builder_profile(user_id: int, body: BuilderProfileUpdate,
                                 user=Depends(require_auth), conn=Depends(get_db)):
    """Upsert the builder's job-profile overlay. Setting job_search_status flips
    status_overridden on; pass status_overridden=false to revert to derived.
    intake is merged (||) rather than replaced."""
    fields = body.dict(exclude_unset=True)
    if "job_search_status" in fields and "status_overridden" not in fields:
        fields["status_overridden"] = True
    if not fields:
        raise HTTPException(400, "No fields to update")

    import json as _json
    cols, vals = ["user_id"], [user_id]
    for k, v in fields.items():
        cols.append(k)
        vals.append(_json.dumps(v) if k == "intake" else v)
    ph = [f"${i+1}" for i in range(len(cols))]
    sets = []
    for k in cols[1:]:
        if k == "intake":
            sets.append("intake = bedrock.builder_job_profile.intake || EXCLUDED.intake")
        else:
            sets.append(f"{k} = EXCLUDED.{k}")
    sets.append("updated_at = now()")
    sql = (f"INSERT INTO bedrock.builder_job_profile ({', '.join(cols)}) "
           f"VALUES ({', '.join(ph)}) "
           f"ON CONFLICT (user_id) DO UPDATE SET {', '.join(sets)} RETURNING *")
    row = await conn.fetchrow(sql, *vals)
    d = dict(row)
    d["intake"] = _jsonb(d.get("intake"))
    return {"success": True, "data": d}
