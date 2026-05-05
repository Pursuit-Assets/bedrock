"""Salesforce search endpoints — SOSL cross-entity and SOQL per-entity search.

Used by Pebble's CRM bridge for disambiguation and entity lookup.
All endpoints accept either user JWT auth or internal API key (service-to-service).
"""

import logging
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import require_auth_or_internal
from dependencies import get_mcp_client, require_sf_mcp_client
from mcp_client import UnifiedMCPClient
from security import escape_soql_string, escape_sosl_string

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/salesforce", tags=["salesforce-search"])


def _group_sosl_results(raw_results: Any) -> Dict[str, List[dict]]:
    """Group flat SOSL search results by sObject type.

    simple-salesforce's sf.search() returns a list of
    {sobjectType: str, records: [...]} objects.
    """
    grouped: Dict[str, List[dict]] = {"Contact": [], "Account": [], "Opportunity": [], "Task": []}
    if not raw_results:
        return grouped
    # Handle list of {sobjectType, records} objects
    if isinstance(raw_results, list):
        for item in raw_results:
            obj_type = item.get("sobjectType", "")
            records = item.get("records", [])
            if obj_type in grouped:
                grouped[obj_type].extend(records)
    # Handle dict with searchRecords (fallback for different SF API versions)
    elif isinstance(raw_results, dict):
        for record in raw_results.get("searchRecords", []):
            obj_type = record.get("attributes", {}).get("type", "")
            if obj_type in grouped:
                grouped[obj_type].append(record)
    return grouped


@router.get("/search")
async def search_all(
    q: str = Query(..., min_length=2, max_length=100),
    limit: int = Query(10, ge=1, le=25),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth_or_internal),
):
    """Cross-entity SOSL search across Contacts, Accounts, Opportunities, and Tasks.

    One Salesforce API call instead of three separate SOQL queries.
    Used by Pebble's readiness module for multi-layer disambiguation.
    """
    safe_q = escape_sosl_string(q.strip())
    # RecordType.Name in Account RETURNING: standard relationship field,
    # should work in most SF orgs. If your org restricts RecordType access,
    # remove it — readiness.py handles missing RecordType gracefully.
    sosl = (
        f"FIND {{{safe_q}}} IN ALL FIELDS RETURNING "
        f"Contact(Id, FirstName, LastName, Name, Email, Title, "
        f"AccountId, Account.Name, Account.Type LIMIT {limit}), "
        f"Account(Id, Name, Type, Industry, RecordType.Name LIMIT {limit}), "
        f"Opportunity(Id, Name, StageName, Amount, CloseDate, "
        f"Account.Name, Account.Type, Owner.Name LIMIT {limit}), "
        f"Task(Id, Subject, Status, Priority, ActivityDate, "
        f"Who.Name, What.Name, WhoId, WhatId, OwnerId, Owner.Name LIMIT {limit})"
    )
    try:
        salesforce = client.salesforce
        result = await salesforce.search(sosl)
        return _group_sosl_results(result)
    except Exception as e:
        logger.error("SOSL search failed for q=%s: %s", q, e)
        raise HTTPException(status_code=500, detail=f"Search failed: {e}")


@router.get("/contacts/search")
async def search_contacts(
    q: str = Query(..., min_length=2, max_length=100),
    limit: int = Query(10, ge=1, le=25),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth_or_internal),
):
    """Search contacts by name or email (SOQL)."""
    safe_q = escape_soql_string(q.strip())
    soql = (
        f"SELECT Id, FirstName, LastName, Name, Email, Title, Phone, "
        f"AccountId, Account.Name "
        f"FROM Contact "
        f"WHERE Name LIKE '%{safe_q}%' OR Email LIKE '%{safe_q}%' "
        f"ORDER BY LastName ASC LIMIT {limit}"
    )
    try:
        salesforce = client.salesforce
        result = await salesforce.query(soql)
        return result.get("records", [])
    except Exception as e:
        logger.error("Contact search failed for q=%s: %s", q, e)
        raise HTTPException(status_code=500, detail=f"Contact search failed: {e}")


@router.get("/accounts/search")
async def search_accounts(
    q: str = Query(..., min_length=2, max_length=100),
    limit: int = Query(10, ge=1, le=25),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth_or_internal),
):
    """Search accounts by name (SOQL)."""
    safe_q = escape_soql_string(q.strip())
    soql = (
        f"SELECT Id, Name, Type, Industry "
        f"FROM Account "
        f"WHERE Name LIKE '%{safe_q}%' "
        f"ORDER BY Name ASC LIMIT {limit}"
    )
    try:
        salesforce = client.salesforce
        result = await salesforce.query(soql)
        return result.get("records", [])
    except Exception as e:
        logger.error("Account search failed for q=%s: %s", q, e)
        raise HTTPException(status_code=500, detail=f"Account search failed: {e}")


@router.get("/opportunities/search")
async def search_opportunities(
    q: str = Query(..., min_length=2, max_length=100),
    account_id: str = Query(None, max_length=18),
    limit: int = Query(10, ge=1, le=25),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth_or_internal),
):
    """Search opportunities by name, optionally filtered by account (SOQL)."""
    safe_q = escape_soql_string(q.strip())
    where = f"Name LIKE '%{safe_q}%'"
    if account_id:
        from security import validate_salesforce_id
        validate_salesforce_id(account_id, "account_id")
        where += f" AND AccountId = '{account_id}'"
    soql = (
        f"SELECT Id, Name, Amount, StageName, CloseDate, "
        f"Account.Name, Owner.Name "
        f"FROM Opportunity "
        f"WHERE {where} "
        f"ORDER BY CloseDate DESC LIMIT {limit}"
    )
    try:
        salesforce = client.salesforce
        result = await salesforce.query(soql)
        return result.get("records", [])
    except Exception as e:
        logger.error("Opportunity search failed for q=%s: %s", q, e)
        raise HTTPException(status_code=500, detail=f"Opportunity search failed: {e}")
