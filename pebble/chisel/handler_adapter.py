"""Wrap a Chisel-authored handler into the existing ``ToolHandler``
contract (``async def(args: dict, ctx: ToolContext) -> ToolResult``).

The Chisel author writes:

    class Input(BaseModel):
        query: str
        limit: int = 8

    async def run(args: Input, ctx: HandlerContext) -> dict:
        ...
        return {"items": [...]}                    # plain dict
        # OR: raise SomeError(...) on failure

This module:
  1. parses ``args`` dict → ``Input`` (returns ``ok=False`` on validation error);
  2. wraps ``ctx`` (``ToolContext``) in a ``HandlerContext`` that exposes
     ``cite()`` plus the underlying ctx fields;
  3. calls ``run``, times it, catches exceptions;
  4. converts the returned dict into a ``ToolResult`` with the manifest's
     ``version`` recorded in ``tool_version`` (P11 forward-compat with
     Sprint-11 scratchpad).

Handlers stop hand-rolling ToolResult — that's the per-tool boilerplate
elimination win (P2).
"""

from __future__ import annotations

import time
from typing import Any, Awaitable, Callable
from uuid import uuid4

from pydantic import BaseModel, ValidationError

from pebble.orchestrator.schemas import ToolResult
from pebble.orchestrator.tools import ToolContext, ToolHandler


class HandlerContext:
    """Thin read-only wrapper over ``ToolContext`` exposing a ``cite()``
    helper. v1 keeps ``http_client`` as the raw httpx client (no extra
    wrapping; see plan §11.7).
    """

    __slots__ = ("_ctx", "_citations")

    def __init__(self, ctx: ToolContext) -> None:
        self._ctx = ctx
        self._citations: list[str] = []

    @property
    def user_email(self) -> str:
        return self._ctx.user_email

    @property
    def conversation_id(self) -> str:
        return self._ctx.conversation_id

    @property
    def org_id(self) -> str:
        return self._ctx.org_id

    @property
    def db_pool(self) -> Any:
        return self._ctx.db_pool

    @property
    def http_client(self) -> Any:
        return self._ctx.http_client

    def cite(self, entity_type: str, entity_id: str) -> str:
        """Append a citation in the canonical ``entity_type:entity_id``
        shape and return it so handlers can also include it inline."""
        cite_id = f"{entity_type}:{entity_id}"
        self._citations.append(cite_id)
        return cite_id

    def collected_citations(self) -> tuple[str, ...]:
        return tuple(self._citations)


# Author's run() signature: (parsed_args, handler_ctx) -> awaitable dict
UserRun = Callable[[BaseModel, HandlerContext], Awaitable[dict[str, Any]]]


def build_handler_wrapper(
    *,
    tool_name: str,
    tool_version: str,
    input_model: type[BaseModel],
    user_run: UserRun,
) -> ToolHandler:
    """Return an async function with the legacy ToolHandler signature
    that the existing registry / executor / planner consume unchanged."""

    async def adapter(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        started = time.perf_counter()

        try:
            parsed = input_model(**args)
        except ValidationError as e:
            return ToolResult(
                step_id=uuid4(),
                tool=tool_name,
                ok=False,
                error=f"input_validation: {e.errors()}",
                duration_ms=int((time.perf_counter() - started) * 1000),
                tool_version=tool_version,
            )

        handler_ctx = HandlerContext(ctx)
        try:
            data = await user_run(parsed, handler_ctx)
        except Exception as e:  # noqa: BLE001 — wrap any handler error
            return ToolResult(
                step_id=uuid4(),
                tool=tool_name,
                ok=False,
                error=f"{type(e).__name__}: {e}",
                duration_ms=int((time.perf_counter() - started) * 1000),
                tool_version=tool_version,
            )

        if not isinstance(data, dict):
            return ToolResult(
                step_id=uuid4(),
                tool=tool_name,
                ok=False,
                error=(
                    f"handler_contract: run() must return dict, "
                    f"got {type(data).__name__}"
                ),
                duration_ms=int((time.perf_counter() - started) * 1000),
                tool_version=tool_version,
            )

        return ToolResult(
            step_id=uuid4(),
            tool=tool_name,
            ok=True,
            data=data,
            citations=handler_ctx.collected_citations(),
            duration_ms=int((time.perf_counter() - started) * 1000),
            tool_version=tool_version,
        )

    adapter.__name__ = f"chisel_adapter_{tool_name}"
    return adapter
