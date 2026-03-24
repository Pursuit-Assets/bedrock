"""Handler dispatch for Ask Pebble chat queries."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Optional

from ..router import RouteResult
from ..readiness import assess_readiness, ReadinessStatus, EntityMatch
from ..schemas.chat import ClarificationOption

logger = logging.getLogger("pebble.handlers")


@dataclass
class HandlerResponse:
    """Uniform response from all handlers."""
    text: str
    level: int
    intent: str
    cost_usd: float = 0.0
    elapsed_seconds: float = 0.0
    data: Optional[dict] = None
    sources: list[str] = field(default_factory=list)
    requires_clarification: bool = False
    clarification_options: Optional[list[ClarificationOption]] = None
    redirect_target: Optional[str] = None
    redirect_reason: Optional[str] = None


def _entity_match_to_option(match: EntityMatch) -> ClarificationOption:
    """Convert an EntityMatch to a clickable ClarificationOption."""
    return ClarificationOption(
        label=match.name,
        value=f"{match.entity_type}:{match.sf_id}",
        description=match.detail or None,
    )


async def dispatch_handler(
    route: RouteResult,
    crm_bridge,
    conversation_context: Optional[list[dict]] = None,
    client=None,
    user_permissions: Optional[dict] = None,
) -> HandlerResponse:
    """Route a classified query to the appropriate handler.

    Flow: readiness check → handler dispatch → response formatting.
    """
    start = time.time()

    # Redirects don't need CRM or readiness checks
    if route.level == -1:
        from .redirect import handle_redirect
        return handle_redirect(route)

    # CRM search for disambiguation (if entities are present)
    search_results = None
    person_name = route.entities.get("person_name")
    org_name = route.entities.get("org_name")
    search_term = person_name or org_name

    if search_term and crm_bridge is not None:
        search_results = await crm_bridge.search_all(search_term)

    # Readiness check (disambiguation gate)
    if search_results:
        # Determine entity hint from intent
        entity_hint = None
        if route.intent in ("contact_field_lookup", "entity_list"):
            if "contact" in route.intent or (person_name and not org_name):
                entity_hint = "Contact"

        tier_name = _level_to_tier(route.level)
        readiness = assess_readiness(
            search_results,
            query_entity_hint=entity_hint,
            tier=tier_name,
            has_org_context=bool(org_name),
        )

        if readiness.status == ReadinessStatus.CLARIFY:
            return HandlerResponse(
                text=readiness.message,
                level=route.level,
                intent=route.intent,
                requires_clarification=True,
                clarification_options=[
                    _entity_match_to_option(m) for m in readiness.matches
                ],
                elapsed_seconds=time.time() - start,
            )

        if readiness.status == ReadinessStatus.CROSS_ENTITY:
            options = []
            for obj_type, matches in (readiness.entity_groups or {}).items():
                count = len(matches)
                label = f"{obj_type} ({count})" if count > 1 else matches[0].name
                options.append(ClarificationOption(
                    label=label,
                    value=f"type:{obj_type}",
                    description=f"{count} match{'es' if count > 1 else ''}",
                ))
            return HandlerResponse(
                text=readiness.message,
                level=route.level,
                intent=route.intent,
                requires_clarification=True,
                clarification_options=options,
                elapsed_seconds=time.time() - start,
            )

        if readiness.status == ReadinessStatus.IDENTITY_RISK:
            return HandlerResponse(
                text=readiness.message,
                level=route.level,
                intent=route.intent,
                requires_clarification=True,
                clarification_options=[
                    ClarificationOption(label="Proceed anyway", value="proceed_risky", description="Results may be less reliable"),
                    ClarificationOption(label="Add more context", value="add_context", description="Provide organization name"),
                ],
                elapsed_seconds=time.time() - start,
            )

        if readiness.status == ReadinessStatus.NEW_ENTITY:
            # For L0/L1 read-only, just note no match.
            # If user has write permissions, let the CRM agent handle it —
            # the agent can offer to create the record.
            if route.level <= 1 and not user_permissions:
                return HandlerResponse(
                    text=f"No matching records found in the CRM for '{search_term}'.",
                    level=route.level,
                    intent=route.intent,
                    elapsed_seconds=time.time() - start,
                )

        # READY — attach primary match to route entities for handler use
        if readiness.primary_match:
            route.entities["crm_match"] = {
                "type": readiness.primary_match.entity_type,
                "id": readiness.primary_match.sf_id,
                "name": readiness.primary_match.name,
                "account_type": readiness.primary_match.account_type,
                "account_record_type": readiness.primary_match.account_record_type,
            }

    # Dispatch to level-specific handler
    if route.level in (0, 1):
        # CRM tool-use agent (requires LLM client)
        if client is not None:
            from .crm_agent import handle_crm_agent
            response = await handle_crm_agent(
                route, crm_bridge, search_results, conversation_context, client,
                user_permissions=user_permissions,
            )
        elif route.level == 0:
            from .level0 import handle_l0
            response = await handle_l0(route, crm_bridge, search_results)
        else:
            from .level1 import handle_l1
            response = await handle_l1(route, crm_bridge, search_results, client)
    elif route.level == 10:
        from .tier1 import handle_t1
        response = await handle_t1(route, crm_bridge, client)
    elif route.level == 20:
        from .tier2 import handle_t2
        response = await handle_t2(route, crm_bridge, client)
    elif route.level == 30:
        from .tier3 import handle_t3
        response = await handle_t3(route, crm_bridge, client)
    else:
        response = HandlerResponse(
            text="I'm not sure how to handle that query.",
            level=route.level, intent=route.intent,
        )

    response.elapsed_seconds = time.time() - start
    return response


def _level_to_tier(level: int) -> str:
    """Map numeric level to tier string for readiness module."""
    return {0: "T0", 1: "T0.5", 10: "T1", 20: "T2", 30: "T3"}.get(level, "T0")
