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

def _jobs_activity_flag(alias: str = "a") -> str:
    """SQL boolean: is this activity row 'jobs activity'? True when it's tied to
    a jobs opportunity, is a manual jobs channel (call/text/linkedin), OR is an
    email/meeting in a jobs-team mailbox (Avni/Damon) — so their synced email
    lands in the Jobs section, not the generic comms bucket."""
    team = " OR ".join(
        f"{alias}.email_from ILIKE '%{e}%' OR {alias}.logged_by ILIKE '%{e}%'"
        for e in JOBS_TEAM_EMAILS
    )
    return (
        f"({alias}.jobs_opportunity_id IS NOT NULL "
        f"OR {alias}.type IN ('call','text','linkedin') "
        f"OR {team})"
    )


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
    relationship_owner: Optional[str] = None
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
    relationship_owner: Optional[str] = None
    sf_contact_ids: Optional[list[str]] = None
    builder_ids: Optional[list[str]] = None
    follow_up_date: Optional[datetime] = None
    touch_count: Optional[int] = None
    sf_opportunity_id: Optional[str] = None
    note: Optional[str] = None  # optional note when changing stage
    # Call-feedback round
    closed_lost_reason: Optional[str] = None
    closed_lost_note: Optional[str] = None
    priority: Optional[int] = None
    segment: Optional[str] = None
    intro_by: Optional[str] = None


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

    async def placements(where: str):
        # Drill for the "FT Roles Secured" headline = the exact two things it
        # counts: (1) FT-PLACED builders (full_time employment_records) and
        # (2) COMMITTED FT roles still open. Deliberately excludes PT/contract
        # placements and open-market roles so the drill totals match the card.
        rows = await conn.fetch(
            "SELECT * FROM bedrock.secured_jobs() "
            f"WHERE payment_amount > 0 AND employment_type = 'full_time' AND {where} ORDER BY builder"
        )
        groups: dict = {}
        for r in rows:
            uid = r["user_id"]
            g = groups.setdefault(uid, {"builder": r["builder"], "children": []})
            g["children"].append({
                "role_title": r["role_title"] or "—",
                "company_name": r["company_name"] or "—",
                "salary": f"${int(r['payment_amount']):,}" if r["payment_amount"] else "—",
                "influence": ("Influenced" if r["influenced"] is True
                              else "Self-sourced" if r["influenced"] is False else "Unclassified"),
                "source": r["source"],
            })
        out = []
        for g in sorted(groups.values(), key=lambda x: (x["builder"] or "")):
            out.append({
                "name": g["builder"],
                "status": "FT placed",
                "detail": f"{len(g['children'])} FT placement" + ("s" if len(g["children"]) != 1 else ""),
                "_children": g["children"],
            })
        # (2) committed FT roles still open — same filter as the headline count.
        committed = await conn.fetch("""
            SELECT o.account_name, r.title
            FROM bedrock.jobs_role r
            JOIN bedrock.jobs_opportunity o ON o.id = r.opportunity_id
            WHERE r.status = 'open' AND o.deleted_at IS NULL
              AND r.commitment = 'committed' AND r.is_trial = false
              AND (r.employment_type = 'full_time' OR (r.employment_type IS NULL AND o.deal_type = 'ft'))
            ORDER BY o.account_name
        """)
        for cr in committed:
            out.append({
                "name": cr["account_name"] or "—",
                "status": "Committed (open req)",
                "detail": cr["title"] or "FT role",
                "_children": [],
            })
        cols = [
            {"key": "name", "label": "Builder / Company"},
            {"key": "status", "label": "Status"},
            {"key": "detail", "label": "Detail"},
        ]
        child_cols = [
            {"key": "company_name", "label": "Company"},
            {"key": "role_title", "label": "Role"},
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
        "placements":           ("FT Roles Secured", lambda: placements("true")),
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

    # Committed FT roles still OPEN (unfilled reqs) on full-time opportunities —
    # demand the team has locked in but not yet placed a builder into. Excludes
    # open-market roles (CVs welcome but no hiring commitment) and trials (those
    # convert into a separate FT role; the FT role is what counts as committed).
    committed_ft_roles = await conn.fetchval("""
        SELECT count(*) FROM bedrock.jobs_role r
        JOIN bedrock.jobs_opportunity o ON o.id = r.opportunity_id
        WHERE r.status = 'open' AND o.deleted_at IS NULL
          AND r.commitment = 'committed' AND r.is_trial = false
          AND (r.employment_type = 'full_time' OR (r.employment_type IS NULL AND o.deal_type = 'ft'))
    """) or 0

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
            "committed_ft_roles": committed_ft_roles,
            "ft_roles_secured": ft_builders + committed_ft_roles,
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


VALID_COMMITMENTS = {"committed", "open_market"}
VALID_RATE_PERIODS = {"annual", "monthly", "weekly", "daily", "hourly"}


def _role_dict(r) -> dict:
    """Serialize a bedrock.jobs_role row for the API."""
    d = dict(r)
    d["id"] = str(d["id"])
    if d.get("opportunity_id") is not None:
        d["opportunity_id"] = str(d["opportunity_id"])
    if d.get("converts_to_role_id") is not None:
        d["converts_to_role_id"] = str(d["converts_to_role_id"])
    if d.get("pay_rate") is not None:
        d["pay_rate"] = float(d["pay_rate"])
    for k in ("start_date", "end_date", "created_at", "updated_at"):
        v = d.get(k)
        if v is not None and hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


class RoleCreate(BaseModel):
    title:               str
    approx_salary:       Optional[int] = None
    employment_type:     Optional[str] = None
    start_date:          Optional[date] = None
    notes:               Optional[str] = None
    commitment:          Optional[str] = None          # committed | open_market (default committed)
    is_trial:            Optional[bool] = None
    converts_to_role_id: Optional[str] = None
    pay_rate:            Optional[float] = None
    rate_period:         Optional[str] = None           # annual | monthly | weekly | daily | hourly
    end_date:            Optional[date] = None
    pay_cadence:         Optional[str] = None
    benefits:            Optional[str] = None
    payment_schedule:    Optional[str] = None
    negotiation_notes:   Optional[str] = None
    jd_url:              Optional[str] = None


class RoleUpdate(BaseModel):
    title:               Optional[str] = None
    approx_salary:       Optional[int] = None
    employment_type:     Optional[str] = None
    start_date:          Optional[date] = None
    status:              Optional[str] = None
    notes:               Optional[str] = None
    commitment:          Optional[str] = None
    is_trial:            Optional[bool] = None
    converts_to_role_id: Optional[str] = None
    pay_rate:            Optional[float] = None
    rate_period:         Optional[str] = None
    end_date:            Optional[date] = None
    pay_cadence:         Optional[str] = None
    benefits:            Optional[str] = None
    payment_schedule:    Optional[str] = None
    negotiation_notes:   Optional[str] = None
    jd_url:              Optional[str] = None


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
    if body.commitment is not None and body.commitment not in VALID_COMMITMENTS:
        raise HTTPException(400, f"Invalid commitment: {body.commitment}")
    if body.rate_period is not None and body.rate_period not in VALID_RATE_PERIODS:
        raise HTTPException(400, f"Invalid rate_period: {body.rate_period}")
    opp = await conn.fetchrow(
        "SELECT id FROM bedrock.jobs_opportunity WHERE id=$1 AND deleted_at IS NULL",
        opp_id,
    )
    if not opp:
        raise HTTPException(404, "Opportunity not found")

    converts_to = UUID(body.converts_to_role_id) if body.converts_to_role_id else None
    row = await conn.fetchrow(
        """
        INSERT INTO bedrock.jobs_role
            (opportunity_id, title, approx_salary, employment_type, start_date, status, notes,
             commitment, is_trial, converts_to_role_id, pay_rate, rate_period, end_date,
             pay_cadence, benefits, payment_schedule, negotiation_notes, jd_url)
        VALUES ($1,$2,$3,$4,$5,'open',$6,
                COALESCE($7,'committed'), COALESCE($8,false), $9,$10,$11,$12,
                $13,$14,$15,$16,$17)
        RETURNING *
        """,
        opp_id, body.title, body.approx_salary, body.employment_type,
        body.start_date, body.notes,
        body.commitment, body.is_trial, converts_to, body.pay_rate, body.rate_period, body.end_date,
        body.pay_cadence, body.benefits, body.payment_schedule, body.negotiation_notes, body.jd_url,
    )
    return {"success": True, "data": _role_dict(row)}


@router.patch("/roles/{role_id}")
async def update_role(
    role_id: UUID,
    body: RoleUpdate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Update role core fields, commitment/trial/conversion, and compensation."""
    if body.status is not None and body.status not in VALID_ROLE_STATUSES:
        raise HTTPException(400, f"Invalid status: {body.status}")
    if body.commitment is not None and body.commitment not in VALID_COMMITMENTS:
        raise HTTPException(400, f"Invalid commitment: {body.commitment}")
    if body.rate_period is not None and body.rate_period not in VALID_RATE_PERIODS:
        raise HTTPException(400, f"Invalid rate_period: {body.rate_period}")

    existing = await conn.fetchrow("SELECT * FROM bedrock.jobs_role WHERE id=$1", role_id)
    if not existing:
        raise HTTPException(404, "Role not found")

    sets, params = [], []
    i = 1
    for field in (
        "title", "approx_salary", "employment_type", "start_date", "status", "notes",
        "commitment", "is_trial", "pay_rate", "rate_period", "end_date",
        "pay_cadence", "benefits", "payment_schedule", "negotiation_notes", "jd_url",
    ):
        val = getattr(body, field, None)
        if val is not None:
            sets.append(f"{field} = ${i}"); params.append(val); i += 1
    # converts_to_role_id is a uuid column — cast the incoming string.
    if body.converts_to_role_id is not None:
        sets.append(f"converts_to_role_id = ${i}")
        params.append(UUID(body.converts_to_role_id)); i += 1

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


# public.job_applications.stage vocabulary (builder-side submission funnel).
VALID_APP_STAGES = {"applied", "interview", "accepted", "rejected", "withdrawn"}


class BuilderActivityCreate(BaseModel):
    user_id:       int                       # builder user_id (from the builder picker)
    builder_name:  Optional[str] = None      # stored in notes prefix for display
    role_title:    Optional[str] = None
    stage:         str = "applied"
    jobs_role_id:  Optional[str] = None
    date_applied:  Optional[date] = None


class BuilderActivityUpdate(BaseModel):
    stage: str


@router.post("/opportunities/{opp_id}/builder-activity")
async def create_builder_activity(
    opp_id: UUID,
    body: BuilderActivityCreate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Log a builder application / interview against this opportunity.

    Writes to public.job_applications (the builder submission funnel) tagged with
    jobs_opportunity_id so it surfaces in the Builders tab and the funnel. The
    builder's display name is stored in the notes prefix because the read path
    derives it via split_part(notes, ':', 1).
    """
    if body.stage not in VALID_APP_STAGES:
        raise HTTPException(400, f"Invalid stage: {body.stage}")
    opp = await conn.fetchrow(
        "SELECT account_name FROM bedrock.jobs_opportunity WHERE id=$1 AND deleted_at IS NULL",
        opp_id,
    )
    if not opp:
        raise HTTPException(404, "Opportunity not found")

    role_id = UUID(body.jobs_role_id) if body.jobs_role_id else None
    notes = f"{body.builder_name}: logged via Opportunities" if body.builder_name else None
    app_id = await conn.fetchval(
        """
        INSERT INTO public.job_applications
            (builder_id, company_name, role_title, stage, date_applied,
             source_type, jobs_opportunity_id, jobs_role_id, notes)
        VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE),
                'Pursuit_referred', $6, $7, $8)
        RETURNING job_application_id
        """,
        body.user_id,
        opp["account_name"],
        body.role_title or "Role",
        body.stage,
        body.date_applied,
        opp_id,
        role_id,
        notes,
    )
    return {"success": True, "data": {"job_application_id": app_id, "stage": body.stage}}


@router.patch("/builder-activity/{app_id}")
async def update_builder_activity(
    app_id: int,
    body: BuilderActivityUpdate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Update an application's stage inline (applied → interview → accepted, …)."""
    if body.stage not in VALID_APP_STAGES:
        raise HTTPException(400, f"Invalid stage: {body.stage}")
    result = await conn.execute(
        """
        UPDATE public.job_applications
        SET stage=$1, updated_at=now()
        WHERE job_application_id=$2 AND jobs_opportunity_id IS NOT NULL
        """,
        body.stage, app_id,
    )
    if result == "UPDATE 0":
        raise HTTPException(404, "Application not found")
    return {"success": True, "data": {"job_application_id": app_id, "stage": body.stage}}


@router.get("/funnel/{ftype}")
async def get_funnel(
    ftype: str,
    deal_type: Optional[str] = Query(None),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Unified funnel for the three pipelines: opportunities | prospects | builders.

    Returns ordered stages with counts, conversion-to-next, and the records in
    each stage (for inline expand). Opportunities also include recent
    progression (advanced/regressed) from bedrock.jobs_stage_history.

    `deal_type` (ft | pt_contract | ...) scopes every funnel to that lens:
    opportunities by their own deal_type; prospects to contacts at companies
    that have a deal of that type; builders to applications on such opps.
    """
    dt = deal_type if deal_type and deal_type != "all" else None
    movement_by_stage: dict = {}  # stage_key -> list of recent transitions touching it

    if ftype == "opportunities":
        # Lead Submitted + Initial Outreach happen at the prospect level — the
        # opportunities funnel starts once a deal is active (In Discussions).
        stage_order = [
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
            WHERE deleted_at IS NULL AND ($1::text IS NULL OR deal_type = $1)
            ORDER BY account_name
        """, dt)
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
              AND ($1::text IS NULL OR o.deal_type = $1)
            ORDER BY h.changed_at DESC LIMIT 100
        """, dt)
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
            FROM public.contacts
            WHERE is_jobs_contact=true
              AND ($1::text IS NULL OR lower(current_company) IN (
                    SELECT lower(account_name) FROM bedrock.jobs_opportunity
                    WHERE deleted_at IS NULL AND deal_type = $1 AND account_name IS NOT NULL))
            ORDER BY full_name
        """, dt)
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
            SELECT ja.stage, trim(split_part(ja.notes,':',1)) AS name,
                   ja.company_name AS company, ja.role_title AS role
            FROM public.job_applications ja
            WHERE ja.source_type='Pursuit_referred'
              AND ($1::text IS NULL OR EXISTS (
                    SELECT 1 FROM bedrock.jobs_opportunity o
                    WHERE o.id = ja.jobs_opportunity_id AND o.deal_type = $1))
            ORDER BY ja.company_name
        """, dt)
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


@router.get("/this-week-summary")
async def this_week_summary(user=Depends(require_auth), conn=Depends(get_db)):
    """A narrative of the jobs team's last 7 days: who Avni/Damon emailed &
    met (first touches this week), and which opportunities progressed."""
    emailed = await conn.fetch(f"""
        {_first_touch_email_cte()}
        SELECT ext.counterpart AS email, ext.first_touch,
               p.full_name, p.current_company
        FROM ext
        LEFT JOIN LATERAL (
            SELECT full_name, current_company FROM public.contacts c
            WHERE lower(c.email) = ext.counterpart AND c.is_jobs_contact = true LIMIT 1
        ) p ON true
        WHERE ext.first_touch >= now() - interval '7 days'
        ORDER BY ext.first_touch DESC
    """)
    met = await conn.fetch(f"""
        {_first_touch_meeting_cte()}
        SELECT ext.counterpart AS email, ext.first_touch,
               p.full_name, p.current_company
        FROM ext
        LEFT JOIN LATERAL (
            SELECT full_name, current_company FROM public.contacts c
            WHERE lower(c.email) = ext.counterpart AND c.is_jobs_contact = true LIMIT 1
        ) p ON true
        WHERE ext.first_touch >= now() - interval '7 days'
        ORDER BY ext.first_touch DESC
    """)
    progressed = await conn.fetch("""
        SELECT o.account_name, h.from_stage, h.to_stage, h.changed_at
        FROM bedrock.jobs_stage_history h
        JOIN bedrock.jobs_opportunity o ON o.id = h.opportunity_id
        WHERE h.changed_at >= now() - interval '7 days' AND o.deleted_at IS NULL
          AND h.from_stage IS NOT NULL
        ORDER BY h.changed_at DESC
    """)

    def _person(r):
        return {"email": r["email"], "name": r["full_name"],
                "company": r["current_company"], "when": r["first_touch"]}

    return {"success": True, "data": {
        "emailed":  [_person(r) for r in emailed],
        "met":      [_person(r) for r in met],
        "progressed": [{
            "account": r["account_name"],
            "from_stage": STAGE_LABELS.get(r["from_stage"], r["from_stage"]),
            "to_stage": STAGE_LABELS.get(r["to_stage"], r["to_stage"]),
            "when": r["changed_at"],
        } for r in progressed],
        "counts": {"emailed": len(emailed), "met": len(met), "progressed": len(progressed)},
    }}


class ContactCreate(BaseModel):
    full_name:       str
    email:           Optional[str] = None
    current_title:   Optional[str] = None
    current_company: Optional[str] = None
    contact_stage:   str = "lead"
    linkedin_url:    Optional[str] = None


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
             current_company, linkedin_url, source, airtable_id, contact_stage)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9)
        RETURNING contact_id
    """, first, last, body.full_name, body.email, body.current_title,
        body.current_company, body.linkedin_url, at_id, body.contact_stage)
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
    deal_type: Optional[str] = Query(None),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Jobs prospects grouped into account rows by company name.

    No hard account_id on contacts, so we group by the company text
    (COALESCE(NULLIF(trim(current_company),''),'(no company)')). Accounts are
    ordered by contact_count desc, then name.

    `deal_type` narrows to prospects at companies that have a deal of that type.
    """
    dt = deal_type if deal_type and deal_type != "all" else None
    rows = await conn.fetch(
        """
        SELECT
            COALESCE(NULLIF(trim(current_company), ''), '(no company)') AS account,
            contact_id, full_name, email, current_title, contact_stage, linkedin_url
        FROM public.contacts
        WHERE is_jobs_contact = true
          AND ($1::text IS NULL OR lower(current_company) IN (
                SELECT lower(account_name) FROM bedrock.jobs_opportunity
                WHERE deleted_at IS NULL AND deal_type = $1 AND account_name IS NOT NULL))
        ORDER BY account, full_name
        """,
        dt,
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

    # Attach each account's current opportunity (matched by company name). When a
    # company has more than one deal, prefer an active one, then won, on-hold, lost,
    # and break ties by most-recently-updated — so the account row shows the deal
    # the team is actually working.
    deal_rows = await conn.fetch(
        """
        SELECT DISTINCT ON (lower(account_name))
            account_name, id, stage, deal_type, owner_email
        FROM bedrock.jobs_opportunity
        WHERE deleted_at IS NULL AND account_name IS NOT NULL
        ORDER BY lower(account_name),
            CASE
                WHEN stage LIKE 'active%'  THEN 0
                WHEN stage = 'closed_won'  THEN 1
                WHEN stage LIKE 'on_hold%' THEN 2
                WHEN stage = 'closed_lost' THEN 3
                ELSE 4
            END,
            updated_at DESC NULLS LAST
        """,
    )
    deal_by_company = {r["account_name"].strip().lower(): r for r in deal_rows}
    for acct, g in accounts.items():
        d = deal_by_company.get(acct.strip().lower())
        g["deal"] = (
            {
                "id":          str(d["id"]),
                "stage":       d["stage"],
                "deal_type":   d["deal_type"],
                "owner_email": d["owner_email"],
            }
            if d
            else None
        )

    out = sorted(accounts.values(), key=lambda a: (-a["contact_count"], a["account"]))
    return {"success": True, "data": out}


# Account status vocabulary mirrors the portfolio Accounts tab so the two read
# the same. Status is DERIVED from the account's jobs data (not stored):
#   Stewarding   – a won deal (delivery / placed relationship)
#   Pursuing     – an active open opportunity
#   Re-activating– only stale opps (on-hold/lost) but touched in the last 90 days
#   Dormant      – only stale opps, no recent touch
#   Prospect     – prospects only, no opportunity yet
_ACCOUNT_STATUS_RANK = {"Pursuing": 0, "Stewarding": 1, "Re-activating": 2, "Prospect": 3, "Dormant": 4}


@router.get("/accounts")
async def jobs_accounts(
    deal_type: Optional[str] = Query(None),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Account-level hub: every company with an opportunity OR a jobs prospect,
    keyed by normalized company name, with its opportunities and prospects nested
    and a derived account status (same vocabulary as the portfolio Accounts tab).

    `account_name`/`current_company` is the canonical key — SF `account_id` is
    carried through when it's a real Account Id but is too sparse to group on.
    `deal_type` narrows to accounts that have an opportunity of that type.
    """
    opp_rows = await conn.fetch(
        """
        SELECT id, account_id, account_name, stage, deal_type, title,
               owner_email, priority, num_roles, likelihood, updated_at
        FROM bedrock.jobs_opportunity
        WHERE deleted_at IS NULL AND coalesce(trim(account_name), '') <> ''
        ORDER BY updated_at DESC NULLS LAST
        """,
    )
    prospect_rows = await conn.fetch(
        """
        SELECT contact_id, full_name, email, current_title, current_company,
               contact_stage, linkedin_url, updated_at
        FROM public.contacts
        WHERE is_jobs_contact = true AND coalesce(trim(current_company), '') <> ''
        ORDER BY full_name
        """,
    )

    accounts: dict = {}

    def bucket(key: str, display: str) -> dict:
        return accounts.setdefault(
            key,
            {
                "account": display,
                "account_id": None,
                "owner_email": None,
                "opportunities": [],
                "prospects": [],
                "_last": None,
            },
        )

    def touch(g: dict, ts) -> None:
        # contacts.updated_at is tz-naive while jobs_opportunity.updated_at is
        # tz-aware — normalize to UTC so they're comparable.
        if ts is None:
            return
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if g["_last"] is None or ts > g["_last"]:
            g["_last"] = ts

    for r in opp_rows:
        key = r["account_name"].strip().lower()
        g = bucket(key, r["account_name"].strip())
        if r["account_id"] and str(r["account_id"]).startswith("001"):
            g["account_id"] = r["account_id"]
        if not g["owner_email"] and r["owner_email"]:
            g["owner_email"] = r["owner_email"]
        touch(g, r["updated_at"])
        g["opportunities"].append({
            "id":         str(r["id"]),
            "title":      r["title"],
            "stage":      r["stage"],
            "deal_type":  r["deal_type"],
            "owner_email": r["owner_email"],
            "priority":   r["priority"],
            "num_roles":  r["num_roles"],
            "likelihood": r["likelihood"],
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        })

    for r in prospect_rows:
        key = r["current_company"].strip().lower()
        g = bucket(key, r["current_company"].strip())
        touch(g, r["updated_at"])
        g["prospects"].append({
            "contact_id":    r["contact_id"],
            "full_name":     r["full_name"],
            "email":         r["email"],
            "current_title": r["current_title"],
            "contact_stage": r["contact_stage"],
            "linkedin_url":  r["linkedin_url"],
        })

    # Persistent account record (owner, optional manual status override,
    # explicit Salesforce link).
    ja_rows = await conn.fetch(
        "SELECT account_key, owner_email, status_override, sf_account_id FROM bedrock.jobs_account",
    )
    ja = {r["account_key"]: r for r in ja_rows}

    dt = deal_type if deal_type and deal_type != "all" else None
    now = datetime.now(timezone.utc)
    out = []
    for key, g in accounts.items():
        opps = g["opportunities"]
        if dt and not any(o["deal_type"] == dt for o in opps):
            continue
        rec = ja.get(key)
        # A stored owner wins over the one derived from the opportunities.
        if rec and rec["owner_email"]:
            g["owner_email"] = rec["owner_email"]
        # An explicit SF link wins over the account_id derived from opps.
        if rec and rec["sf_account_id"]:
            g["account_id"] = rec["sf_account_id"]
        stages = {o["stage"] for o in opps}
        # An opportunity is "open" while it's anywhere in the live funnel —
        # initial_outreach through builder interview (NOT closed/on-hold). These
        # accounts are being actively pursued. Re-activating/Dormant is only for
        # accounts whose opps are ALL closed-lost or on-hold.
        has_open = any(s and (s == "initial_outreach" or s.startswith("active")) for s in stages)
        has_won = "closed_won" in stages
        last = g.pop("_last")
        recent = bool(last and (now - last).days <= 90)
        if rec and rec["status_override"]:
            status = rec["status_override"]
        elif has_open:
            status = "Pursuing"
        elif has_won:
            status = "Stewarding"
        elif opps:
            status = "Re-activating" if recent else "Dormant"
        else:
            status = "Prospect"
        g["account_key"] = key
        g["account_status"] = status
        g["opp_count"] = len(opps)
        g["prospect_count"] = len(g["prospects"])
        g["last_activity"] = last.isoformat() if last else None
        out.append(g)

    out.sort(key=lambda a: (
        _ACCOUNT_STATUS_RANK.get(a["account_status"], 9),
        -(a["opp_count"] + a["prospect_count"]),
        a["account"].lower(),
    ))
    return {"success": True, "data": out}


_VALID_ACCOUNT_STATUS = {"Prospect", "Pursuing", "Stewarding", "Re-activating", "Dormant"}


class JobsAccountUpdate(BaseModel):
    account: str                              # the account display/company name
    owner_email: Optional[str] = None
    status_override: Optional[str] = None     # "" clears the override (back to derived)
    notes: Optional[str] = None


@router.patch("/accounts")
async def update_jobs_account(
    body: JobsAccountUpdate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Upsert the persistent account record (owner / manual status / notes).

    Keyed by the normalized company name so it lines up with GET /accounts.
    Only the provided fields are written; status_override="" clears it.
    """
    key = body.account.strip().lower()
    if not key:
        raise HTTPException(status_code=400, detail="account is required")
    if body.status_override and body.status_override not in _VALID_ACCOUNT_STATUS:
        raise HTTPException(status_code=400, detail=f"invalid status_override: {body.status_override}")

    # Fixed positional params; only the provided columns are touched on UPDATE
    # (EXCLUDED = the attempted-insert values), so a partial PATCH never nulls
    # the fields it didn't send. A new row inserts NULL for anything omitted.
    sets = ["display_name = EXCLUDED.display_name", "updated_at = now()"]
    if body.owner_email is not None:
        sets.append("owner_email = EXCLUDED.owner_email")
    if body.status_override is not None:
        sets.append("status_override = EXCLUDED.status_override")
    if body.notes is not None:
        sets.append("notes = EXCLUDED.notes")

    await conn.execute(
        f"""
        INSERT INTO bedrock.jobs_account (account_key, display_name, owner_email, status_override, notes)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (account_key) DO UPDATE SET {', '.join(sets)}
        """,
        key,
        body.account.strip(),
        body.owner_email or None,
        body.status_override or None,
        body.notes or None,
    )
    return {"success": True}


@router.get("/account-activity")
async def account_activity(
    key: str = Query(...),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """All engagement activity across an account's opportunities + contacts."""
    k = key.strip().lower()
    opps = await conn.fetch(
        "SELECT id, account_id FROM bedrock.jobs_opportunity WHERE deleted_at IS NULL AND lower(trim(account_name)) = $1",
        k,
    )
    opp_ids = [r["id"] for r in opps]
    account_ids = [r["account_id"] for r in opps if r["account_id"] and str(r["account_id"]).startswith("001")]
    contact_ids = [
        r["contact_id"] for r in await conn.fetch(
            "SELECT contact_id FROM public.contacts WHERE is_jobs_contact = true AND lower(trim(current_company)) = $1",
            k,
        )
    ]
    rows = await conn.fetch(
        """
        SELECT a.id, a.type, a.subject, a.description, a.activity_date, a.source, a.logged_by,
               a.synced_at, a.email_from, a.email_to, a.email_snippet,
               left(a.email_body_text, 2000) AS email_body_text,  -- cap body: the rollup of 250 rows was ~1.9MB
               a.meeting_duration_minutes,
               """ + _jobs_activity_flag("a") + """ AS is_jobs,
               a.deleted_at
        FROM bedrock.activity a
        WHERE a.deleted_at IS NULL AND (
            ($1::uuid[] <> '{}' AND a.jobs_opportunity_id = ANY($1::uuid[]))
            OR ($2::text[] <> '{}' AND a.account_id = ANY($2::text[]))
            OR ($3::int[] <> '{}' AND a.participant_public_contact_id = ANY($3::int[]))
        )
        ORDER BY a.activity_date DESC NULLS LAST
        LIMIT 250
        """,
        opp_ids, account_ids, contact_ids,
    )
    return {
        "success": True,
        "data": [
            {**dict(r), "activity_date": r["activity_date"].isoformat() if r["activity_date"] else None,
             "synced_at": r["synced_at"].isoformat() if r["synced_at"] else None,
             "id": str(r["id"]), "email_to": list(r["email_to"]) if r["email_to"] else None}
            for r in rows
        ],
    }


async def _account_opp_contact_ids(conn, key: str):
    """(opp rows [id,title], contact rows [contact_id,full_name]) for an account."""
    k = key.strip().lower()
    opps = await conn.fetch(
        "SELECT id, title FROM bedrock.jobs_opportunity WHERE deleted_at IS NULL AND lower(trim(account_name)) = $1",
        k,
    )
    contacts = await conn.fetch(
        "SELECT contact_id, full_name FROM public.contacts WHERE is_jobs_contact = true AND lower(trim(current_company)) = $1",
        k,
    )
    return opps, contacts


@router.get("/account-tasks")
async def account_tasks(key: str = Query(...), user=Depends(require_auth), conn=Depends(get_db)):
    """Tasks tagged to any of an account's opportunities or contacts, each
    annotated with what it's tagged to (scope + label)."""
    opps, contacts = await _account_opp_contact_ids(conn, key)
    opp_label = {str(o["id"]): (o["title"] or "Opportunity") for o in opps}
    contact_label = {str(c["contact_id"]): (c["full_name"] or "Contact") for c in contacts}
    rows = await conn.fetch(
        """
        SELECT id, parent_type, parent_id, title, status, deadline, created_at
        FROM bedrock.jobs_task
        WHERE deleted_at IS NULL AND (
            (parent_type = 'opportunity' AND parent_id = ANY($1::text[]))
            OR (parent_type = 'prospect' AND parent_id = ANY($2::text[]))
        )
        ORDER BY (status = 'done'), deadline ASC NULLS LAST, created_at DESC
        """,
        list(opp_label.keys()), list(contact_label.keys()),
    )
    out = []
    for r in rows:
        scope = "opportunity" if r["parent_type"] == "opportunity" else "contact"
        label = (opp_label if scope == "opportunity" else contact_label).get(r["parent_id"], "")
        out.append({
            "id": str(r["id"]), "title": r["title"], "status": r["status"],
            "deadline": r["deadline"].isoformat() if r["deadline"] else None,
            "scope": scope, "parent_id": r["parent_id"], "scope_label": label,
        })
    return {"success": True, "data": out}


@router.get("/account-comments")
async def account_comments(key: str = Query(...), user=Depends(require_auth), conn=Depends(get_db)):
    """Comments across an account's opportunities + contacts (read rollup)."""
    opps, contacts = await _account_opp_contact_ids(conn, key)
    opp_label = {str(o["id"]): (o["title"] or "Opportunity") for o in opps}
    contact_label = {str(c["contact_id"]): (c["full_name"] or "Contact") for c in contacts}
    rows = await conn.fetch(
        """
        SELECT id, parent_type, parent_id, author_email, content, created_at
        FROM bedrock.jobs_comment
        WHERE (parent_type = 'opportunity' AND parent_id = ANY($1::text[]))
           OR (parent_type = 'prospect' AND parent_id = ANY($2::text[]))
        ORDER BY created_at DESC
        """,
        list(opp_label.keys()), list(contact_label.keys()),
    )
    out = []
    for r in rows:
        scope = "opportunity" if r["parent_type"] == "opportunity" else "contact"
        label = (opp_label if scope == "opportunity" else contact_label).get(r["parent_id"], "")
        out.append({
            "id": str(r["id"]), "author_email": r["author_email"], "content": r["content"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "scope": scope, "scope_label": label,
        })
    return {"success": True, "data": out}


@router.get("/account-builders")
async def account_builders(key: str = Query(...), user=Depends(require_auth), conn=Depends(get_db)):
    """Builder applications across all of an account's opportunities."""
    k = key.strip().lower()
    rows = await conn.fetch(
        """
        SELECT ja.job_application_id, trim(split_part(ja.notes, ':', 1)) AS builder,
               ja.company_name, ja.role_title, ja.stage, ja.jobs_role_id, ja.date_applied,
               ja.jobs_opportunity_id, o.title AS opp_title
        FROM public.job_applications ja
        JOIN bedrock.jobs_opportunity o ON o.id = ja.jobs_opportunity_id
        WHERE o.deleted_at IS NULL AND lower(trim(o.account_name)) = $1
        ORDER BY ja.date_applied DESC NULLS LAST
        """,
        k,
    )
    summary = {"applied": 0, "interview": 0, "accepted": 0}
    out = []
    for r in rows:
        if r["stage"] in summary:
            summary[r["stage"]] += 1
        out.append({
            "job_application_id": r["job_application_id"], "builder": r["builder"],
            "company_name": r["company_name"], "role_title": r["role_title"], "stage": r["stage"],
            "jobs_role_id": str(r["jobs_role_id"]) if r["jobs_role_id"] else None,
            "date_applied": r["date_applied"].isoformat() if r["date_applied"] else None,
            "opportunity_id": str(r["jobs_opportunity_id"]) if r["jobs_opportunity_id"] else None,
            "opp_title": r["opp_title"],
        })
    return {"success": True, "data": {"rows": out, "summary": summary}}


@router.get("/account-roles")
async def account_roles(key: str = Query(...), user=Depends(require_auth), conn=Depends(get_db)):
    """Committed roles across all of an account's opportunities."""
    k = key.strip().lower()
    rows = await conn.fetch(
        """
        SELECT r.id, r.opportunity_id, r.title, r.status, r.employment_type,
               r.approx_salary, r.commitment, r.is_trial, r.filled_by_user_id, o.title AS opp_title
        FROM bedrock.jobs_role r
        JOIN bedrock.jobs_opportunity o ON o.id = r.opportunity_id
        WHERE o.deleted_at IS NULL AND lower(trim(o.account_name)) = $1
        ORDER BY r.created_at DESC
        """,
        k,
    )
    return {
        "success": True,
        "data": [
            {"id": str(r["id"]), "opportunity_id": str(r["opportunity_id"]), "opp_title": r["opp_title"],
             "title": r["title"], "status": r["status"], "employment_type": r["employment_type"],
             "approx_salary": r["approx_salary"], "commitment": r["commitment"], "is_trial": r["is_trial"],
             "filled_by_user_id": r["filled_by_user_id"]}
            for r in rows
        ],
    }


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
    """All contacts in the jobs pipeline (is_jobs_contact=true).

    Opp-linked contacts are kept in sync by setting is_jobs_contact=true at
    create/link time (and a one-time backfill), so we filter on the flag alone
    instead of an `OR EXISTS(... sf_contact_ids ...)` that defeated the index and
    scanned all ~33k contacts (~1.7s).
    """
    filters = ["c.is_jobs_contact = true"]
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

    # Batch-resolve LinkedIn-connected staff names for all returned contacts so
    # the contacts list can show who on the team knows each person.
    contact_ids = [r["contact_id"] for r in rows]
    staff_by_contact: dict[int, list[str]] = {}
    if contact_ids:
        srows = await conn.fetch(
            """
            SELECT scr.contact_id, m.display_name
            FROM public.staff_contact_relationships scr
            JOIN bedrock.staff_user_id_map m ON m.staff_user_id = scr.staff_user_id
            WHERE scr.contact_id = ANY($1::int[]) AND m.display_name IS NOT NULL
            ORDER BY m.display_name
            """,
            contact_ids,
        )
        for s in srows:
            staff_by_contact.setdefault(s["contact_id"], []).append(s["display_name"])

    # Recent engagement per contact (last 90d) → drives the "warmth" indicator
    # alongside connection count.
    activity_by_contact: dict[int, int] = {}
    if contact_ids:
        arows = await conn.fetch(
            """
            SELECT participant_public_contact_id AS cid, count(*) AS n
            FROM bedrock.activity
            WHERE deleted_at IS NULL
              AND participant_public_contact_id = ANY($1::int[])
              AND activity_date >= now() - interval '90 days'
            GROUP BY participant_public_contact_id
            """,
            contact_ids,
        )
        activity_by_contact = {a["cid"]: a["n"] for a in arows}

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
                "connected_staff_names": staff_by_contact.get(r["contact_id"], []),
                "recent_activity_count": activity_by_contact.get(r["contact_id"], 0),
            }
            for r in rows
        ],
    }


@router.get("/contacts/{contact_id}/opportunities")
async def contact_opportunities(
    contact_id: int,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Opportunities this contact is attached to — directly (sf_contact_ids) or
    via a company-name match to the opportunity's account."""
    rows = await conn.fetch(
        """
        WITH c AS (
            SELECT contact_id, airtable_id, current_company
            FROM public.contacts WHERE contact_id = $1
        )
        SELECT o.id, o.account_name, o.title, o.stage, o.deal_type,
               o.owner_email, o.num_roles, o.priority, o.updated_at
        FROM bedrock.jobs_opportunity o, c
        WHERE o.deleted_at IS NULL AND (
            ('pub:' || c.contact_id::text) = ANY(o.sf_contact_ids)
            OR (c.airtable_id IS NOT NULL AND ('airtable:' || c.airtable_id) = ANY(o.sf_contact_ids))
            OR (coalesce(trim(c.current_company), '') <> ''
                AND lower(trim(o.account_name)) = lower(trim(c.current_company)))
        )
        ORDER BY o.updated_at DESC NULLS LAST
        """,
        contact_id,
    )
    return {
        "success": True,
        "data": [
            {
                "id": str(r["id"]),
                "account_name": r["account_name"],
                "title": r["title"],
                "stage": r["stage"],
                "deal_type": r["deal_type"],
                "owner_email": r["owner_email"],
                "num_roles": r["num_roles"],
                "priority": r["priority"],
                "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
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

    # Activity the contact was ACTUALLY a participant in — set by the nightly
    # relink (participant_public_contact_id) or their email being on the thread
    # (from / to / cc). We deliberately do NOT pull deal- or account-level
    # activity: a contact at a company must not inherit calls/emails they
    # weren't part of (that previously showed e.g. every Adonis call on one
    # Adonis contact). first_name fuzzy-matching is dropped for the same reason.
    rows_act = await conn.fetch(
        """
        SELECT a.id, a.type, a.subject, a.description, a.activity_date,
               a.logged_by, a.source, a.email_from, a.email_snippet,
               a.meeting_duration_minutes, a.deleted_at,
               """ + _jobs_activity_flag("a") + """ AS is_jobs
        FROM bedrock.activity a
        WHERE a.deleted_at IS NULL
          AND (
            a.participant_public_contact_id = $1
            OR (
              $2 <> '' AND (
                lower(a.email_from) LIKE '%' || lower($2) || '%'
                OR EXISTS (
                  SELECT 1 FROM unnest(coalesce(a.email_to, '{}') || coalesce(a.email_cc, '{}')) e
                  WHERE lower(e) = lower($2)
                )
              )
            )
          )
        ORDER BY a.activity_date DESC NULLS LAST LIMIT 100
        """,
        contact_id,
        contact_email or "",
    )
    all_activity: list = [dict(r) for r in rows_act]

    all_activity.sort(key=lambda x: x.get("activity_date") or "", reverse=True)
    activity = all_activity[:150]

    # Who on staff is connected to this contact — from LinkedIn connections
    # (public.staff_contact_relationships), resolved to names via
    # bedrock.staff_user_id_map. (The map may be sparsely populated; unresolved
    # staff are returned with name=null so the UI can choose to hide them.)
    conn_rows = await conn.fetch(
        """
        SELECT scr.staff_user_id,
               m.display_name,
               m.email,
               scr.source,
               scr.relationship_strength,
               scr.connected_date
        FROM public.staff_contact_relationships scr
        LEFT JOIN bedrock.staff_user_id_map m ON m.staff_user_id = scr.staff_user_id
        WHERE scr.contact_id = $1
        ORDER BY (m.display_name IS NULL), m.display_name
        """,
        contact_id,
    )
    connected_staff = [
        {
            "staff_user_id":  r["staff_user_id"],
            "name":           r["display_name"],
            "email":          r["email"],
            "source":         r["source"],
            "strength":       r["relationship_strength"],
            "connected_date": r["connected_date"].isoformat() if r["connected_date"] else None,
        }
        for r in conn_rows
    ]

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
            "airtable_id":     row["airtable_id"],
            "deal":            deal,
            "activity":        [dict(a) for a in activity],
            "connected_staff": connected_staff,
        },
    }


CONTACT_SELECT = """
    SELECT contact_id, first_name, last_name, full_name, email,
           current_title, current_company, contact_stage, linkedin_url, source, airtable_id
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
    # skip malformed pub refs (e.g. 'pub:abc') so one bad ref can't 500 the whole load
    pub_ids      = [int(r[4:]) for r in sf_contact_ids if r.startswith("pub:") and r[4:].isdigit()]
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


async def _flag_jobs_contacts(conn, sf_contact_ids: list[str]) -> None:
    """Mark contacts linked to an opp as is_jobs_contact=true so they keep
    showing up in GET /contacts (which now filters on the flag alone)."""
    if not sf_contact_ids:
        return
    airtable_ids = [r[len("airtable:"):] for r in sf_contact_ids if r.startswith("airtable:")]
    pub_ids      = [int(r[4:]) for r in sf_contact_ids if r.startswith("pub:") and r[4:].isdigit()]
    if airtable_ids:
        await conn.execute(
            "UPDATE public.contacts SET is_jobs_contact=true, updated_at=now() "
            "WHERE airtable_id = ANY($1::text[]) AND NOT is_jobs_contact",
            airtable_ids,
        )
    if pub_ids:
        await conn.execute(
            "UPDATE public.contacts SET is_jobs_contact=true, updated_at=now() "
            "WHERE contact_id = ANY($1::int[]) AND NOT is_jobs_contact",
            pub_ids,
        )


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


def _norm_opp(d: dict) -> dict:
    """Guarantee array fields are never None (the columns allow NULL, which
    would crash the frontend pickers that call .map/.length on them)."""
    d["builder_ids"] = d.get("builder_ids") or []
    d["sf_contact_ids"] = d.get("sf_contact_ids") or []
    return d


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
            act.activity_count,
            act.last_activity_at,
            act.recent_activity_count,
            -- Suggested priority (1–5, 5 = highest) the team can override. Bumped by
            -- signals: committed roles, multiple contacts, recent activity, and
            -- builders already applying. AI-first scoring can replace this later.
            LEAST(5, 1
                + (COALESCE(o.num_roles, 0) > 0)::int
                + (COALESCE(array_length(o.sf_contact_ids, 1), 0) > 1)::int
                + (act.recent_activity_count > 0)::int
                + (EXISTS (SELECT 1 FROM public.job_applications ja WHERE ja.jobs_opportunity_id = o.id))::int
            ) AS priority_suggested
        FROM bedrock.jobs_opportunity o
        LEFT JOIN LATERAL (
            -- Same scope as the detail Activity tab: deal-tagged OR company-level
            -- activity. Powers the row "recent activity" indicator so the team can
            -- see at a glance which accounts moved this week.
            SELECT
                count(*)                                              AS activity_count,
                max(a.activity_date)                                  AS last_activity_at,
                count(*) FILTER (
                    WHERE a.activity_date >= now() - interval '7 days'
                )                                                     AS recent_activity_count
            FROM bedrock.activity a
            WHERE a.deleted_at IS NULL
              AND (
                a.jobs_opportunity_id = o.id
                OR (o.account_id <> 'UNKNOWN' AND a.account_id = o.account_id)
              )
        ) act ON true
        WHERE {where}
        ORDER BY o.updated_at DESC
        LIMIT ${i} OFFSET ${i+1}
        """,
        *params, limit, offset,
    )
    total = await conn.fetchval(
        f"SELECT count(*) FROM bedrock.jobs_opportunity o WHERE {where}", *params
    )
    return {"success": True, "data": [_norm_opp(dict(r)) for r in rows], "total": total}


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
                source, owner_email, relationship_owner, sf_contact_ids, builder_ids, follow_up_date
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            RETURNING id
            """,
            body.account_id, body.account_name, body.stage, body.deal_type,
            body.title, body.description, body.salary_expected, body.num_roles, body.likelihood,
            body.source, body.owner_email, body.relationship_owner,
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
        await _flag_jobs_contacts(conn, list(body.sf_contact_ids or []))

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
            a.source, a.logged_by, a.synced_at, a.email_from, a.email_to,
            a.email_snippet, a.email_body_text,
            a.meeting_duration_minutes, a.meeting_attendees, a.deleted_at,
            """ + _jobs_activity_flag("a") + """ AS is_jobs
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
            **_norm_opp(dict(row)),
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
    if body.priority is not None and not (1 <= body.priority <= 5):
        raise HTTPException(400, "priority must be between 1 and 5")

    user_email = user.get("email") if isinstance(user, dict) else getattr(user, "email", None)
    stage_changed = body.stage and body.stage != existing["stage"]

    sets = []
    params: list = []
    i = 1

    for field in ("stage", "deal_type", "title", "description", "salary_expected",
                  "num_roles", "likelihood",
                  "source", "owner_email", "relationship_owner", "sf_contact_ids", "builder_ids",
                  "follow_up_date", "touch_count", "sf_opportunity_id",
                  "closed_lost_reason", "closed_lost_note", "priority", "segment", "intro_by"):
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
        if body.sf_contact_ids is not None:
            await _flag_jobs_contacts(conn, list(body.sf_contact_ids or []))

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
                  "contact_stage", "linkedin_url"):
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
