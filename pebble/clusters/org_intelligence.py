"""Org intelligence — investigate organizations discovered during research.

Sprint 4 module. Runs after cluster research for T3 to:
1. Collect connected orgs from affiliation + financial cluster data
2. Deduplicate and rank by data richness
3. Resolve name → EIN via ProPublica search
4. Cross-reference against CRM (Salesforce accounts)
5. Download and parse 990 XML for top org's officers
6. Return recommendations + officer claims
"""

from __future__ import annotations

import asyncio
import logging

from ..research_context import ProspectResearchContext
from .budget import ClusterBudget

logger = logging.getLogger("pebble.clusters.org_intelligence")


async def investigate_connected_orgs(
    ctx: ProspectResearchContext,
    person_name: str,
    crm_bridge,
    budget: ClusterBudget,
    max_orgs: int = 5,
    enable_xml: bool = True,
) -> tuple[list[dict], list[dict]]:
    """Investigate organizations connected to the research subject.

    Returns (recommendations, officer_claims).
    - recommendations: list of dicts suitable for ResearchRecommendation
    - officer_claims: list of claim dicts from 990 XML officer parsing
    """
    from ..data_sources.propublica import (
        search_organizations, fetch_organization,
        download_990_xml, parse_officers_from_xml,
        get_latest_object_id, extract_org_financials,
    )
    from ..claim_templates import claims_from_org_officers

    budget.start()
    recommendations = []
    officer_claims = []

    # --- 1. Collect orgs from cluster data ---
    orgs = _collect_connected_orgs(ctx)
    if not orgs:
        logger.info("Org intelligence: no connected orgs found")
        return recommendations, officer_claims

    # --- 2. Deduplicate by name ---
    orgs = _deduplicate_orgs(orgs)

    # --- 3. Rank ---
    orgs = _rank_orgs(orgs)

    # --- 4. Investigate top N ---
    xml_fetched = False

    for org_entry in orgs[:max_orgs]:
        if not budget.can_call():
            logger.info("Org intelligence: budget exhausted after %d calls", budget.api_calls_used)
            break

        org_name = org_entry["name"]
        relationship = org_entry.get("relationship", "affiliated")

        # Resolve name → EIN via ProPublica search
        ein = org_entry.get("ein")
        org_data = None

        if not ein:
            try:
                search_results = await search_organizations(org_name)
                budget.record_call()
                if search_results:
                    ein = str(search_results[0].get("ein", ""))
            except Exception as e:
                logger.warning("Org intelligence: search failed for %s: %s", org_name, e)
                budget.record_call()

        # Fetch full org data if we have an EIN
        if ein and budget.can_call():
            try:
                org_data = await fetch_organization(ein)
                budget.record_call()
            except Exception as e:
                logger.warning("Org intelligence: fetch failed for EIN %s: %s", ein, e)
                budget.record_call()

        # CRM cross-reference
        crm_match = None
        if crm_bridge is not None and budget.can_call():
            try:
                accounts = await crm_bridge.search_accounts(org_name, limit=3)
                budget.record_call()
                if accounts:
                    crm_match = accounts[0]  # Best match
            except Exception as e:
                logger.warning("Org intelligence: CRM search failed for %s: %s", org_name, e)
                budget.record_call()

        # Build recommendation
        financials = extract_org_financials(org_data) if org_data else None
        rationale = _build_rationale(person_name, org_name, relationship, financials, crm_match)

        recommendation = {
            "recommendation_type": "investigate_org",
            "entity_name": org_name,
            "entity_type": "organization",
            "rationale": rationale,
            "supporting_claims": [],
            "priority": _assess_priority(financials, crm_match),
            "status": "pending",
            "crm_match": crm_match,
            "metadata": {
                "ein": ein or "",
                "relationship": relationship,
                "source": org_entry.get("source", "unknown"),
            },
        }

        if financials:
            recommendation["metadata"]["revenue"] = financials.get("revenue")
            recommendation["metadata"]["total_assets"] = financials.get("total_assets")

        recommendations.append(recommendation)

        # --- 5. XML officer parsing (top 1 org only) ---
        if enable_xml and org_data and not xml_fetched and budget.can_call():
            object_id = get_latest_object_id(org_data)
            if object_id:
                try:
                    xml_content = await download_990_xml(object_id)
                    budget.record_call()
                    if xml_content:
                        officers = parse_officers_from_xml(xml_content)
                        if officers:
                            tax_year = financials.get("tax_year") if financials else ""
                            new_claims = claims_from_org_officers(
                                officers, org_name, ein=ein or "", tax_year=tax_year,
                            )
                            officer_claims.extend(new_claims)
                            recommendation["supporting_claims"] = [
                                c["text"] for c in new_claims[:5]
                            ]
                            logger.info(
                                "Org intelligence: parsed %d officers from %s (object_id=%s)",
                                len(officers), org_name, object_id,
                            )
                    xml_fetched = True  # Only fetch XML for top 1 org
                except Exception as e:
                    logger.warning("Org intelligence: XML parse failed for %s: %s", org_name, e)
                    budget.record_call()
                    xml_fetched = True  # Don't retry on next org
            else:
                logger.info("Org intelligence: no latest_object_id for %s, skipping XML", org_name)

    logger.info(
        "Org intelligence: %d recommendations, %d officer claims, %d API calls",
        len(recommendations), len(officer_claims), budget.api_calls_used,
    )
    return recommendations, officer_claims


def _collect_connected_orgs(ctx: ProspectResearchContext) -> list[dict]:
    """Collect orgs from multiple cluster data sources."""
    orgs = []
    seen = set()

    # From affiliation cluster (OpenCorporates + Wikipedia)
    for org in (ctx.raw_data.get("connected_orgs") or []):
        name = org.get("name", "")
        if name and name.lower() not in seen:
            seen.add(name.lower())
            orgs.append(org)

    # From financial cluster (ProPublica org search results)
    for org in (ctx.raw_data.get("ein_orgs") or []):
        name = org.get("name", "")
        if name and name.lower() not in seen:
            seen.add(name.lower())
            orgs.append({
                "name": name,
                "source": "propublica",
                "relationship": "affiliated",
                "ein": str(org.get("ein", "")),
            })

    return orgs


def _deduplicate_orgs(orgs: list[dict]) -> list[dict]:
    """Deduplicate orgs by name (case-insensitive). First occurrence wins."""
    seen = set()
    unique = []
    for org in orgs:
        key = org["name"].lower().strip()
        if key not in seen:
            seen.add(key)
            unique.append(org)
    return unique


def _rank_orgs(orgs: list[dict]) -> list[dict]:
    """Rank orgs: has EIN > no EIN, then alphabetical as tiebreaker."""
    def _sort_key(org):
        has_ein = 1 if org.get("ein") else 0
        return (-has_ein, org["name"].lower())
    return sorted(orgs, key=_sort_key)


def _build_rationale(
    person_name: str,
    org_name: str,
    relationship: str,
    financials: dict | None,
    crm_match: dict | None,
) -> str:
    """Build a human-readable rationale for the recommendation."""
    parts = [f"{person_name} is connected to {org_name} ({relationship})"]

    if financials:
        revenue = financials.get("revenue")
        if revenue is not None:
            parts.append(f"revenue ${revenue:,.0f}")
        assets = financials.get("total_assets")
        if assets is not None:
            parts.append(f"assets ${assets:,.0f}")

    if crm_match:
        parts.append(f"CRM match: {crm_match.get('Name', 'found')}")
    else:
        parts.append("not in CRM")

    return "; ".join(parts)


def _assess_priority(financials: dict | None, crm_match: dict | None) -> str:
    """Assess recommendation priority based on data signals."""
    if crm_match:
        return "high"  # Already in CRM — worth investigating
    if financials:
        revenue = financials.get("revenue") or 0
        if revenue > 10_000_000:
            return "high"
        if revenue > 1_000_000:
            return "medium"
    return "low"
