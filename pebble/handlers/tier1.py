"""T1 handler — ID & Triage. CRM check + web search + 3 data sources + Haiku.

Cost: ~$0.01/prospect. Speed: 5-10s.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from ..router import RouteResult
from ..research_context import get_or_create_context
from . import HandlerResponse

logger = logging.getLogger("pebble.handlers.tier1")


async def handle_t1(
    route: RouteResult,
    crm_bridge,
    client=None,
    user_email: str | None = None,
) -> HandlerResponse:
    """Run T1 (ID & Triage) for a single prospect.

    1. CRM check via bridge
    2. Parallel: Web search, Wikipedia (with org fallback), OpenCorporates, FEC
    3. LLM extraction from web search snippets
    4. Template claims from structured sources
    5. Single Haiku call for identity assessment
    """
    from ..data_sources import fetch_full_profile, search_officers, search_contributions
    from ..data_sources.web_search import search_person
    from ..claim_templates import (
        claims_from_wikipedia_infobox,
        claims_from_opencorporates,
        claims_from_fec,
        claims_from_web_search,
    )

    person_name = route.entities.get("person_name", "")
    org_name = route.entities.get("org_name", "")
    crm_match = route.entities.get("crm_match")
    name = person_name or org_name or "Unknown"
    cost = 0.0

    # Get or create research context for tier data sharing
    prospect_id = crm_match["id"] if crm_match else name.replace(" ", "_").lower()
    ctx = get_or_create_context(prospect_id, person_name, org_name)

    # CRM status
    crm_status = "in_crm" if crm_match else "not_in_crm"
    crm_info = ""
    if crm_match:
        crm_info = f"CRM: {crm_match['name']} ({crm_match['type']})"

    # Parallel data fetches (4 sources: web search + 3 structured)
    agents_log: list[dict] = []

    async def _timed_fetch(fetch_name: str, coro) -> any:
        """Run a fetch coroutine, record timing and outcome to agents_log."""
        t0 = time.time()
        try:
            result = await coro
            records = None
            if isinstance(result, list):
                records = len(result)
            elif isinstance(result, dict):
                records = 1
            agents_log.append({
                "name": fetch_name,
                "outcome": "success" if result is not None else "no_data",
                "elapsed_seconds": round(time.time() - t0, 3),
                "cost_usd": 0.0,
                "tokens_input": 0, "tokens_output": 0,
                "attempts": 1,
                "error": None,
                "records_found": records if result is not None else 0,
            })
            return result
        except Exception as e:
            agents_log.append({
                "name": fetch_name,
                "outcome": "error",
                "elapsed_seconds": round(time.time() - t0, 3),
                "cost_usd": 0.0,
                "tokens_input": 0, "tokens_output": 0,
                "attempts": 1,
                "error": str(e)[:200],
                "records_found": None,
            })
            return None

    web_results, wiki_data, oc_data, fec_data = await asyncio.gather(
        _timed_fetch("web_search", asyncio.to_thread(search_person, name, org_name) if name else _noop()),
        _timed_fetch("wikipedia", asyncio.to_thread(fetch_full_profile, name) if name else _noop()),
        _timed_fetch("opencorporates", asyncio.to_thread(search_officers, name) if name else _noop()),
        _timed_fetch("fec", search_contributions(name, 3) if name else _noop()),
    )
    web_results = web_results or []

    # Wikipedia org fallback — if no personal article, search for org
    if wiki_data is None and org_name:
        try:
            t0_wiki_fb = time.time()
            wiki_data = await asyncio.to_thread(fetch_full_profile, org_name)
            if wiki_data:
                wiki_data["fallback_source"] = "org_article"
                logger.info("T1: Wikipedia org fallback found article for %s", org_name)
            agents_log.append({
                "name": "wikipedia_org_fallback",
                "outcome": "success" if wiki_data else "no_data",
                "elapsed_seconds": round(time.time() - t0_wiki_fb, 3),
                "cost_usd": 0.0,
                "tokens_input": 0, "tokens_output": 0,
                "attempts": 1,
                "error": None,
                "records_found": 1 if wiki_data else 0,
            })
        except Exception as e:
            agents_log.append({
                "name": "wikipedia_org_fallback",
                "outcome": "error",
                "elapsed_seconds": round(time.time() - t0_wiki_fb, 3),
                "cost_usd": 0.0,
                "tokens_input": 0, "tokens_output": 0,
                "attempts": 1,
                "error": str(e)[:200],
                "records_found": None,
            })

    # Store raw data in context (for T2 to reuse)
    ctx.add_source("wiki_data", wiki_data)
    ctx.add_source("oc_data", oc_data)
    ctx.add_source("fec_data", fec_data)
    ctx.add_source("web_search_data", web_results)

    # Build claims from all sources
    claims = []

    # Web search claims (LLM extraction from snippets)
    web_claims = claims_from_web_search(web_results or [], person_name, client)
    claims.extend(web_claims)

    # Structured source claims
    claims.extend(claims_from_wikipedia_infobox(wiki_data))
    claims.extend(claims_from_opencorporates(oc_data or []))
    claims.extend(claims_from_fec(fec_data or []))

    # Store claims in context
    ctx.add_claims(claims)

    # Classify prospect type
    from ..prospect_type import classify_prospect
    pt, pt_conf, pt_method = classify_prospect(crm_match, org_name, wiki_data, client)
    ctx.prospect_type = pt.value
    ctx.prospect_type_confidence = pt_conf
    ctx.prospect_type_method = pt_method

    ctx.mark_tier_complete("T1")

    # Populate prospect CRM mapping (batch flow only)
    batch_prospect_id = route.entities.get("batch_prospect_id")
    if batch_prospect_id:
        from ..sf_field_extractor import extract_sf_fields
        from ..storage.db import save_prospect_sf_contact, save_prospect_sf_account
        try:
            contact_data, account_data, _ = extract_sf_fields(ctx, route, "T1")
            await save_prospect_sf_contact(batch_prospect_id, contact_data)
            await save_prospect_sf_account(batch_prospect_id, account_data)
        except Exception as e:
            logger.warning("T1 prospect_sf population failed for %s: %s", name, e)

    # Identity assessment via Haiku
    confidence = "low" if not claims else "medium"
    summary = f"Found {len(claims)} data points for {name}."

    if client and claims:
        t0_haiku = time.time()
        try:
            claims_text = "\n".join(
                f"- {c['text']} (source: {c.get('source_url', 'unknown')})"
                for c in claims[:15]
            )
            result = client.complete(
                "t1_identity_assessor",
                f"Name: {name}\nOrganization: {org_name}\n\nEvidence:\n{claims_text}",
                "You assess identity confidence for prospect research. "
                "Return JSON: {\"confidence\": \"high|medium|low\", "
                "\"summary\": \"one-sentence assessment\", "
                "\"likely_correct_person\": true|false}. Output JSON only.",
            )
            text = result.get("text", "")
            usage = result.get("usage", {})
            haiku_cost = (usage.get("input_tokens", 0) * 1.0 + usage.get("output_tokens", 0) * 5.0) / 1_000_000
            cost += haiku_cost
            agents_log.append({
                "name": "haiku_identity",
                "outcome": "success",
                "elapsed_seconds": round(time.time() - t0_haiku, 3),
                "cost_usd": round(haiku_cost, 6),
                "tokens_input": usage.get("input_tokens", 0),
                "tokens_output": usage.get("output_tokens", 0),
                "attempts": 1,
                "error": None,
                "records_found": None,
            })

            # Parse response — separate from LLM call error handling
            try:
                import json, re
                json_match = re.search(r"\{[^}]+\}", text, re.DOTALL)
                if json_match:
                    parsed = json.loads(json_match.group())
                    confidence = parsed.get("confidence", confidence)
                    summary = parsed.get("summary", summary)
            except Exception:
                logger.warning("T1 identity response parsing failed for %s", name)
        except Exception as e:
            agents_log.append({
                "name": "haiku_identity",
                "outcome": "error",
                "elapsed_seconds": round(time.time() - t0_haiku, 3),
                "cost_usd": 0.0,
                "tokens_input": 0, "tokens_output": 0,
                "attempts": 1,
                "error": str(e)[:200],
                "records_found": None,
            })
            logger.warning("T1 identity assessment failed: %s", e)

    # Format identity card
    card_parts = [f"**{name}**"]
    if org_name:
        card_parts.append(f"Organization: {org_name}")
    card_parts.append(f"CRM Status: {crm_status.replace('_', ' ').title()}")
    if crm_info:
        card_parts.append(crm_info)
    card_parts.append(f"Prospect Type: **{pt.value.upper()}** ({pt_conf:.0%} via {pt_method})")
    card_parts.append(f"Identity Confidence: **{confidence.upper()}**")
    card_parts.append(f"Data Points: {len(claims)}")
    if web_claims:
        card_parts.append(f"Web Sources: {len(web_results or [])} results")
    card_parts.append(f"\n{summary}")

    return HandlerResponse(
        text="\n".join(card_parts),
        level=10,
        intent=route.intent,
        cost_usd=cost,
        data={
            "identity_card": {
                "name": name,
                "organization": org_name,
                "crm_status": crm_status,
                "confidence": confidence,
                "claims_count": len(claims),
                "summary": summary,
                "prospect_type": pt.value,
                "prospect_type_confidence": pt_conf,
            },
        },
        sources=[c.get("source_url", "") for c in claims if c.get("source_url")][:10],
        agents_log=agents_log,
    )


async def _noop():
    return None
