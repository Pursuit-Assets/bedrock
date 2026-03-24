"""FEC OpenFEC API. API key required (DEMO_KEY for testing)."""

import os
import time

import httpx

BASE = "https://api.open.fec.gov/v1"


def _api_key() -> str:
    return os.getenv("FEC_API_KEY", "DEMO_KEY")


def _get_with_retry(url: str, params: dict, max_retries: int = 2) -> httpx.Response | None:
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


def search_contributions(name: str, limit: int = 20) -> list[dict]:
    """Search individual contributions by contributor name (Schedule A)."""
    params = {
        "api_key": _api_key(),
        "contributor_name": name,
        "per_page": min(limit, 100),
    }
    r = _get_with_retry(f"{BASE}/schedules/schedule_a/", params=params)
    if not r:
        return []
    data = r.json()
    return data.get("results", [])


def search_committees(
    name: str | None = None,
    treasurer_name: str | None = None,
    limit: int = 10,
) -> list[dict]:
    """Search FEC committees by name or treasurer name.

    If prospect is treasurer of a PAC, that's a major political involvement signal.
    Key fields: name, committee_type, treasurer_name, party, organization_type.
    """
    params = {"api_key": _api_key(), "per_page": min(limit, 20)}
    if treasurer_name:
        params["treasurer_name"] = treasurer_name
    if name:
        params["q"] = name
    if not treasurer_name and not name:
        return []
    r = _get_with_retry(f"{BASE}/committees/", params=params)
    if not r:
        return []
    data = r.json()
    return data.get("results", [])


def search_independent_expenditures(
    committee_id: str | None = None,
    candidate_id: str | None = None,
    limit: int = 10,
) -> list[dict]:
    """Search Schedule E independent expenditures.

    Shows PAC spending for/against candidates.
    Key fields: committee.name, expenditure_amount, candidate_name, support_oppose_indicator.
    """
    params = {"api_key": _api_key(), "per_page": min(limit, 20)}
    if committee_id:
        params["committee_id"] = committee_id
    if candidate_id:
        params["candidate_id"] = candidate_id
    if not committee_id and not candidate_id:
        return []
    r = _get_with_retry(f"{BASE}/schedules/schedule_e/", params=params)
    if not r:
        return []
    data = r.json()
    return data.get("results", [])


def search_disbursements(committee_id: str, limit: int = 10) -> list[dict]:
    """Search Schedule B disbursements for a committee.

    Shows where political money flows TO.
    Key fields: recipient_name, disbursement_amount, disbursement_purpose, committee.name.
    """
    params = {
        "api_key": _api_key(),
        "committee_id": committee_id,
        "per_page": min(limit, 20),
    }
    r = _get_with_retry(f"{BASE}/schedules/schedule_b/", params=params)
    if not r:
        return []
    data = r.json()
    return data.get("results", [])
