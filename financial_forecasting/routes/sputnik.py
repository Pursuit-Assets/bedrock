"""Sputnik leads — staff personal outreach pipeline.

Sputnik is Pursuit's staff-outreach tracker for AI-native employer leads.
Each row in `public.outreach` is one staff member's contact attempt
against a real person (name, title, company, LinkedIn) with notes,
ownership, and stage tracking.

The table lives on segundo-db — same Postgres Bedrock already pools
against via `db.py`, so no new credentials needed.

Endpoint:
  GET /api/sputnik/leads
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

import asyncpg
from fastapi import APIRouter, Depends

from auth import require_auth
from db import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/sputnik", tags=["sputnik"])


@router.get("/leads")
async def get_sputnik_leads(user=Depends(require_auth), conn=Depends(get_db)):
    """Recent staff outreach rows from `public.outreach`.

    Returns a flat projection of the columns the UI actually renders.
    The route is schema-tolerant — if `public.outreach` isn't present
    (e.g. on a dev DB that's behind), it returns `{available: false}`
    so the section can render a calm empty state.
    """
    try:
        exists = await conn.fetchval(
            "SELECT EXISTS ("
            "  SELECT 1 FROM information_schema.tables "
            "  WHERE table_schema='public' AND table_name='outreach'"
            ")"
        )
    except Exception as exc:
        logger.warning("sputnik: table-existence check failed: %s", exc)
        return {"data": [], "available": False, "error": "DB check failed"}

    if not exists:
        return {
            "data": [],
            "available": False,
            "error": "public.outreach not present in this database",
        }

    try:
        rows = await conn.fetch(
            """
            SELECT id,
                   staff_user_id,
                   contact_name,
                   contact_title,
                   contact_email,
                   contact_phone,
                   company_name,
                   linkedin_url,
                   contact_method,
                   outreach_date,
                   status,
                   stage,
                   stage_detail,
                   ownership,
                   current_owner,
                   source,
                   aligned_sector,
                   job_title,
                   notes,
                   response_notes,
                   last_interaction_date,
                   last_interaction_type,
                   created_at,
                   updated_at
              FROM public.outreach
             ORDER BY COALESCE(last_interaction_date, outreach_date, updated_at) DESC NULLS LAST
             LIMIT 500
            """
        )
    except asyncpg.PostgresError as exc:
        logger.warning("sputnik: full projection failed (%s); trying SELECT *", exc)
        try:
            rows = await conn.fetch(
                "SELECT * FROM public.outreach ORDER BY updated_at DESC NULLS LAST LIMIT 500"
            )
        except asyncpg.PostgresError as exc2:
            logger.warning("sputnik: fallback also failed: %s", exc2)
            return {"data": [], "available": False, "error": str(exc2)}

    # Resolve staff_user_id → display name so the "Owner" column reads
    # nicely. Some rows already carry `current_owner` as free text; we
    # prefer that, then fall back to a lookup, then the bare id.
    staff_ids = {r["staff_user_id"] for r in rows if r.get("staff_user_id")}
    staff_name_by_id: Dict[int, str] = {}
    if staff_ids:
        try:
            placeholders = ", ".join(str(int(s)) for s in staff_ids)
            staff_rows = await conn.fetch(
                f"SELECT user_id, first_name, last_name "
                f"FROM public.users WHERE user_id IN ({placeholders})"
            )
            for s in staff_rows:
                full = " ".join(
                    p for p in (s.get("first_name"), s.get("last_name")) if p
                ).strip()
                staff_name_by_id[s["user_id"]] = full or f"User #{s['user_id']}"
        except Exception as exc:
            logger.info("sputnik: staff name join skipped: %s", exc)

    leads: List[Dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        sid = d.get("staff_user_id")
        d["staff_name"] = (
            d.get("current_owner")
            or d.get("ownership")
            or (staff_name_by_id.get(sid) if sid else None)
        )
        leads.append(d)

    return {"data": leads, "available": True}
