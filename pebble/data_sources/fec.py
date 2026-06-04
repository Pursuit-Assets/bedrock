"""FEC OpenFEC API. API key required (DEMO_KEY for testing).

P1 — native async via the shared client in _http.py. The legacy
``asyncio.to_thread(search_contributions, ...)`` callsite pattern is
replaced by direct ``await search_contributions(...)``; under
concurrent batch load this eliminates threadpool serialization.
"""

from __future__ import annotations

import os

from ._http import get_with_retry

BASE = "https://api.open.fec.gov/v1"


def _api_key() -> str:
    return os.getenv("FEC_API_KEY", "DEMO_KEY")


async def search_contributions(name: str, limit: int = 20) -> list[dict]:
    """Search individual contributions by contributor name (Schedule A)."""
    params = {
        "api_key": _api_key(),
        "contributor_name": name,
        "per_page": min(limit, 100),
    }
    r = await get_with_retry(f"{BASE}/schedules/schedule_a/", params=params)
    if not r:
        return []
    return r.json().get("results", [])


async def search_committees(
    name: str | None = None,
    treasurer_name: str | None = None,
    limit: int = 10,
) -> list[dict]:
    """Search FEC committees by name or treasurer name.

    If prospect is treasurer of a PAC, that's a major political involvement signal.
    Key fields: name, committee_type, treasurer_name, party, organization_type.
    """
    params: dict = {"api_key": _api_key(), "per_page": min(limit, 20)}
    if treasurer_name:
        params["treasurer_name"] = treasurer_name
    if name:
        params["q"] = name
    if not treasurer_name and not name:
        return []
    r = await get_with_retry(f"{BASE}/committees/", params=params)
    if not r:
        return []
    return r.json().get("results", [])


async def search_independent_expenditures(
    committee_id: str | None = None,
    candidate_id: str | None = None,
    limit: int = 10,
) -> list[dict]:
    """Search Schedule E independent expenditures.

    Shows PAC spending for/against candidates.
    Key fields: committee.name, expenditure_amount, candidate_name, support_oppose_indicator.
    """
    params: dict = {"api_key": _api_key(), "per_page": min(limit, 20)}
    if committee_id:
        params["committee_id"] = committee_id
    if candidate_id:
        params["candidate_id"] = candidate_id
    if not committee_id and not candidate_id:
        return []
    r = await get_with_retry(f"{BASE}/schedules/schedule_e/", params=params)
    if not r:
        return []
    return r.json().get("results", [])


async def search_disbursements(committee_id: str, limit: int = 10) -> list[dict]:
    """Search Schedule B disbursements for a committee.

    Shows where political money flows TO.
    Key fields: recipient_name, disbursement_amount, disbursement_purpose, committee.name.
    """
    params = {
        "api_key": _api_key(),
        "committee_id": committee_id,
        "per_page": min(limit, 20),
    }
    r = await get_with_retry(f"{BASE}/schedules/schedule_b/", params=params)
    if not r:
        return []
    return r.json().get("results", [])
