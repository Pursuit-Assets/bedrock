"""SEC EDGAR API. User-Agent required. 10 req/sec.

P1 — native async via _http.get_client / get_with_retry.
"""

from __future__ import annotations

import logging

import httpx

from ._http import get_client, get_with_retry

BASE = "https://data.sec.gov"
USER_AGENT = "Pebble/1.0 (prospect research; contact@example.com)"

logger = logging.getLogger("pebble.data_sources.sec")


def _headers() -> dict:
    return {"User-Agent": USER_AGENT}


async def fetch_company(cik: str) -> dict | None:
    """Fetch company submissions by CIK. CIK must be zero-padded to 10 digits."""
    cik_padded = str(cik).zfill(10)
    url = f"{BASE}/submissions/CIK{cik_padded}.json"
    r = await get_with_retry(url, headers=_headers())
    return r.json() if r else None


async def search_cik(company_name: str) -> str | None:
    """Look up CIK by company name. Uses company_tickers (approximate match)."""
    url = "https://www.sec.gov/files/company_tickers.json"
    r = await get_with_retry(url, headers=_headers())
    if not r:
        return None
    try:
        tickers = r.json()
        name_lower = company_name.lower()
        for v in tickers.values():
            title = (v.get("title") or v.get("name") or "").lower()
            if name_lower in title or any(w in title for w in name_lower.split() if len(w) > 2):
                return str(v.get("cik_str", v.get("cik", ""))).zfill(10)
        return None
    except (ValueError, KeyError):
        return None


async def search_person_cik(person_name: str) -> str | None:
    """Look up CIK for an individual person (not company).

    Uses the EDGAR company/person search endpoint with owner=include.
    Returns the first matching CIK or None. Falls back to company_tickers
    in case the person is a well-known company figure."""
    try:
        client = await get_client()
        r = await client.get(
            "https://efts.sec.gov/LATEST/search-index",
            params={"q": f'"{person_name}"', "dateRange": "custom",
                    "startdt": "2020-01-01", "forms": "4",
                    "from": 0, "size": 1},
            headers=_headers(),
            timeout=15.0,
        )
        r.raise_for_status()
        data = r.json()
        hits = data.get("hits", {}).get("hits", [])
        if hits:
            ciks = hits[0].get("_source", {}).get("ciks", [])
            if ciks:
                return str(ciks[0]).zfill(10)
    except (httpx.HTTPError, ValueError, KeyError) as e:
        logger.warning("Person CIK search failed for %s: %s", person_name, e)

    return await search_cik(person_name)
