"""Built-in tool implementations for the Pebble chat orchestrator.

Each tool here is registered against ``DEFAULT_REGISTRY`` at module
import time. Adding a new tool = new function in this file (or a new
module) + a registration call. The orchestrator's planner sees the
new tool on next request without core changes.

Tools shipped here:

  * ``search_crm`` — cross-entity search via Bedrock's /api/search.
    Permission-aware (the originating user's filter applies, not
    the service principal's). Returns rank-ordered hits + citation
    ids the renderer can wrap.
  * ``get_record`` — single-record fetch by entity_type + entity_id.
    Used after search to drill into a specific result.
  * ``request_human_review`` — explicit checkpoint when the agent's
    confidence is low. Halts execution; renderer surfaces a "Pebble
    needs help" prompt.

More tools land in companion modules: ``builtin_tools_metrics.py``
for query_metric, ``builtin_tools_writes.py`` for propose_write, etc.
"""

from __future__ import annotations

import logging
import time
from typing import Any
from uuid import uuid4

import httpx

from .schemas import ToolResult
from .tools import (
    DEFAULT_REGISTRY,
    ToolContext,
    ToolSpec,
    make_input_schema,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# search_crm
# ---------------------------------------------------------------------------

async def _handle_search_crm(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    """Cross-entity Bedrock search. Calls /api/search with the
    originating user's permissions applied (Bedrock's resolve_principal
    reads X-Originating-User and resolves the user's view).

    The httpx client comes via ``ctx.http_client`` so tests can
    inject a mock. In production, the orchestrator passes
    ``pebble.crm_bridge._get_client()``.
    """
    started = time.perf_counter()
    if ctx.http_client is None:
        return ToolResult(
            step_id=uuid4(), tool="search_crm", ok=False,
            error="search_crm: no http_client in ToolContext",
        )

    query = args.get("query", "").strip()
    if not query:
        return ToolResult(
            step_id=uuid4(), tool="search_crm", ok=False,
            error="search_crm: 'query' is required and must be non-empty",
        )

    types = args.get("types")
    limit = max(1, min(int(args.get("limit", 8)), 100))

    params: dict[str, Any] = {"q": query, "limit": limit}
    if types:
        if isinstance(types, list):
            params["types"] = ",".join(types)
        elif isinstance(types, str):
            params["types"] = types

    try:
        resp = await ctx.http_client.get("/api/search", params=params)
    except httpx.TimeoutException:
        return ToolResult(
            step_id=uuid4(), tool="search_crm", ok=False,
            error="search_crm: timeout calling /api/search",
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
    except httpx.HTTPError as e:
        return ToolResult(
            step_id=uuid4(), tool="search_crm", ok=False,
            error=f"search_crm: {type(e).__name__}: {e}",
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    duration_ms = int((time.perf_counter() - started) * 1000)
    if resp.status_code >= 400:
        return ToolResult(
            step_id=uuid4(), tool="search_crm", ok=False,
            error=f"search_crm: HTTP {resp.status_code}",
            duration_ms=duration_ms,
        )

    body = resp.json()
    items = body.get("items") or []
    # Citation IDs the renderer can wrap. Format: "<entity_type>:<entity_id>".
    citations = tuple(
        f"{hit.get('entity_type')}:{hit.get('entity_id')}"
        for hit in items
        if hit.get("entity_type") and hit.get("entity_id")
    )

    return ToolResult(
        step_id=uuid4(), tool="search_crm", ok=True,
        data={
            "items": items,
            "grouped": body.get("grouped") or {},
            "total_count": body.get("total_count") or len(items),
            "backend_used": body.get("backend_used"),
            "took_ms": body.get("took_ms"),
            "query": query,
        },
        citations=citations,
        duration_ms=duration_ms,
    )


SEARCH_CRM_SPEC = ToolSpec(
    name="search_crm",
    description=(
        "Search the CRM across Accounts, Contacts, Opportunities, Tasks, "
        "Activities, Awards, Projects, and Pebble research. Returns "
        "rank-ordered hits the user can see (permission-filtered). Use "
        "this to find records by name, email, or any text content. "
        "Always prefer this to ``get_record`` when the user gives "
        "natural-language descriptors instead of explicit IDs."
    ),
    input_schema=make_input_schema(
        properties={
            "query": {
                "type": "string",
                "description": "Free-text query, 1-256 chars. Examples: "
                               "'Acme', 'open deals over 100k', 'jane@x.org'.",
            },
            "types": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": [
                        "sf_account", "sf_contact", "sf_opportunity",
                        "sf_task", "sf_activity",
                        "bedrock_project", "bedrock_award",
                        "bedrock_saved_view",
                        "pebble_profile", "pebble_chat_conversation",
                        "pebble_batch",
                    ],
                },
                "description": "Optional entity-type filter. Omit to search all.",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 8,
                "description": "Max hits to return.",
            },
        },
        required_keys=["query"],
    ),
    handler=_handle_search_crm,
    cost_estimate_usd=0.0,    # /api/search is free; the LLM tokens are budgeted at the planner level
)


# ---------------------------------------------------------------------------
# get_record
# ---------------------------------------------------------------------------

# Map of allowed entity_types → the route shape they use. Strict
# allowlist defends against the planner sending an arbitrary path.
_RECORD_ROUTES: dict[str, str] = {
    "sf_account": "/api/salesforce/accounts/{id}",
    "sf_contact": "/api/salesforce/contacts/{id}",
    "sf_opportunity": "/api/salesforce/opportunities/{id}",
    "sf_task": "/api/salesforce/tasks/{id}",
    "bedrock_award": "/api/awards/{id}",
    "bedrock_project": "/api/projects/{id}",
    "pebble_profile": "/api/v1/research/profiles/{id}",
}


async def _handle_get_record(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    started = time.perf_counter()
    if ctx.http_client is None:
        return ToolResult(
            step_id=uuid4(), tool="get_record", ok=False,
            error="get_record: no http_client in ToolContext",
        )

    entity_type = args.get("entity_type", "")
    entity_id = args.get("entity_id", "")
    if entity_type not in _RECORD_ROUTES:
        return ToolResult(
            step_id=uuid4(), tool="get_record", ok=False,
            error=f"get_record: unsupported entity_type {entity_type!r} "
                  f"(must be one of {list(_RECORD_ROUTES.keys())})",
        )
    if not entity_id or not isinstance(entity_id, str):
        return ToolResult(
            step_id=uuid4(), tool="get_record", ok=False,
            error="get_record: entity_id must be a non-empty string",
        )

    path = _RECORD_ROUTES[entity_type].format(id=entity_id)
    try:
        resp = await ctx.http_client.get(path)
    except httpx.HTTPError as e:
        return ToolResult(
            step_id=uuid4(), tool="get_record", ok=False,
            error=f"get_record: {type(e).__name__}: {e}",
        )

    duration_ms = int((time.perf_counter() - started) * 1000)
    if resp.status_code == 404:
        return ToolResult(
            step_id=uuid4(), tool="get_record", ok=False,
            error=f"get_record: {entity_type} {entity_id!r} not found",
            duration_ms=duration_ms,
        )
    if resp.status_code >= 400:
        return ToolResult(
            step_id=uuid4(), tool="get_record", ok=False,
            error=f"get_record: HTTP {resp.status_code}",
            duration_ms=duration_ms,
        )

    return ToolResult(
        step_id=uuid4(), tool="get_record", ok=True,
        data={"entity_type": entity_type, "entity_id": entity_id, "record": resp.json()},
        citations=(f"{entity_type}:{entity_id}",),
        duration_ms=duration_ms,
    )


GET_RECORD_SPEC = ToolSpec(
    name="get_record",
    description=(
        "Fetch a single record by entity_type + entity_id. Use after "
        "``search_crm`` returns a hit and the user wants more detail. "
        "Returns the full record from Bedrock or Salesforce."
    ),
    input_schema=make_input_schema(
        properties={
            "entity_type": {
                "type": "string",
                "enum": list(_RECORD_ROUTES.keys()),
            },
            "entity_id": {"type": "string", "minLength": 1},
        },
        required_keys=["entity_type", "entity_id"],
    ),
    handler=_handle_get_record,
)


# ---------------------------------------------------------------------------
# request_human_review
# ---------------------------------------------------------------------------

async def _handle_request_human_review(
    args: dict[str, Any], ctx: ToolContext,
) -> ToolResult:
    """Explicit pause for human input. The executor sees ``ok=True``
    and a ``checkpoint=True`` flag in data; halts execution and emits
    a checkpoint scratchpad step. The renderer sends the FE a
    "Pebble needs your input" card with the reason.

    No DB / network calls — purely a control-flow tool.
    """
    reason = args.get("reason", "").strip() or "Pebble requested confirmation."
    options = args.get("options") or []
    if not isinstance(options, list):
        return ToolResult(
            step_id=uuid4(), tool="request_human_review", ok=False,
            error="request_human_review: 'options' must be a list of strings",
        )
    return ToolResult(
        step_id=uuid4(), tool="request_human_review", ok=True,
        data={
            "checkpoint": True,
            "reason": reason,
            "options": options,
        },
    )


REQUEST_HUMAN_REVIEW_SPEC = ToolSpec(
    name="request_human_review",
    description=(
        "Pause execution and ask the user to confirm or choose between "
        "options. Use when the input is ambiguous (multiple records "
        "match a name) or the action is irreversible. The user's "
        "response resumes the conversation; you'll see their choice "
        "as the next message."
    ),
    input_schema=make_input_schema(
        properties={
            "reason": {
                "type": "string",
                "description": "Short explanation of why you need input.",
            },
            "options": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional list of choices to render as buttons.",
            },
        },
        required_keys=["reason"],
    ),
    handler=_handle_request_human_review,
    requires_human=True,
)


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

def register_builtin_tools(registry=None) -> None:
    """Register the built-in tools on ``registry`` (default global).

    Idempotent — re-registering after unregister is fine, but
    double-registering raises (per ToolRegistry contract). Tests can
    construct their own registry and pass it here for isolation.
    """
    reg = registry if registry is not None else DEFAULT_REGISTRY
    for spec in (SEARCH_CRM_SPEC, GET_RECORD_SPEC, REQUEST_HUMAN_REVIEW_SPEC):
        if spec.name not in reg:
            reg.register(spec)


# Auto-register at import time so the planner sees them on first request.
register_builtin_tools()
