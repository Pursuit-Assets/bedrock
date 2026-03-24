"""T2 handler — Structured Intelligence. All sources + forager analysis.

Builds on T1's context if available — skips re-fetching sources T1 already got.
Skips quorum verification and Opus synthesis (those are T3-only).
Cost: ~$0.05/prospect. Speed: 15-30s.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional

from ..router import RouteResult
from ..research_context import get_or_create_context
from . import HandlerResponse

logger = logging.getLogger("pebble.handlers.tier2")


async def handle_t2(
    route: RouteResult,
    crm_bridge,
    client=None,
) -> HandlerResponse:
    """Run T2 (Structured Intelligence) for a single prospect.

    1. Check context for T1 data — skip already-fetched sources
    2. Fetch remaining sources in parallel
    3. Web search with targeted queries (boards, giving)
    4. Template claims + person-level extraction from org data
    5. Score source richness + activate foragers
    6. Sonnet synthesis → structured output across 5 dimensions
    """
    from ..orchestrator import (
        score_source_richness,
        activate_foragers,
        ProspectBudgetTracker,
        _noop,
        _safe_result,
    )
    from ..data_sources import (
        fetch_organization, search_organizations, fetch_company,
        search_contributions, search_filings, search_awards,
        fetch_full_profile, search_officers,
    )
    from ..data_sources.sec import search_cik
    from ..data_sources.web_search import search_person
    from ..claim_templates import (
        claims_from_fec, claims_from_usaspending, claims_from_opencorporates,
        claims_from_edgar_search, claims_from_wikipedia_infobox,
        claims_from_web_search, claims_from_usaspending_person,
    )

    person_name = route.entities.get("person_name", "")
    org_name = route.entities.get("org_name", "")
    crm_match = route.entities.get("crm_match")
    name = person_name or org_name or "Unknown"

    prospect_id = crm_match["id"] if crm_match else name.replace(" ", "_").lower()
    ctx = get_or_create_context(prospect_id, person_name, org_name)

    prospect = {
        "first_name": person_name.split()[0] if person_name else "",
        "last_name": " ".join(person_name.split()[1:]) if person_name else "",
        "organization": org_name,
        "organizations": [org_name] if org_name else [],
    }

    budget = ProspectBudgetTracker(prospect_id=name)

    # --- Fetch only sources NOT already in context ---
    primary_org = org_name

    # Phase 1: Independent fetches (skip what T1 already got)
    phase1_tasks = []
    phase1_keys = []

    if not ctx.has_source("wiki_data"):
        phase1_tasks.append(asyncio.to_thread(fetch_full_profile, name) if name else _noop())
        phase1_keys.append("wiki_data")

    if not ctx.has_source("oc_data"):
        phase1_tasks.append(asyncio.to_thread(search_officers, name) if name else _noop())
        phase1_keys.append("oc_data")

    if not ctx.has_source("fec_data"):
        phase1_tasks.append(asyncio.to_thread(search_contributions, name, 10) if name else _noop())
        phase1_keys.append("fec_data")

    # These are always new in T2 (T1 doesn't fetch them)
    phase1_tasks.append(asyncio.to_thread(search_organizations, primary_org) if primary_org else _noop())
    phase1_keys.append("ein_orgs")
    phase1_tasks.append(asyncio.to_thread(search_cik, primary_org) if primary_org else _noop())
    phase1_keys.append("cik_result")
    phase1_tasks.append(asyncio.to_thread(search_filings, name) if name else _noop())
    phase1_keys.append("edgar_data")
    phase1_tasks.append(asyncio.to_thread(search_awards, name) if name else _noop())
    phase1_keys.append("usa_data")

    # Web search — targeted queries for T2
    if not ctx.has_source("web_search_boards"):
        phase1_tasks.append(asyncio.to_thread(search_person, name, org_name, "boards"))
        phase1_keys.append("web_search_boards")
    if not ctx.has_source("web_search_giving"):
        phase1_tasks.append(asyncio.to_thread(search_person, name, org_name, "giving"))
        phase1_keys.append("web_search_giving")

    if phase1_tasks:
        results = await asyncio.gather(*phase1_tasks, return_exceptions=True)
        for key, result in zip(phase1_keys, results):
            ctx.add_source(key, _safe_result(result))

    logger.info("T2: %d sources fetched, %d from T1 context", len(phase1_tasks), len(ctx.raw_data) - len(phase1_tasks))

    # Phase 2: Dependent fetches (EIN/CIK)
    ein_orgs = ctx.raw_data.get("ein_orgs")
    cik_result = ctx.raw_data.get("cik_result")
    ein = (str(ein_orgs[0]["ein"]) if ein_orgs and isinstance(ein_orgs, list) and ein_orgs[0].get("ein") else None)
    cik_val = cik_result

    if not ctx.has_source("propublica_data") or not ctx.has_source("sec_data"):
        phase2 = await asyncio.gather(
            asyncio.to_thread(fetch_organization, ein) if ein and not ctx.has_source("propublica_data") else _noop(),
            asyncio.to_thread(fetch_company, cik_val) if cik_val and not ctx.has_source("sec_data") else _noop(),
            return_exceptions=True,
        )
        if not ctx.has_source("propublica_data"):
            ctx.add_source("propublica_data", _safe_result(phase2[0]))
        if not ctx.has_source("sec_data"):
            ctx.add_source("sec_data", _safe_result(phase2[1]))

    # --- Build claims from NEW sources only ---
    new_claims = []

    # Only build claims for sources T1 didn't already process
    if not ctx.tier_completed("T1"):
        new_claims.extend(claims_from_wikipedia_infobox(ctx.raw_data.get("wiki_data")))
        new_claims.extend(claims_from_opencorporates(ctx.raw_data.get("oc_data") or []))
        new_claims.extend(claims_from_fec(ctx.raw_data.get("fec_data") or []))

    # T2-specific sources (always new)
    new_claims.extend(claims_from_edgar_search(ctx.raw_data.get("edgar_data") or []))
    new_claims.extend(claims_from_usaspending(ctx.raw_data.get("usa_data") or []))

    # Person-level extraction from org data
    new_claims.extend(claims_from_usaspending_person(
        ctx.raw_data.get("usa_data") or [], person_name, org_name
    ))

    # Web search claims — boards + giving focused queries
    web_boards = ctx.raw_data.get("web_search_boards") or []
    web_giving = ctx.raw_data.get("web_search_giving") or []
    all_web = web_boards + web_giving
    # Deduplicate by link
    seen_links = set()
    # Include T1's general web results too
    t1_web = ctx.raw_data.get("web_search_data") or []
    for r in t1_web + all_web:
        link = r.get("link", "")
        if link not in seen_links:
            seen_links.add(link)

    web_claims = claims_from_web_search(all_web, person_name, client)
    new_claims.extend(web_claims)

    ctx.add_claims(new_claims)

    # --- Score source richness and activate foragers ---
    source_scores = score_source_richness(
        ctx.raw_data.get("propublica_data"),
        ctx.raw_data.get("sec_data"),
        ctx.raw_data.get("fec_data"),
        ctx.raw_data.get("edgar_data"),
        ctx.raw_data.get("usa_data"),
        ctx.raw_data.get("wiki_data"),
        ctx.raw_data.get("oc_data"),
    )
    ctx.source_scores = source_scores

    forager_claims = []
    if client:
        try:
            forager_claims = await activate_foragers(
                source_scores,
                {
                    "fec_data": ctx.raw_data.get("fec_data"),
                    "oc_data": ctx.raw_data.get("oc_data"),
                    "usa_data": ctx.raw_data.get("usa_data"),
                    "propublica_data": ctx.raw_data.get("propublica_data"),
                    "edgar_data": ctx.raw_data.get("edgar_data"),
                    "wiki_data": ctx.raw_data.get("wiki_data"),
                },
                prospect, client, budget,
            )
        except Exception as e:
            logger.warning("T2 forager activation failed: %s", e)

    ctx.forager_claims = forager_claims
    ctx.mark_tier_complete("T2")

    # --- Format output across 5 dimensions ---
    all_claims = ctx.all_claims()
    dimensions = _organize_by_dimension(all_claims)

    text_parts = [f"**Structured Intelligence: {name}**\n"]
    dim_labels = [
        "Giving Capacity", "Organizational Affiliations",
        "Board Positions & Leadership", "Wealth Sources & Financial Footprint",
        "Comparable Giving",
    ]
    for label, key in zip(dim_labels, ["giving", "affiliations", "boards", "wealth", "comparable"]):
        dim_claims = dimensions.get(key, [])
        if dim_claims:
            text_parts.append(f"\n**{label}** ({len(dim_claims)} findings)")
            for c in dim_claims[:5]:
                text_parts.append(f"  - {c['text']}")
        else:
            text_parts.append(f"\n**{label}**: No data found")

    text_parts.append(f"\n{len(all_claims)} total claims from {len(source_scores)} sources.")

    return HandlerResponse(
        text="\n".join(text_parts),
        level=20,
        intent=route.intent,
        cost_usd=budget.total_cost_usd,
        data={
            "dimensions": dimensions,
            "claims_count": len(all_claims),
            "source_scores": source_scores,
        },
        sources=[c.get("source_url", "") for c in all_claims if c.get("source_url")][:15],
    )


def _organize_by_dimension(claims: list[dict]) -> dict[str, list[dict]]:
    """Organize claims into the 5 research dimensions by keyword matching."""
    dimensions: dict[str, list[dict]] = {
        "giving": [], "affiliations": [], "boards": [],
        "wealth": [], "comparable": [],
    }
    giving_kw = {"contribut", "donat", "fec", "giving", "grant", "philanthrop", "gift"}
    board_kw = {"board", "director", "trustee", "advisory", "governor", "committee"}
    wealth_kw = {"sec", "edgar", "filing", "award", "contract", "federal", "revenue", "asset", "net worth"}
    affil_kw = {"officer", "president", "ceo", "cfo", "cto", "vp", "manager", "founder", "co-founder",
                "title", "employ", "executive", "leader", "chief"}

    for claim in claims:
        text_lower = claim.get("text", "").lower()
        url_lower = claim.get("source_url", "").lower()

        if any(k in text_lower or k in url_lower for k in giving_kw):
            dimensions["giving"].append(claim)
        elif any(k in text_lower for k in board_kw):
            dimensions["boards"].append(claim)
        elif any(k in text_lower or k in url_lower for k in wealth_kw):
            dimensions["wealth"].append(claim)
        elif any(k in text_lower for k in affil_kw):
            dimensions["affiliations"].append(claim)
        else:
            dimensions["affiliations"].append(claim)

    # --- Per-dimension: sort by recency, tag age, cap to 5 ---
    now = datetime.now()
    old_cutoff = (now - timedelta(days=3650)).strftime("%Y")      # ~10 years
    very_old_cutoff = (now - timedelta(days=7300)).strftime("%Y")  # ~20 years

    def _sort_key(claim):
        """Sort by data_as_of descending. None sorts last."""
        d = claim.get("data_as_of")
        return d if d else ""

    for key in dimensions:
        sorted_claims = sorted(dimensions[key], key=_sort_key, reverse=True)
        for c in sorted_claims:
            d = c.get("data_as_of")
            if d:
                year = d[:4]
                if year < very_old_cutoff:
                    c["data_age"] = "very_old"
                elif year < old_cutoff:
                    c["data_age"] = "old"
        dimensions[key] = sorted_claims[:5]

    return dimensions
