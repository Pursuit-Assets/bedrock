"""OpenCorporates officer search. API key required (free tier: 500 req/month).

P1 — native async via _http with circuit breaker.
"""

from __future__ import annotations

import logging
import os

from ._circuit import CircuitBreaker
from ._http import get_with_retry

logger = logging.getLogger("pebble.data_sources.opencorporates")

OFFICERS_URL = "https://api.opencorporates.com/v0.4/officers/search"

_breaker = CircuitBreaker("opencorporates")


async def search_officers(name: str, limit: int = 10) -> list[dict]:
    """Search OpenCorporates for officers by name."""
    params: dict = {"q": name, "per_page": min(limit, 30)}
    api_key = os.getenv("OPENCORPORATES_API_KEY")
    if api_key:
        params["api_token"] = api_key

    r = await get_with_retry(OFFICERS_URL, params=params, breaker=_breaker)
    if not r:
        return []
    try:
        data = r.json()
        officers_raw = data.get("results", {}).get("officers", [])[:limit]
        results = []
        for entry in officers_raw:
            officer = entry.get("officer", {})
            company = officer.get("company", {})
            results.append({
                "name": officer.get("name", ""),
                "position": officer.get("position", ""),
                "company_name": company.get("name", ""),
                "company_number": company.get("company_number", ""),
                "jurisdiction_code": company.get("jurisdiction_code", ""),
                "opencorporates_url": officer.get("opencorporates_url", ""),
            })
        return results
    except (ValueError, KeyError) as e:
        logger.warning("OpenCorporates parse error: %s", e)
        return []
