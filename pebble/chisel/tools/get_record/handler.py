"""get_record — fetch one record by entity_type + entity_id.

Uses ``ctx.http_client`` (a Bedrock-pointed httpx.AsyncClient) so audit
+ timeout policy stay centralized. Transport / status-code errors raise
plain exceptions; the chisel adapter converts those to ``ok=False``
ToolResult — no need for handler-side try/except boilerplate.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from pebble.chisel.handler_adapter import HandlerContext


# Strict allowlist of entity_type → route. Defends against the planner
# sending an arbitrary path.
_RECORD_ROUTES: dict[str, str] = {
    "sf_account": "/api/salesforce/accounts/{id}",
    "sf_contact": "/api/salesforce/contacts/{id}",
    "sf_opportunity": "/api/salesforce/opportunities/{id}",
    "sf_task": "/api/salesforce/tasks/{id}",
    "bedrock_award": "/api/awards/{id}",
    "bedrock_project": "/api/projects/{id}",
    "pebble_profile": "/api/v1/research/profiles/{id}",
}


EntityType = Literal[
    "sf_account",
    "sf_contact",
    "sf_opportunity",
    "sf_task",
    "bedrock_award",
    "bedrock_project",
    "pebble_profile",
]


class Input(BaseModel):
    entity_type: EntityType
    entity_id: str = Field(min_length=1)


class RecordNotFound(Exception):
    """404 from the underlying route."""


class RecordFetchError(Exception):
    """Non-404 transport / status failure."""


async def run(args: Input, ctx: HandlerContext) -> dict[str, Any]:
    if ctx.http_client is None:
        raise RecordFetchError("no http_client in ToolContext")

    path = _RECORD_ROUTES[args.entity_type].format(id=args.entity_id)
    resp = await ctx.http_client.get(path)

    if resp.status_code == 404:
        raise RecordNotFound(f"{args.entity_type} {args.entity_id!r} not found")
    if resp.status_code >= 400:
        raise RecordFetchError(f"HTTP {resp.status_code}")

    ctx.cite(args.entity_type, args.entity_id)
    return {
        "entity_type": args.entity_type,
        "entity_id": args.entity_id,
        "record": resp.json(),
    }
