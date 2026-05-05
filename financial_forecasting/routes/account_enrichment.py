"""Account enrichment lookup — read-only, user-facing.

Joins SF Account ids → bedrock.sf_account_company_map → public.companies
to expose `logo_url`, `domain`, `industry`, etc. for the UI. The matcher
itself lives in services/sf_company_matcher.py and is run via the
admin endpoints in routes/admin_company_match.py.

Endpoints:
    GET /api/accounts/enrichment?ids=A,B,C
        Batch lookup for the Accounts list / table views.
    GET /api/accounts/{sf_account_id}/enrichment
        Single-account convenience for the AccountDetail header.

Returns null fields where no match exists yet — frontend falls back to
initials avatars in that case.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import require_auth
from db import get_db
from security import validate_salesforce_id

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/accounts", tags=["account-enrichment"])

_LOOKUP_SQL = """
    SELECT m.sf_account_id,
           c.company_id,
           c.name,
           c.domain,
           -- Prefer the bedrock overlay (Apollo via Zero, etc.) over the
           -- often-dead Clearbit URLs stored in public.companies.logo_url.
           COALESCE(le.logo_url, c.logo_url)             AS logo_url,
           c.industry,
           c.size_bucket,
           COALESCE(le.source, c.enrichment_source)       AS enrichment_source,
           COALESCE(le.enriched_at, c.enriched_at)        AS enriched_at,
           m.confidence,
           m.matched_by
    FROM bedrock.sf_account_company_map m
    JOIN public.companies c
        ON c.company_id = m.public_company_id
    LEFT JOIN bedrock.company_logo_enrichment le
        ON le.public_company_id = c.company_id
    WHERE m.sf_account_id = ANY($1::text[])
"""


def _serialize(row: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(row)
    if out.get("enriched_at") is not None:
        out["enriched_at"] = out["enriched_at"].isoformat()
    return out


@router.get("/enrichment")
async def batch_enrichment(
    ids: str = Query(
        ...,
        description=(
            "Comma-separated SF Account Ids. Capped at 1000 per request."
        ),
    ),
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Dict[str, Optional[Dict[str, Any]]]:
    """Returns `{sf_account_id: enrichment | null}` for every requested id.
    Unmapped accounts return `null` so the frontend can render an avatar
    fallback without a follow-up lookup.
    """
    raw_ids = [s.strip() for s in ids.split(",") if s.strip()]
    valid: List[str] = []
    for i in raw_ids[:1000]:
        try:
            validate_salesforce_id(i, "sf_account_id")
            valid.append(i)
        except HTTPException:
            continue
    if not valid:
        return {}

    rows = await conn.fetch(_LOOKUP_SQL, valid)
    by_id: Dict[str, Dict[str, Any]] = {
        r["sf_account_id"]: _serialize(dict(r)) for r in rows
    }
    return {sid: by_id.get(sid) for sid in valid}


@router.get("/{sf_account_id}/enrichment")
async def single_enrichment(
    sf_account_id: str,
    conn=Depends(get_db),
    user=Depends(require_auth),
) -> Optional[Dict[str, Any]]:
    """Single-account version. Returns null if not yet matched."""
    validate_salesforce_id(sf_account_id, "sf_account_id")
    row = await conn.fetchrow(_LOOKUP_SQL, [sf_account_id])
    return _serialize(dict(row)) if row else None
