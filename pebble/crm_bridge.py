"""CRM Bridge — Pebble's interface to Bedrock's Salesforce data.

Calls Bedrock's /api/salesforce/* endpoints using an internal API key
for service-to-service auth.  All methods return data on success or
None on failure (never raise) so callers degrade gracefully.
"""

import logging
import os
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger("pebble.crm_bridge")

_BEDROCK_API_URL = os.getenv("BEDROCK_API_URL", "http://localhost:8000")
_BEDROCK_INTERNAL_API_KEY = os.getenv("BEDROCK_INTERNAL_API_KEY", "")

_client: Optional[httpx.AsyncClient] = None


def _get_client() -> httpx.AsyncClient:
    """Lazy-init singleton httpx.AsyncClient with connection pooling."""
    global _client
    if _client is None or _client.is_closed:
        headers: Dict[str, str] = {}
        if _BEDROCK_INTERNAL_API_KEY:
            headers["X-Internal-Key"] = _BEDROCK_INTERNAL_API_KEY
        _client = httpx.AsyncClient(
            base_url=_BEDROCK_API_URL,
            headers=headers,
            timeout=httpx.Timeout(5.0, connect=3.0),
        )
    return _client


async def close() -> None:
    """Close the httpx client.  Call from app lifespan shutdown."""
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None


# ---------------------------------------------------------------------------
# Cross-entity search (SOSL — one API call)
# ---------------------------------------------------------------------------

async def search_all(q: str, limit: int = 10) -> Optional[Dict[str, List[dict]]]:
    """Cross-entity SOSL search.

    Returns {"Contact": [...], "Account": [...], "Opportunity": [...]}
    or None on failure.
    """
    try:
        client = _get_client()
        resp = await client.get(
            "/api/salesforce/search",
            params={"q": q, "limit": limit},
        )
        resp.raise_for_status()
        return resp.json()
    except httpx.TimeoutException:
        logger.warning("CRM bridge timeout: search_all q=%s", q)
        return None
    except httpx.HTTPStatusError as e:
        logger.warning("CRM bridge HTTP %s: search_all q=%s", e.response.status_code, q)
        return None
    except Exception as e:
        logger.error("CRM bridge error: search_all q=%s: %s", q, e)
        return None


# ---------------------------------------------------------------------------
# Type-specific searches (SOQL)
# ---------------------------------------------------------------------------

async def search_contacts(q: str, limit: int = 10) -> Optional[List[dict]]:
    """Search contacts by name/email."""
    try:
        client = _get_client()
        resp = await client.get(
            "/api/salesforce/contacts/search",
            params={"q": q, "limit": limit},
        )
        resp.raise_for_status()
        return resp.json()
    except httpx.TimeoutException:
        logger.warning("CRM bridge timeout: search_contacts q=%s", q)
        return None
    except httpx.HTTPStatusError as e:
        logger.warning("CRM bridge HTTP %s: search_contacts q=%s", e.response.status_code, q)
        return None
    except Exception as e:
        logger.error("CRM bridge error: search_contacts q=%s: %s", q, e)
        return None


async def search_accounts(q: str, limit: int = 10) -> Optional[List[dict]]:
    """Search accounts by name."""
    try:
        client = _get_client()
        resp = await client.get(
            "/api/salesforce/accounts/search",
            params={"q": q, "limit": limit},
        )
        resp.raise_for_status()
        return resp.json()
    except httpx.TimeoutException:
        logger.warning("CRM bridge timeout: search_accounts q=%s", q)
        return None
    except httpx.HTTPStatusError as e:
        logger.warning("CRM bridge HTTP %s: search_accounts q=%s", e.response.status_code, q)
        return None
    except Exception as e:
        logger.error("CRM bridge error: search_accounts q=%s: %s", q, e)
        return None


async def search_opportunities(
    q: str, account_id: str | None = None, limit: int = 10
) -> Optional[List[dict]]:
    """Search opportunities by name, optionally filtered by account."""
    params: Dict[str, Any] = {"q": q, "limit": limit}
    if account_id:
        params["account_id"] = account_id
    try:
        client = _get_client()
        resp = await client.get(
            "/api/salesforce/opportunities/search",
            params=params,
        )
        resp.raise_for_status()
        return resp.json()
    except httpx.TimeoutException:
        logger.warning("CRM bridge timeout: search_opportunities q=%s", q)
        return None
    except httpx.HTTPStatusError as e:
        logger.warning(
            "CRM bridge HTTP %s: search_opportunities q=%s",
            e.response.status_code, q,
        )
        return None
    except Exception as e:
        logger.error("CRM bridge error: search_opportunities q=%s: %s", q, e)
        return None


# ---------------------------------------------------------------------------
# Direct data access (existing Bedrock endpoints)
# ---------------------------------------------------------------------------

async def get_opportunities(
    stage: str | None = None, limit: int = 100
) -> Optional[List[dict]]:
    """Get opportunities, optionally filtered by stage."""
    params: Dict[str, Any] = {"limit": limit}
    if stage:
        params["stage"] = stage
    try:
        client = _get_client()
        resp = await client.get("/api/salesforce/opportunities", params=params)
        resp.raise_for_status()
        return resp.json()
    except httpx.TimeoutException:
        logger.warning("CRM bridge timeout: get_opportunities")
        return None
    except httpx.HTTPStatusError as e:
        logger.warning("CRM bridge HTTP %s: get_opportunities", e.response.status_code)
        return None
    except Exception as e:
        logger.error("CRM bridge error: get_opportunities: %s", e)
        return None


# ---------------------------------------------------------------------------
# CRM write operations (Pebble → Bedrock → Salesforce)
# ---------------------------------------------------------------------------

async def create_account(
    name: str, account_type: str = "", industry: str = "",
) -> Optional[Dict]:
    """Create a Salesforce account via Bedrock.

    Returns {"id": "001xx...", "message": "..."} on success, None on failure.
    """
    payload: Dict[str, str] = {"Name": name}
    if account_type:
        payload["Type"] = account_type
    if industry:
        payload["Industry"] = industry
    try:
        client = _get_client()
        resp = await client.post("/api/salesforce/accounts", json=payload)
        resp.raise_for_status()
        body = resp.json()
        return body.get("data")
    except httpx.TimeoutException:
        logger.warning("CRM bridge timeout: create_account name=%s", name)
        return None
    except httpx.HTTPStatusError as e:
        logger.warning("CRM bridge HTTP %s: create_account name=%s", e.response.status_code, name)
        return None
    except Exception as e:
        logger.error("CRM bridge error: create_account name=%s: %s", name, e)
        return None


async def create_contact(
    first_name: str, last_name: str,
    account_id: Optional[str] = None, title: str = "", email: str = "",
) -> Optional[Dict]:
    """Create a Salesforce contact via Bedrock.

    Returns {"id": "003xx...", "message": "..."} on success, None on failure.
    """
    payload: Dict[str, str] = {"FirstName": first_name, "LastName": last_name}
    if account_id:
        payload["AccountId"] = account_id
    if title:
        payload["Title"] = title
    if email:
        payload["Email"] = email
    try:
        client = _get_client()
        resp = await client.post("/api/salesforce/contacts", json=payload)
        resp.raise_for_status()
        body = resp.json()
        return body.get("data")
    except httpx.TimeoutException:
        logger.warning("CRM bridge timeout: create_contact name=%s %s", first_name, last_name)
        return None
    except httpx.HTTPStatusError as e:
        logger.warning("CRM bridge HTTP %s: create_contact name=%s %s", e.response.status_code, first_name, last_name)
        return None
    except Exception as e:
        logger.error("CRM bridge error: create_contact name=%s %s: %s", first_name, last_name, e)
        return None


async def health() -> bool:
    """Check if the Bedrock API is reachable."""
    try:
        client = _get_client()
        resp = await client.get("/health")
        return resp.status_code == 200
    except Exception:
        return False
