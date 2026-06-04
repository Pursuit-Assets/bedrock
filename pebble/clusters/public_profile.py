"""Public Profile cluster — Wikipedia full profile + web search.

Lightest cluster (5 calls, 30s). Fetches Wikipedia first so other
clusters can reuse it via the shared ProspectResearchContext.
"""

from __future__ import annotations

import asyncio
import logging

from ..research_context import ProspectResearchContext
from .budget import ClusterBudget

logger = logging.getLogger("pebble.clusters.public_profile")


def _safe_result(val):
    """Convert exceptions to None, logging the error."""
    if isinstance(val, BaseException):
        logger.warning("Public profile cluster API call failed: %s", val)
        return None
    return val


async def run_public_profile_cluster(
    ctx: ProspectResearchContext,
    person_name: str,
    org_name: str,
    budget: ClusterBudget,
    client=None,
) -> list[dict]:
    """Run the public profile cluster.

    1. Wikipedia fetch_full_profile (if not in context from T1)
    2. Wikipedia org fallback (if personal article not found)
    3. Web search — boards + giving focused queries

    Returns list of claims.
    """
    from ..data_sources import fetch_full_profile
    from ..data_sources.web_search import search_person
    from ..claim_templates import claims_from_web_search

    budget.start()
    claims = []
    name = person_name or org_name or ""

    # --- Wikipedia (fetch early so other clusters can reuse) ---
    if not ctx.has_source("wiki_data") and budget.can_call():
        try:
            wiki_data = await fetch_full_profile(name)
            budget.record_call()

            # Org fallback if personal article not found
            if wiki_data is None and org_name and org_name != name and budget.can_call():
                wiki_data = await fetch_full_profile(org_name)
                if wiki_data:
                    wiki_data["fallback_source"] = "org_article"
                budget.record_call()

            ctx.add_source("wiki_data", wiki_data)
        except Exception as e:
            budget.failed_sources.append("wiki_data")
            logger.warning("Wikipedia fetch failed: %s", e)

    # --- Web search — targeted queries ---
    web_tasks = []
    web_keys = []

    if not ctx.has_source("web_search_boards") and budget.can_call():
        web_tasks.append(asyncio.to_thread(search_person, name, org_name, "boards"))
        web_keys.append("web_search_boards")

    if not ctx.has_source("web_search_giving") and budget.can_call():
        web_tasks.append(asyncio.to_thread(search_person, name, org_name, "giving"))
        web_keys.append("web_search_giving")

    if web_tasks:
        results = await asyncio.gather(*web_tasks, return_exceptions=True)
        for key, result in zip(web_keys, results):
            if isinstance(result, BaseException):
                logger.warning("Public profile cluster API call failed for %s: %s", key, result)
                budget.failed_sources.append(key)
            else:
                ctx.add_source(key, result)
            budget.record_call()

    # --- Build claims from web search ---
    web_boards = ctx.raw_data.get("web_search_boards") or []
    web_giving = ctx.raw_data.get("web_search_giving") or []
    all_web = web_boards + web_giving

    # Deduplicate by link
    seen_links = set()
    unique_web = []
    for r in all_web:
        link = r.get("link", "")
        if link and link not in seen_links:
            seen_links.add(link)
            unique_web.append(r)

    web_claims = claims_from_web_search(unique_web, person_name, client)
    claims.extend(web_claims)

    logger.info("Public profile cluster: %d claims, %d API calls",
                len(claims), budget.api_calls_used)
    return claims
