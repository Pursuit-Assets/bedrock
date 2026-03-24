"""Federal Register API. Free, no auth. Government appointments and regulatory actions."""

import logging

import httpx

logger = logging.getLogger("pebble.data_sources.federal_register")

BASE = "https://www.federalregister.gov/api/v1"


def search_documents(
    term: str,
    doc_type: str | None = None,
    limit: int = 10,
) -> list[dict]:
    """Search Federal Register documents by term.

    Args:
        term: Search term (person name or org name)
        doc_type: Optional filter — "PRESDOCU" for presidential documents,
                  "NOTICE" for notices, "RULE" for rules
        limit: Max results (capped at 20)

    Each result has: title, type, abstract, document_number,
    html_url, pdf_url, publication_date, agencies[] (name, id),
    excerpts (HTML with match highlights)
    """
    params = {
        "conditions[term]": term,
        "per_page": min(limit, 20),
        "order": "newest",
    }
    if doc_type:
        params["conditions[type][]"] = doc_type

    try:
        r = httpx.get(f"{BASE}/documents.json", params=params, timeout=15.0)
        r.raise_for_status()
        data = r.json()
        return data.get("results", [])
    except httpx.HTTPError as e:
        logger.warning("Federal Register API error: %s", e)
        return []
