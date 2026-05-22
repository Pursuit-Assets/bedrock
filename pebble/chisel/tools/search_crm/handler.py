"""search_crm — cross-entity Bedrock search.

Calls ``/api/search`` via ``ctx.http_client`` with the originating
user's permissions applied (Bedrock's ``resolve_principal`` reads
X-Originating-User and resolves the user's view).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from pebble.chisel.handler_adapter import HandlerContext


SearchEntityType = Literal[
    "sf_account",
    "sf_contact",
    "sf_opportunity",
    "sf_task",
    "sf_activity",
    "bedrock_project",
    "bedrock_award",
    "bedrock_saved_view",
    "pebble_profile",
    "pebble_chat_conversation",
    "pebble_batch",
]


class Input(BaseModel):
    query: str = Field(
        min_length=1,
        max_length=256,
        description="Free-text query. Examples: 'Acme', 'open deals over 100k', 'jane@x.org'.",
    )
    types: tuple[SearchEntityType, ...] = Field(
        default=(),
        description="Optional entity-type filter. Omit to search all.",
    )
    limit: int = Field(default=8, ge=1, le=100, description="Max hits to return.")


class SearchHTTPError(Exception):
    """Non-2xx from /api/search."""


async def run(args: Input, ctx: HandlerContext) -> dict[str, Any]:
    if ctx.http_client is None:
        raise SearchHTTPError("no http_client in ToolContext")

    params: dict[str, Any] = {"q": args.query.strip(), "limit": args.limit}
    if args.types:
        params["types"] = ",".join(args.types)

    resp = await ctx.http_client.get("/api/search", params=params)
    if resp.status_code >= 400:
        raise SearchHTTPError(f"HTTP {resp.status_code}")

    body = resp.json()
    items = body.get("items") or []
    for hit in items:
        et, eid = hit.get("entity_type"), hit.get("entity_id")
        if et and eid:
            ctx.cite(str(et), str(eid))

    return {
        "items": items,
        "grouped": body.get("grouped") or {},
        "total_count": body.get("total_count") or len(items),
        "backend_used": body.get("backend_used"),
        "took_ms": body.get("took_ms"),
        "query": args.query,
    }
