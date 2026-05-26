"""ProPublica Nonprofit Explorer API v2. GET /organizations/:ein.json

Also: IRS 990 XML download from S3 + officer parsing.

P1 — native async via _http.get_with_retry. XML parsing functions
remain sync since they're CPU-bound (no I/O).
"""

from __future__ import annotations

import logging
import xml.etree.ElementTree as ET

from ._http import get_with_retry

logger = logging.getLogger("pebble.data_sources.propublica")

BASE = "https://projects.propublica.org/nonprofits/api/v2"


async def fetch_organization(ein: str) -> dict | None:
    """Fetch org data by EIN. Returns None on 404 or error."""
    url = f"{BASE}/organizations/{ein}.json"
    r = await get_with_retry(url)
    return r.json() if r else None


async def search_organizations(query: str, state: str | None = None) -> list[dict]:
    """Search organizations by name. Returns list of orgs."""
    params: dict = {"q": query}
    if state:
        params["state[id]"] = state
    r = await get_with_retry(f"{BASE}/search.json", params=params)
    if not r:
        return []
    return r.json().get("organizations", [])


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


# ---------------------------------------------------------------------------
# 990 XML download + officer parsing (Sprint 4)
# ---------------------------------------------------------------------------

_IRS_S3_BASE = "https://s3.amazonaws.com/irs-form-990"

# IRS e-file XML namespace variants (varies by schema year)
_IRS_NAMESPACES = [
    "urn:us:gov:treasury:irs:ext:efile",
    "http://www.irs.gov/efile",
]


def get_latest_object_id(org_data: dict | None) -> str | None:
    """Extract the latest filing object_id from a ProPublica org response.

    The field lives on the top-level organization object, NOT on individual
    filings_with_data entries. Returns None if the field is absent.
    """
    if not org_data:
        return None
    return org_data.get("organization", {}).get("latest_object_id")


async def download_990_xml(object_id: str) -> str | None:
    """Download a 990 XML filing from IRS S3 by object_id.

    Checks the api_cache first (30-day TTL). Returns the raw XML string
    or None on failure.
    """
    from ..storage.cache import get_cached, set_cached

    cached = get_cached("propublica_990_xml", object_id)
    if cached is not None:
        logger.info("990 XML cache hit: object_id=%s", object_id)
        return cached.get("xml")

    url = f"{_IRS_S3_BASE}/{object_id}_public.xml"
    r = await get_with_retry(url)
    if not r:
        logger.warning("990 XML download failed: object_id=%s", object_id)
        return None

    xml_text = r.text
    set_cached("propublica_990_xml", object_id, {"xml": xml_text}, ttl_seconds=2_592_000)
    logger.info("990 XML downloaded and cached: object_id=%s (%d bytes)", object_id, len(xml_text))
    return xml_text


def parse_officers_from_xml(xml_content: str) -> list[dict]:
    """Parse officers from IRS 990 XML (Part VII, Section A).

    Handles multiple namespace variants used across filing years.
    Returns list of {name, title, hours_per_week, compensation, other_compensation}.
    """
    if not xml_content:
        return []

    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError as e:
        logger.warning("990 XML parse error: %s", e)
        return []

    officers = []

    # Try each namespace variant, plus bare (no namespace)
    tag_patterns = [
        f"{{{ns}}}Form990PartVIISectionAGrp" for ns in _IRS_NAMESPACES
    ] + ["Form990PartVIISectionAGrp"]

    elements = []
    for pattern in tag_patterns:
        elements = root.iter(pattern)
        # iter() returns a generator — peek to check if any exist
        first = next(elements, None)
        if first is not None:
            elements = [first] + list(elements)
            break
    else:
        # Also try with .//, which traverses all descendants
        for pattern in tag_patterns:
            found = root.findall(f".//{pattern}")
            if found:
                elements = found
                break

    if not elements:
        return []

    for elem in elements:
        officer = _extract_officer_fields(elem, root)
        if officer.get("name"):
            officers.append(officer)

    return officers


def _extract_officer_fields(elem: ET.Element, root: ET.Element) -> dict:
    """Extract officer fields from a Form990PartVIISectionAGrp element.

    Tries namespaced and bare tag names for each field.
    """
    fields = {
        "name": ["PersonNm", "BusinessNameLine1Txt"],
        "title": ["TitleTxt"],
        "hours_per_week": ["AverageHoursPerWeekRt"],
        "compensation": ["ReportableCompFromOrgAmt"],
        "other_compensation": ["OtherCompensationAmt"],
    }

    result: dict = {}
    for key, tag_names in fields.items():
        value = None
        for tag in tag_names:
            # Try bare
            child = elem.find(tag)
            if child is not None and child.text:
                value = child.text.strip()
                break
            # Try with each namespace
            for ns in _IRS_NAMESPACES:
                child = elem.find(f"{{{ns}}}{tag}")
                if child is not None and child.text:
                    value = child.text.strip()
                    break
            if value:
                break

        if key in ("compensation", "other_compensation", "hours_per_week"):
            try:
                value = float(value) if value else 0.0
            except (ValueError, TypeError):
                value = 0.0

        result[key] = value

    return result
