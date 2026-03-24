"""Query router — classifies chat queries into levels/tiers.

Architecture: Haiku-first for classification + entity extraction.
Regex only short-circuits obvious redirects (saves the LLM call).

Flow:
  1. Mode override (user picked a mode) → skip classification
  2. Regex redirect check (free, instant) → catches "draft an email", "schedule a meeting"
  3. Haiku classifies + extracts entities in one call (~1s, ~$0.001)
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger("pebble.router")


@dataclass
class RouteResult:
    """Classification result from the query router."""
    level: int              # -1=redirect, 0=T0, 1=T0.5, 10=T1, 20=T2, 30=T3
    intent: str             # e.g., "contact_field_lookup", "research_full"
    entities: dict = field(default_factory=dict)  # {person_name, org_name, field, ...}
    confidence: float = 1.0
    redirect_target: str | None = None   # "cowork", "bedrock_pipeline", etc.
    redirect_reason: str | None = None
    mode_override: str | None = None     # User-selected mode


# ---------------------------------------------------------------------------
# Mode → level mapping (when user picks a mode explicitly)
# ---------------------------------------------------------------------------

_MODE_LEVELS = {
    "quick": 0,
    "triage": 10,
    "structured": 20,
    "full": 30,
}


# ---------------------------------------------------------------------------
# Regex — ONLY for obvious redirects (out-of-scope fast path)
# ---------------------------------------------------------------------------

_REDIRECT_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"(draft|write|compose|send)\s.*(email|message|letter|note)", re.I), "redirect_drafting"),
    (re.compile(r"(schedule|calendar|meeting|reminder)", re.I), "redirect_calendar"),
]

_REDIRECT_TARGETS = {
    "redirect_drafting": ("cowork", "Drafting outreach is a CoWork task. I can pull prospect data for you to bring there."),
    "redirect_calendar": ("bedrock_priorities", "Check the Priorities page for your calendar and tasks."),
}


def _check_redirect(query: str) -> RouteResult | None:
    """Fast regex check for obvious out-of-scope queries. Free, instant."""
    for pattern, intent in _REDIRECT_PATTERNS:
        if pattern.search(query):
            target, reason = _REDIRECT_TARGETS.get(intent, ("cowork", "That's outside my scope."))
            return RouteResult(
                level=-1, intent=intent, confidence=0.95,
                redirect_target=target, redirect_reason=reason,
            )
    return None


# ---------------------------------------------------------------------------
# Haiku LLM — primary classifier + entity extractor
# ---------------------------------------------------------------------------

_CLASSIFIER_SYSTEM = """\
You are the query router for Pebble, a CRM intelligence and prospect research assistant.

Given a user query, return a single JSON object (no markdown, no explanation):

{
  "level": <int>,
  "intent": "<string>",
  "entities": {"person_name": "<string or null>", "org_name": "<string or null>"},
  "confidence": <float 0-1>
}

LEVELS:
  -1 = redirect (out of scope: email drafting, scheduling, general AI)
   0 = CRM lookup or action (contact field, list entities, pipeline value, create account, create contact — instant, free)
   1 = CRM analysis (summarize relationship, find stale deals — needs LLM synthesis)
  10 = T1 ID & Triage (identify a person, quick public check)
  20 = T2 Structured Intelligence (giving capacity, board positions, affiliations)
  30 = T3 Full Research (comprehensive verified brief)

ENTITY EXTRACTION:
  - Always extract person_name and org_name when present in the query
  - "Who is Jukay Hsu?" → person_name: "Jukay Hsu"
  - "Research Jane Smith at Acme" → person_name: "Jane Smith", org_name: "Acme"
  - "Pipeline value?" → both null

If redirect, also include: "redirect_target": "cowork"|"bedrock_pipeline"|"bedrock_priorities"

Output JSON only."""


async def _classify_with_haiku(query: str, client) -> RouteResult:
    """Haiku classifies the query and extracts entities in one call."""
    user_prompt = f"<user_query>{query}</user_query>"
    result = client.complete("query_classifier", user_prompt, _CLASSIFIER_SYSTEM)
    text = result.get("text", "")

    # Parse JSON
    try:
        json_match = re.search(r"\{[^}]*\}", text, re.DOTALL)
        parsed = json.loads(json_match.group()) if json_match else json.loads(text)
    except (json.JSONDecodeError, ValueError, AttributeError):
        logger.warning("Haiku classifier returned non-JSON: %s", text[:200])
        return RouteResult(level=1, intent="haiku_parse_error", confidence=0.3)

    confidence = float(parsed.get("confidence", 0.5))
    level = int(parsed.get("level", 1))

    # Low confidence → default to L1 (safe middle ground)
    if confidence < 0.7:
        level = 1

    entities = parsed.get("entities", {})
    # Clean null strings
    entities = {k: v for k, v in entities.items() if v}

    route = RouteResult(
        level=level,
        intent=parsed.get("intent", "haiku_classified"),
        entities=entities,
        confidence=confidence,
    )

    if level == -1:
        route.redirect_target = parsed.get("redirect_target", "cowork")
        route.redirect_reason = parsed.get(
            "redirect_reason",
            _REDIRECT_TARGETS.get(route.intent, ("cowork", "That's outside Pebble's scope."))[1],
        )

    return route


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def classify_query(
    query: str,
    mode: str = "auto",
    client=None,
) -> RouteResult:
    """Classify a chat query into a routing level with entity extraction.

    Flow:
      1. Mode override → user explicitly chose a tier
      2. Regex redirect check → instant, free, catches obvious out-of-scope
      3. Haiku LLM → classifies + extracts entities (~1s, ~$0.001)
      4. Fallback → L1 if no client available
    """
    # 1. Mode override
    if mode != "auto" and mode in _MODE_LEVELS:
        # Still need entities — use Haiku if available, otherwise empty
        if client:
            try:
                haiku_result = await _classify_with_haiku(query, client)
                haiku_result.level = _MODE_LEVELS[mode]
                haiku_result.intent = f"mode_override_{mode}"
                haiku_result.mode_override = mode
                return haiku_result
            except Exception:
                pass
        return RouteResult(
            level=_MODE_LEVELS[mode],
            intent=f"mode_override_{mode}",
            mode_override=mode,
        )

    # 2. Regex redirect fast-path (free, instant — saves LLM call)
    redirect = _check_redirect(query)
    if redirect:
        return redirect

    # 3. Haiku LLM — primary classifier + entity extractor
    if client is not None:
        try:
            return await _classify_with_haiku(query, client)
        except Exception as e:
            logger.warning("Haiku classifier failed, defaulting to L1: %s", e)

    # 4. Fallback — no LLM client available
    return RouteResult(level=1, intent="default_l1", confidence=0.3)
