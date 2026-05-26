"""Airtable proxy for the Outcomes team's Jobs base.

Base: appU97D9wOfq6eidF — companies, jobs, employer engagements, job deals.
The data is "pre-merge": not yet reconciled against Salesforce, so the
Jobs page surfaces it as a separate section tagged accordingly.

Auth: a Personal Access Token in `AIRTABLE_PAT`. If the env var is
absent, endpoints return {data: [], configured: false} so the frontend
can render a calm "Airtable not configured" empty state rather than 500.

Caching: 5 min in-process. We're read-only and the upstream rate limit
on Airtable is 5 req/sec/base — caching keeps page reloads cheap.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends

from auth import require_auth

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/airtable/jobs", tags=["airtable-jobs"])


# Base + table IDs are fixed for this single base. If the team ever
# wants more bases surfaced, generalize by adding a /{base}/{table}
# style route — out of scope here.
BASE_ID = "appU97D9wOfq6eidF"
TABLE_IDS = {
    "companies":   "tblOyUDqF6kcntIYk",
    "postings":    "tbl55LSLAA5Flhe87",
    "engagements": "tblRcbb5SzvuWBCCh",
    "deals":       "tbllNUHlb11IaW0S6",
}

# Per-table list of field names we surface. Selected so the frontend has
# enough to render a useful row without dragging the whole record. Names
# match the Airtable schema (case-sensitive on Airtable's side).
TABLE_FIELDS: Dict[str, List[str]] = {
    "companies": [
        "Company Name", "Website", "Industry", "Company Size", "City", "State",
        "Next Steps", "Gen. Notes", "Follow-up Date", "Record Created",
        "Most Recent Contact", "(old) Outreach Status",
    ],
    "postings": [
        "Job Title", "Company", "Job Posting Link", "Job Type", "Location",
        "Salary", "Application Deadline", "Status", "Date Posted", "Start Date",
    ],
    "engagements": [
        "Outreach Action", "Contact Engaged", "Company", "Outreach Type",
        "Date of Contact", "Summary", "Next Steps", "Outreach Owner",
        "Follow-up Date",
    ],
    "deals": [
        "Deal ID", "Company", "Deal Co' Contact", "Deal Stage", "Deal Type",
        "Next Step", "Notes", "Pursuit Deal Lead", "Created", "Builders",
    ],
}

# Page size cap. Airtable's max is 100/page; we request 100 and follow
# the offset cursor up to a safety limit so a runaway table doesn't pull
# 50k rows in one request.
_PAGE_SIZE = 100
_MAX_PAGES = 30  # 3000 rows hard cap per table


# ── In-process cache ────────────────────────────────────────────────────

_CACHE_TTL_SECONDS = 5 * 60
_cache: Dict[str, tuple[float, Dict[str, Any]]] = {}


def _cache_get(key: str) -> Optional[Dict[str, Any]]:
    entry = _cache.get(key)
    if not entry:
        return None
    expiry, payload = entry
    if expiry < time.time():
        _cache.pop(key, None)
        return None
    return payload


def _cache_set(key: str, payload: Dict[str, Any]) -> None:
    _cache[key] = (time.time() + _CACHE_TTL_SECONDS, payload)


# ── Fetch ───────────────────────────────────────────────────────────────


async def _fetch_table(table_key: str) -> Dict[str, Any]:
    """Fetch all records (within the safety cap) for the given table.

    Returns {data, configured, error?}.
    """
    cached = _cache_get(table_key)
    if cached is not None:
        return cached

    pat = os.environ.get("AIRTABLE_PAT")
    if not pat:
        result = {"data": [], "configured": False, "error": "AIRTABLE_PAT not set"}
        # Don't cache the un-configured case so adding the env var takes effect on next request.
        return result

    table_id = TABLE_IDS[table_key]
    fields = TABLE_FIELDS[table_key]
    url = f"https://api.airtable.com/v0/{BASE_ID}/{table_id}"
    headers = {"Authorization": f"Bearer {pat}"}
    base_params = {"pageSize": _PAGE_SIZE}
    # Airtable expects fields[] repeated for each requested field.
    fields_params: List[tuple[str, str]] = [("fields[]", f) for f in fields]

    records: List[Dict[str, Any]] = []
    offset: Optional[str] = None
    pages_fetched = 0

    async with httpx.AsyncClient(timeout=15.0) as http:
        while True:
            params: List[tuple[str, Any]] = list(fields_params)
            for k, v in base_params.items():
                params.append((k, v))
            if offset:
                params.append(("offset", offset))
            try:
                resp = await http.get(url, headers=headers, params=params)
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                logger.warning("airtable %s: HTTP %s: %s", table_key, exc.response.status_code, exc.response.text[:200])
                return {"data": [], "configured": True, "error": f"Airtable HTTP {exc.response.status_code}"}
            except httpx.HTTPError as exc:
                logger.warning("airtable %s: network error: %s", table_key, exc)
                return {"data": [], "configured": True, "error": "Airtable network error"}

            body = resp.json()
            for r in body.get("records", []):
                # Flatten — primary id alongside the picked fields.
                row: Dict[str, Any] = {"id": r.get("id")}
                row.update(r.get("fields", {}) or {})
                records.append(row)

            offset = body.get("offset")
            pages_fetched += 1
            if not offset or pages_fetched >= _MAX_PAGES:
                break

    result = {"data": records, "configured": True}
    _cache_set(table_key, result)
    return result


# ── Endpoints ───────────────────────────────────────────────────────────

@router.get("/companies")
async def get_companies(user=Depends(require_auth)):
    return await _fetch_table("companies")


@router.get("/postings")
async def get_postings(user=Depends(require_auth)):
    return await _fetch_table("postings")


@router.get("/engagements")
async def get_engagements(user=Depends(require_auth)):
    return await _fetch_table("engagements")


@router.get("/deals")
async def get_deals(user=Depends(require_auth)):
    return await _fetch_table("deals")
