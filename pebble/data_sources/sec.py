"""SEC EDGAR API. User-Agent required. 10 req/sec."""

import time

import httpx

BASE = "https://data.sec.gov"
USER_AGENT = "Pebble/1.0 (prospect research; contact@example.com)"


def _headers() -> dict:
    return {"User-Agent": USER_AGENT}


def _get_with_retry(url: str, max_retries: int = 2) -> httpx.Response | None:
    """GET with retry on 429 (rate limit). Returns None on error."""
    for attempt in range(max_retries + 1):
        try:
            r = httpx.get(url, headers=_headers(), timeout=30.0)
            if r.status_code == 429 and attempt < max_retries:
                time.sleep(2 ** attempt)
                continue
            r.raise_for_status()
            return r
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429 and attempt < max_retries:
                time.sleep(2 ** attempt)
                continue
            return None
        except httpx.HTTPError:
            return None
    return None


def fetch_company(cik: str) -> dict | None:
    """Fetch company submissions by CIK. CIK must be zero-padded to 10 digits."""
    cik_padded = str(cik).zfill(10)
    url = f"{BASE}/submissions/CIK{cik_padded}.json"
    r = _get_with_retry(url)
    return r.json() if r else None


def search_cik(company_name: str) -> str | None:
    """Look up CIK by company name. Uses company_tickers (approximate match)."""
    url = "https://www.sec.gov/files/company_tickers.json"
    r = _get_with_retry(url)
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


def search_person_cik(person_name: str) -> str | None:
    """Look up CIK for an individual person (not company).

    Uses the EDGAR company/person search endpoint with owner=include.
    Returns the first matching CIK or None.
    """
    import logging
    logger = logging.getLogger("pebble.data_sources.sec")

    try:
        r = httpx.get(
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
    except Exception as e:
        logger.warning("Person CIK search failed for %s: %s", person_name, e)

    # Fallback: try company_tickers in case person is a well-known company figure
    return search_cik(person_name)
