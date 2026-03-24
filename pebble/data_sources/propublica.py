"""ProPublica Nonprofit Explorer API v2. GET /organizations/:ein.json"""

import time

import httpx

BASE = "https://projects.propublica.org/nonprofits/api/v2"


def _get_with_retry(url: str, params: dict | None = None, max_retries: int = 2) -> httpx.Response | None:
    """GET with retry on 429 (rate limit). Returns None on error."""
    for attempt in range(max_retries + 1):
        try:
            r = httpx.get(url, params=params, timeout=30.0)
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


def fetch_organization(ein: str) -> dict | None:
    """Fetch org data by EIN. Returns None on 404 or error."""
    url = f"{BASE}/organizations/{ein}.json"
    r = _get_with_retry(url)
    return r.json() if r else None


def search_organizations(query: str, state: str | None = None) -> list[dict]:
    """Search organizations by name. Returns list of orgs."""
    params = {"q": query}
    if state:
        params["state[id]"] = state
    r = _get_with_retry(f"{BASE}/search.json", params=params)
    if not r:
        return []
    data = r.json()
    return data.get("organizations", [])


def extract_org_financials(org_data: dict | None) -> dict | None:
    """Extract key financials from the most recent filing in filings_with_data[].

    The ProPublica org endpoint (GET /organizations/{ein}.json) returns
    filings_with_data[] containing IRS annual extract fields. This function
    pulls the most recent filing's financial data.

    Returns dict with named fields or None if no filing data available.
    """
    if not org_data:
        return None

    filings = org_data.get("filings_with_data", [])
    if not filings:
        return None

    # Most recent filing is first in list
    f = filings[0]
    org = org_data.get("organization", {})

    return {
        "org_name": org.get("name", ""),
        "ein": str(org.get("ein", "")),
        "tax_year": f.get("tax_prd_yr"),
        "tax_period": f.get("tax_prd"),
        "form_type": {0: "990", 1: "990-EZ", 2: "990-PF"}.get(f.get("formtype"), "990"),
        "revenue": f.get("totrevenue"),
        "expenses": f.get("totfuncexpns"),
        "total_assets": f.get("totassetsend"),
        "total_liabilities": f.get("totliabend"),
        "net_assets": f.get("totnetassetend"),
        "contributions_and_grants": f.get("totcntrbgfts"),
        "program_service_revenue": f.get("totprgmrevnue"),
        "officer_compensation_total": f.get("compnsatncurrofcr"),
        "investment_income": f.get("invstmntinc"),
    }
