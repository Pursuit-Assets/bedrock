"""Financial cluster — FEC, ProPublica 990, USAspending, EDGAR, FINRA, SEC.

Handles all wealth-signal and financial data sources. Reads SourceConfig
to decide which sources to query, and respects ClusterBudget limits.
"""

from __future__ import annotations

import asyncio
import logging

from ..research_context import ProspectResearchContext
from .source_router import SourceConfig
from .budget import ClusterBudget

logger = logging.getLogger("pebble.clusters.financial")


def _safe_result(val):
    """Convert exceptions to None, logging the error."""
    if isinstance(val, BaseException):
        logger.warning("Financial cluster API call failed: %s", val)
        return None
    return val


async def run_financial_cluster(
    ctx: ProspectResearchContext,
    person_name: str,
    org_name: str,
    source_config: SourceConfig,
    budget: ClusterBudget,
) -> list[dict]:
    """Run the financial research cluster.

    Phase 1: Independent fetches (FEC, USAspending, FINRA, EDGAR search)
    Phase 2: Dependent fetches (ProPublica after EIN, SEC after CIK, Form 4 after person CIK)

    Returns list of claims.
    """
    from ..data_sources import (
        search_contributions, search_committees,
        fetch_organization, search_organizations, extract_org_financials,
        fetch_company, search_awards, search_filings,
    )
    from ..data_sources.sec import search_cik
    from ..data_sources.finra import search_individual
    from ..claim_templates import (
        claims_from_fec_summary, claims_from_fec_committees,
        claims_from_usaspending, claims_from_usaspending_person,
        claims_from_edgar_search, claims_from_insider_transactions,
        claims_from_org_financials, claims_from_finra,
    )

    budget.start()
    claims = []
    limits = source_config.search_limits
    name = person_name or org_name or ""

    # --- Phase 1: Independent parallel fetches ---
    phase1_tasks = []
    phase1_keys = []

    # FEC Core
    if source_config.fec_core and not ctx.has_source("fec_data") and budget.can_call():
        fec_limit = limits.get("fec_core", 10)
        phase1_tasks.append(asyncio.to_thread(search_contributions, name, fec_limit))
        phase1_keys.append("fec_data")

    # USAspending ("yes" or "conditional" — conditional checks handled below)
    if source_config.usaspending != "skip" and not ctx.has_source("usa_data") and budget.can_call():
        usa_limit = limits.get("usaspending", 10)
        phase1_tasks.append(asyncio.to_thread(search_awards, name, usa_limit))
        phase1_keys.append("usa_data")

    # FINRA
    if source_config.finra and not ctx.has_source("finra_data") and budget.can_call():
        phase1_tasks.append(asyncio.to_thread(search_individual, name))
        phase1_keys.append("finra_data")

    # EDGAR full-text search ("yes" = always, "conditional" = deferred to phase 2)
    if source_config.edgar_search == "yes" and not ctx.has_source("edgar_data") and budget.can_call():
        edgar_limit = limits.get("edgar_search", 10)
        phase1_tasks.append(asyncio.to_thread(search_filings, name, edgar_limit))
        phase1_keys.append("edgar_data")

    # ProPublica org search (to get EIN) — "yes" or "conditional"
    if source_config.propublica != "skip" and not ctx.has_source("propublica_data") and org_name and budget.can_call():
        phase1_tasks.append(asyncio.to_thread(search_organizations, org_name))
        phase1_keys.append("ein_orgs")

    # SEC CIK lookup (for company filings)
    if source_config.sec_company != "skip" and not ctx.has_source("sec_data") and org_name and budget.can_call():
        phase1_tasks.append(asyncio.to_thread(search_cik, org_name))
        phase1_keys.append("cik_result")

    if phase1_tasks:
        results = await asyncio.gather(*phase1_tasks, return_exceptions=True)
        for key, result in zip(phase1_keys, results):
            if isinstance(result, BaseException):
                logger.warning("Financial cluster API call failed for %s: %s", key, result)
                budget.failed_sources.append(key)
            else:
                ctx.add_source(key, result)
            budget.record_call()

    logger.info("Financial cluster phase 1: %d sources fetched", len(phase1_tasks))

    # --- Phase 2: Dependent fetches ---
    phase2_tasks = []
    phase2_keys = []

    # ProPublica org detail (needs EIN from phase 1)
    if source_config.propublica != "skip" and not ctx.has_source("propublica_data") and budget.can_call():
        ein_orgs = ctx.raw_data.get("ein_orgs")
        ein = (str(ein_orgs[0]["ein"]) if ein_orgs and isinstance(ein_orgs, list)
               and len(ein_orgs) > 0 and ein_orgs[0].get("ein") else None)
        if ein:
            phase2_tasks.append(asyncio.to_thread(fetch_organization, ein))
            phase2_keys.append("propublica_data")

    # SEC company detail (needs CIK from phase 1)
    if source_config.sec_company != "skip" and not ctx.has_source("sec_data") and budget.can_call():
        cik_val = ctx.raw_data.get("cik_result")
        if cik_val:
            phase2_tasks.append(asyncio.to_thread(fetch_company, cik_val))
            phase2_keys.append("sec_data")

    # EDGAR Form 4 (needs person CIK — search for person specifically)
    if source_config.edgar_form4 and not ctx.has_source("insider_data") and person_name and budget.can_call():
        form4_limit = limits.get("edgar_form4", 5)
        phase2_tasks.append(asyncio.to_thread(
            _fetch_form4, person_name, form4_limit
        ))
        phase2_keys.append("insider_data")

    # EDGAR search — conditional: only if CIK was found (for GOVERNMENT, FOUNDATION, etc.)
    if source_config.edgar_search == "conditional" and not ctx.has_source("edgar_data") and budget.can_call():
        cik_val = ctx.raw_data.get("cik_result")
        if cik_val:
            edgar_limit = limits.get("edgar_search", 10)
            phase2_tasks.append(asyncio.to_thread(search_filings, name, edgar_limit))
            phase2_keys.append("edgar_data")
            logger.info("Conditional EDGAR search activated — CIK found")

    # FEC Extended (conditional on FEC core having data)
    if source_config.fec_extended == "yes" or (
        source_config.fec_extended == "conditional" and ctx.raw_data.get("fec_data")
    ):
        if not ctx.has_source("fec_committees_data") and person_name and budget.can_call():
            fec_ext_limit = limits.get("fec_extended", 5)
            phase2_tasks.append(search_committees(None, person_name, fec_ext_limit))
            phase2_keys.append("fec_committees_data")

    if phase2_tasks:
        results = await asyncio.gather(*phase2_tasks, return_exceptions=True)
        for key, result in zip(phase2_keys, results):
            if isinstance(result, BaseException):
                logger.warning("Financial cluster API call failed for %s: %s", key, result)
                budget.failed_sources.append(key)
            else:
                ctx.add_source(key, result)
            budget.record_call()

    logger.info("Financial cluster phase 2: %d sources fetched", len(phase2_tasks))

    # --- Build claims ---
    # FEC summary claims (aggregated, not per-donation)
    claims.extend(claims_from_fec_summary(ctx.raw_data.get("fec_data") or []))

    # FEC committees
    claims.extend(claims_from_fec_committees(
        ctx.raw_data.get("fec_committees_data"), person_name
    ))

    # EDGAR search
    claims.extend(claims_from_edgar_search(ctx.raw_data.get("edgar_data") or []))

    # Insider transactions (Form 4)
    claims.extend(claims_from_insider_transactions(ctx.raw_data.get("insider_data") or []))

    # USAspending
    claims.extend(claims_from_usaspending(ctx.raw_data.get("usa_data") or []))
    claims.extend(claims_from_usaspending_person(
        ctx.raw_data.get("usa_data") or [], person_name, org_name
    ))

    # ProPublica 990 org financials
    propublica_data = ctx.raw_data.get("propublica_data")
    if propublica_data:
        financials = extract_org_financials(propublica_data)
        if financials:
            ctx.add_source("org_financials", financials)
            claims.extend(claims_from_org_financials(financials, person_name))

    # FINRA
    claims.extend(claims_from_finra(
        ctx.raw_data.get("finra_data"), person_name
    ))

    logger.info("Financial cluster: %d claims built, %d API calls used",
                len(claims), budget.api_calls_used)
    return claims


def _fetch_form4(person_name: str, limit: int = 5) -> list[dict]:
    """Fetch Form 4 filings for a person via EDGAR EFTS.

    Step 1: Resolve person → CIK via doc text search
    Step 2: Search Form 4 filings by that CIK
    """
    from ..data_sources.sec import search_person_cik
    from ..data_sources.edgar_search import search_filings

    person_cik = search_person_cik(person_name)
    if not person_cik:
        return []

    return search_filings(person_name, limit=limit, forms="4", cik=person_cik)
