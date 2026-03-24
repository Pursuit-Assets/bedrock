"""FINRA BrokerCheck API. No auth required. Undocumented but working."""

import logging

import httpx

logger = logging.getLogger("pebble.data_sources.finra")

BASE = "https://api.brokercheck.finra.org"


def _get(endpoint: str, params: dict | None = None) -> dict | None:
    """GET with error handling. Returns parsed JSON or None."""
    try:
        r = httpx.get(f"{BASE}/{endpoint}", params=params, timeout=15.0)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        logger.warning("FINRA API error for %s: %s", endpoint, e)
        return None


def search_individual(name: str, limit: int = 5) -> list[dict]:
    """Search individuals by name. Returns list of broker/advisor records.

    Each result (in hits.hits[]._source) has:
    ind_source_id, ind_firstname, ind_middlename, ind_lastname,
    ind_other_names[], ind_bc_scope (Active/Inactive),
    ind_ia_scope (Active/Inactive), ind_bc_disclosure_fl (Y/N),
    ind_current_employments[] (firm_name, branch_city, branch_state,
    firm_bd_sec_number, firm_ia_sec_number), ind_industry_cal_date
    """
    data = _get("search/individual", {"query": name, "start": 0, "rows": min(limit, 10)})
    if not data:
        return []
    hits = data.get("hits", {}).get("hits", [])
    return [h.get("_source", {}) for h in hits]


def search_firm(name: str, limit: int = 5) -> list[dict]:
    """Search firms by name. Returns list of firm records."""
    data = _get("search/firm", {"query": name, "start": 0, "rows": min(limit, 10)})
    if not data:
        return []
    hits = data.get("hits", {}).get("hits", [])
    return [h.get("_source", {}) for h in hits]
