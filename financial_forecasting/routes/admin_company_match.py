"""Admin endpoints for SF Account ↔ public.companies matching (Claim 4).

Operates the matcher service in services/sf_company_matcher.py:
  - POST   /api/admin/sf-company-match/scan       — run the batch matcher
  - GET    /api/admin/sf-company-match            — list all matches
  - GET    /api/admin/sf-company-match/unmatched  — list SF Accounts with no match
  - POST   /api/admin/sf-company-match/manual     — admin manually creates/overrides
  - DELETE /api/admin/sf-company-match/{id}       — remove a match

All endpoints require admin (`manage_users_roles` permission) via the
existing require_admin dependency. Mirrors routes/admin_sf_drift.py shape.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from db import get_db
from dependencies import get_mcp_client
from routes.permissions import require_admin
from services.sf_company_matcher import (
    delete_match,
    get_unmatched_accounts,
    list_matches,
    match_all_accounts,
    upsert_manual_match,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/sf-company-match", tags=["admin-sf-company-match"])


class ManualMatchRequest(BaseModel):
    sf_account_id: str
    public_company_id: int
    notes: str | None = None


class LogoUpdate(BaseModel):
    public_company_id: int
    logo_url: str


class BulkLogoUpdateRequest(BaseModel):
    updates: list[LogoUpdate]
    source: str = "apollo_zero"


@router.post("/scan")
async def scan_company_matches(
    dry_run: bool = Query(False, description="If true, no inserts are written"),
    limit: int = Query(1000, ge=1, le=10000),
    user=Depends(require_admin),
    conn=Depends(get_db),
    client=Depends(get_mcp_client),
):
    """Run the batch matcher across all SF Accounts.

    Returns a summary like:
        {"total": 499, "matched": 87, "unmatched": 412, "errors": 0,
         "by_confidence": {"exact_name": 64, "normalized_name": 18, "domain": 5}}
    """
    try:
        salesforce = client.salesforce
    except RuntimeError:
        raise HTTPException(503, "Salesforce not connected — connect via Settings first")

    summary = await match_all_accounts(salesforce, conn, limit=limit, dry_run=dry_run)
    return {"success": True, "data": summary}


@router.get("")
async def list_company_matches(
    limit: int = Query(1000, ge=1, le=10000),
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """List all SF Account → public.companies matches with the joined company name."""
    matches = await list_matches(conn, limit=limit)
    return {"success": True, "data": matches}


@router.get("/unmatched")
async def list_unmatched_accounts(
    limit: int = Query(500, ge=1, le=5000),
    user=Depends(require_admin),
    conn=Depends(get_db),
    client=Depends(get_mcp_client),
):
    """List SF Accounts that have no row in bedrock.sf_account_company_map.

    Used by the admin review queue. Each entry is a candidate for either
    manual mapping or "no platform equivalent exists" confirmation.
    """
    try:
        salesforce = client.salesforce
    except RuntimeError:
        raise HTTPException(503, "Salesforce not connected — connect via Settings first")

    unmatched = await get_unmatched_accounts(salesforce, conn, limit=limit)
    return {"success": True, "data": unmatched}


@router.post("/manual")
async def create_manual_match(
    body: ManualMatchRequest,
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """Admin manually creates or overrides a match.

    Forces confidence='manual'. Overwrites any existing auto-match for the
    same sf_account_id. The matched_by field is set to the admin's email
    so we can audit who confirmed which links.
    """
    matched_by = user.get("email", "unknown")
    row = await upsert_manual_match(
        body.sf_account_id, body.public_company_id, matched_by, body.notes, conn,
    )
    return {"success": True, "data": dict(row)}


@router.get("/enrichment-candidates")
async def list_enrichment_candidates(
    only_missing: bool = Query(
        True,
        description="If true, only returns rows with no logo_url or a dead Clearbit pointer.",
    ),
    limit: int = Query(2000, ge=1, le=10000),
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """List `{public_company_id, name, domain}` for matched accounts whose
    public.companies row has a domain set — i.e., enrichable via a domain-
    based logo API like Apollo. Used by a local script that pipes domains
    through `zero fetch` and posts results to /bulk-update-logos.
    """
    where = "c.domain IS NOT NULL AND c.domain <> ''"
    if only_missing:
        # Skip rows where bedrock overlay already has a logo (e.g. from a
        # previous Apollo run) AND skip rows whose only existing logo is
        # a dead Clearbit pointer. Treat anything else as "already good".
        where += (
            " AND le.public_company_id IS NULL"
            " AND (c.logo_url IS NULL"
            " OR c.logo_url ILIKE 'https://logo.clearbit.com/%')"
        )
    rows = await conn.fetch(
        f"""
        SELECT DISTINCT c.company_id, c.name, c.domain
        FROM bedrock.sf_account_company_map m
        JOIN public.companies c ON c.company_id = m.public_company_id
        LEFT JOIN bedrock.company_logo_enrichment le
            ON le.public_company_id = c.company_id
        WHERE {where}
        ORDER BY c.company_id
        LIMIT $1
        """,
        int(limit),
    )
    return {"success": True, "data": [dict(r) for r in rows]}


@router.post("/bulk-update-logos")
async def bulk_update_logos(
    body: BulkLogoUpdateRequest,
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """Bulk-update `public.companies.logo_url` for a list of company_ids.
    Used after a local Apollo bulk-enrichment run via Zero CLI.
    """
    if not body.updates:
        return {"success": True, "data": {"updated": 0}}

    ids = [u.public_company_id for u in body.updates]
    urls = [u.logo_url for u in body.updates]
    # We can't UPDATE public.companies (role lacks privilege). Write to
    # the bedrock overlay table instead — read endpoints prefer it.
    result = await conn.execute(
        """
        INSERT INTO bedrock.company_logo_enrichment
            (public_company_id, logo_url, source, enriched_at)
        SELECT u.company_id, u.logo_url, $3, NOW()
        FROM (SELECT UNNEST($1::int[]) AS company_id,
                     UNNEST($2::text[]) AS logo_url) AS u
        ON CONFLICT (public_company_id) DO UPDATE
            SET logo_url = EXCLUDED.logo_url,
                source = EXCLUDED.source,
                enriched_at = NOW()
        """,
        ids,
        urls,
        body.source,
    )
    n = int(result.split()[-1]) if result and result.startswith("INSERT") else 0
    return {"success": True, "data": {"upserted": n}}


@router.delete("/{sf_account_id}")
async def delete_company_match(
    sf_account_id: str,
    user=Depends(require_admin),
    conn=Depends(get_db),
):
    """Remove a match (e.g., it was wrong)."""
    deleted = await delete_match(sf_account_id, conn)
    if not deleted:
        raise HTTPException(404, "No match found for that SF Account ID")
    return {"success": True, "data": {"sf_account_id": sf_account_id, "deleted": True}}
