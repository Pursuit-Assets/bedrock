"""Streaming entry points for the chat orchestrator + workflow paths.

When ``classify_query`` returns:

  * ``level=2`` (slash-command workflow), or
  * ``level=1`` AND the env flag ``PEBBLE_USE_ORCHESTRATOR`` is on AND
    an Anthropic client is constructible,

``pebble.main.chat_query`` returns a ``StreamingResponse`` whose body
is generated here. Other levels still return JSON via the existing
``dispatch_handler`` path; this module is only the streaming entry.

What this module exposes
------------------------

  * ``orchestrator_enabled(route)`` — predicate: should L1 traffic
    for this route flow through the new ChatOrchestrator path?
  * ``is_workflow_route(route)`` — predicate: is this a level=2
    workflow short-circuit?
  * ``stream_orchestrator_events(...)`` — async generator that
    yields ``OrchestratorEvent`` records by building the orchestrator
    + dispatching to the right path (workflow vs agent).

Why a separate module
---------------------

  * Keeps ``pebble/main.py`` focused on FastAPI concerns (routing,
    auth, response shape).
  * Keeps the orchestrator-construction code in one place that's
    test-able without spinning up FastAPI.
  * Future paths (other workflows, alternate models, debug-replay
    mode) plug in here with no main.py edits.

Environment flags consumed
--------------------------

  * ``PEBBLE_USE_ORCHESTRATOR`` — when true (1/yes/on), level=1
    traffic with a working Anthropic client routes through the
    ChatOrchestrator. Default off so production stays on the
    existing crm_agent path until JP flips the switch.
  * ``ANTHROPIC_API_KEY`` — checked via the SDK; absent means the
    Anthropic client construction raises and we fall back to the
    JSON dispatcher path.
  * ``X-Pebble-Force-Tier=L0`` (header) — read by ``chat_query``
    BEFORE this module fires. When set, this module is bypassed
    entirely. Documented here so the contract is in one place.
"""

from __future__ import annotations

import logging
import os
from typing import Any, AsyncIterator, Optional
from uuid import UUID, uuid4

from ..orchestrator.budget import Budget
from ..orchestrator.chat_orchestrator import ChatOrchestrator, OrchestratorEvent
from ..orchestrator.evaluator import Evaluator
from ..orchestrator.planner import Planner
from ..orchestrator.scratchpad import ScratchpadWriter
from ..orchestrator.tools import DEFAULT_REGISTRY, ToolContext
# Side-effect imports — these modules auto-register their tools into
# DEFAULT_REGISTRY at import time. Without these explicit imports, an
# import path that touches streaming.py first leaves the registry
# missing search_crm / generate_chart / aggregate_pipeline_views and
# the planner can't construct a valid plan.
from ..orchestrator import builtin_tools as _builtin_tools  # noqa: F401
from .. import workflows as _workflows  # noqa: F401
from ..router import RouteResult

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Predicates
# ---------------------------------------------------------------------------

def _flag_truthy(name: str, default: str = "false") -> bool:
    """Standard env-flag truth check matching auth.py / proxy.py style."""
    return (os.getenv(name, default) or "").strip().lower() in ("1", "true", "yes", "on")


def orchestrator_enabled(route: RouteResult) -> bool:
    """True when level=1 traffic for this route should run through the
    new ChatOrchestrator. Three conditions must hold:

      1. ``route.level == 1``     — only L1 chat queries (T1/T2/T3 stay
                                     on their research handlers).
      2. ``PEBBLE_USE_ORCHESTRATOR`` env flag truthy — production
                                     defaults off; JP enables when ready.
      3. ``ANTHROPIC_API_KEY`` set — the orchestrator needs a real
                                     LLM client.

    The Anthropic client construction itself happens in
    ``stream_orchestrator_events``; if it fails despite the env flag,
    callers should fall back to the JSON path.
    """
    if route.level != 1:
        return False
    if not _flag_truthy("PEBBLE_USE_ORCHESTRATOR"):
        return False
    if not os.getenv("ANTHROPIC_API_KEY"):
        return False
    return True


def is_workflow_route(route: RouteResult) -> bool:
    """True for slash-command workflows (level=2). Independent of any
    env flag — workflows are deterministic, no LLM, always safe to
    run when the user explicitly requests them via slash command.
    """
    return route.level == 2


# ---------------------------------------------------------------------------
# Streaming entry
# ---------------------------------------------------------------------------

async def stream_orchestrator_events(
    *,
    route: RouteResult,
    user_query: str,
    conversation_id: str,
    user_email: str,
    db_pool: Any = None,
    recent_messages: Optional[list[dict[str, str]]] = None,
    anthropic_client: Any = None,
) -> AsyncIterator[OrchestratorEvent]:
    """Yield ``OrchestratorEvent`` records for the streaming chat
    path. Caller is responsible for SSE-encoding via
    ``pebble.orchestrator.sse.encode_event``.

    Routes:
      * level=2 → ``run_stream_with_plan`` against a pre-baked Plan
        (e.g. ``build_weekly_pipeline_review_plan``). No planner LLM.
      * level=1 → ``run_stream`` (planner → executor → eval). Full
        agentic loop.

    Construction failures (missing API key, bad config) emit a single
    ``error`` event and a degraded ``response_final`` so the FE never
    sees a broken stream.
    """
    # Lazy import to avoid pulling FastAPI / Anthropic SDK at module
    # load. Lets the predicates run cheaply in environments without
    # the orchestrator wired up.
    from .. import crm_bridge
    from ..llm.anthropic_client import (
        AnthropicLLMClient, AnthropicLLMError, get_default_client,
    )
    from ..orchestrator.sse import encode_event  # noqa: F401 — re-exported via callers
    from ..workflows.weekly_pipeline_review import build_weekly_pipeline_review_plan

    # Reuse the process-wide singleton when the caller didn't pass an
    # explicit client. Fresh AsyncAnthropic per-request would discard
    # the httpx connection pool and the prompt-cache benefit.
    try:
        client = anthropic_client or get_default_client()
    except AnthropicLLMError as e:
        logger.warning("orchestrator.client_construction_failed err=%s", e)
        yield OrchestratorEvent(
            kind="error",
            payload={"phase": "construction", "reason": "anthropic_unavailable"},
        )
        yield OrchestratorEvent(
            kind="response_final",
            payload={"final": {
                "plan_id": str(uuid4()),
                "text": "Pebble's chat brain is offline. Try again in a moment.",
                "degraded": True,
                "degradation_reason": "anthropic_unavailable",
                "citations": [], "suggested_actions": [], "charts": [],
            }},
        )
        return

    # Resolve conversation_id to UUID. Frontend may pass any string;
    # if it's not a valid UUID, mint a fresh one (the user's previous
    # turns won't link, but the conversation continues clean).
    try:
        conv_uuid = UUID(conversation_id)
    except (TypeError, ValueError):
        conv_uuid = uuid4()
        logger.warning(
            "orchestrator.conversation_id_invalid raw=%r minted=%s",
            conversation_id, conv_uuid,
        )

    scratchpad = ScratchpadWriter(
        pool=db_pool,
        conversation_id=conv_uuid,
        user_email=user_email,
    )

    # ToolContext.http_client points at Bedrock for /api/search calls;
    # the crm_bridge singleton is the right client (base_url +
    # X-Internal-Key already configured per Phase 0 audit hardening).
    ctx = ToolContext(
        user_email=user_email,
        conversation_id=str(conv_uuid),
        db_pool=db_pool,
        http_client=crm_bridge._get_client(),
    )

    planner = Planner(client=client, registry=DEFAULT_REGISTRY)
    evaluator = Evaluator(client=client)
    budget = Budget()
    orch = ChatOrchestrator(
        planner=planner, evaluator=evaluator, registry=DEFAULT_REGISTRY,
        budget=budget, ctx=ctx, scratchpad=scratchpad,
    )

    if is_workflow_route(route):
        # Slash-command workflow → pre-baked plan, deterministic.
        plan = _build_workflow_plan_for_intent(route.intent, user_query)
        if plan is None:
            yield OrchestratorEvent(
                kind="error",
                payload={
                    "phase": "workflow_dispatch",
                    "reason": f"unknown_workflow_intent:{route.intent}",
                },
            )
            yield OrchestratorEvent(
                kind="response_final",
                payload={"final": {
                    "plan_id": str(uuid4()),
                    "text": (
                        "I don't know that workflow yet. "
                        "Try one of: /pipeline."
                    ),
                    "degraded": True,
                    "degradation_reason": "unknown_workflow_intent",
                    "citations": [], "suggested_actions": [], "charts": [],
                }},
            )
            return
        async for ev in orch.run_stream_with_plan(
            plan=plan, allow_replan=False, recent_messages=recent_messages,
        ):
            yield ev
        return

    # Level=1 — full agentic loop with planner LLM.
    async for ev in orch.run_stream(
        user_query=user_query, recent_messages=recent_messages,
    ):
        yield ev


def _build_workflow_plan_for_intent(intent: str, user_query: str):
    """Map ``RouteResult.intent`` → the workflow's ``build_*_plan``
    function. New workflows get one entry here.

    Returns None if the intent isn't a known workflow — caller
    surfaces a clean error to the user.
    """
    from ..workflows.weekly_pipeline_review import build_weekly_pipeline_review_plan

    if intent == "workflow_weekly_pipeline_review":
        return build_weekly_pipeline_review_plan(user_query=user_query)
    return None
