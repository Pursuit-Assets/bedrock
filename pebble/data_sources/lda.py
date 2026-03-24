"""Lobbying Disclosure Act API (lda.senate.gov). Free, no auth. 15 req/min."""

import logging
import httpx

logger = logging.getLogger("pebble.data_sources.lda")

BASE = "https://lda.senate.gov/api/v1"


def _get(endpoint: str, params: dict | None = None) -> dict | None:
    """GET with error handling. Returns parsed JSON or None."""
    try:
        r = httpx.get(f"{BASE}/{endpoint}/", params=params, timeout=15.0,
                       headers={"Accept": "application/json"})
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        logger.warning("LDA API error for %s: %s", endpoint, e)
        return None


def search_lobbyists(name: str, limit: int = 10) -> list[dict]:
    """Search lobbyists by name. Returns list of lobbyist records.

    Note: search= does broad text match across the corpus, not strict name filter.
    Results should be post-filtered by caller if exact match needed.

    Each result has: id, first_name, last_name, prefix, suffix,
    registrant (nested: name, description, address, contact_name)
    """
    data = _get("lobbyists", {"search": name, "page_size": min(limit, 25)})
    if not data:
        return []
    return data.get("results", [])


def search_filings(
    client_name: str | None = None,
    registrant_name: str | None = None,
    filing_year: int | None = None,
    limit: int = 10,
) -> list[dict]:
    """Search lobbying filings (LD-1/LD-2).

    Each result has: filing_uuid, filing_type, filing_year, income, expenses,
    registrant (nested), client (nested: name, general_description),
    lobbying_activities[] (with general_issue_code_display, description,
    lobbyists[] with covered_position, government_entities[])
    """
    params = {"page_size": min(limit, 25)}
    if client_name:
        params["client_name"] = client_name
    if registrant_name:
        params["registrant_name"] = registrant_name
    if filing_year:
        params["filing_year"] = filing_year
    data = _get("filings", params)
    if not data:
        return []
    return data.get("results", [])


def search_contributions(lobbyist_name: str | None = None, limit: int = 10) -> list[dict]:
    """Search LD-203 contribution reports."""
    params = {"page_size": min(limit, 25)}
    if lobbyist_name:
        params["search"] = lobbyist_name
    data = _get("contributions", params)
    if not data:
        return []
    return data.get("results", [])
