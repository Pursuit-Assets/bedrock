"""Wrap a Chisel-authored handler into the existing ``ToolHandler``
contract (``async def(args: dict, ctx: ToolContext) -> ToolResult``).

The author writes:

    class Input(BaseModel):
        query: str

    async def run(args: Input, ctx: HandlerContext) -> dict:
        return {"items": [...]}                    # plain dict
        # OR: raise SomeError(...) on failure

The adapter parses dict → Pydantic, times the call, catches exceptions,
records ``tool_version`` (P11), and returns a ToolResult. Handlers
never hand-roll ToolResult — that's the per-tool boilerplate elimination
win (P2).
"""

from __future__ import annotations

import time
from typing import Any, Awaitable, Callable
from uuid import uuid4

from pydantic import BaseModel, ValidationError

from pebble.orchestrator.schemas import ToolResult
from pebble.orchestrator.tools import ToolContext, ToolHandler


class HandlerContext:
    """Per-call wrapper around ``ToolContext`` that adds citation
    collection. Attribute access (``ctx.user_email``, ``ctx.http_client``)
    transparently forwards to the underlying ToolContext."""

    __slots__ = ("_ctx", "_citations")

    def __init__(self, ctx: ToolContext) -> None:
        self._ctx = ctx
        self._citations: list[str] = []

    def __getattr__(self, name: str) -> Any:
        return getattr(self._ctx, name)

    def cite(self, entity_type: Any, entity_id: Any) -> str:
        cite_id = f"{entity_type}:{entity_id}"
        self._citations.append(cite_id)
        return cite_id

    @property
    def citations(self) -> tuple[str, ...]:
        return tuple(self._citations)


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

    def _fail(error: str, started: float) -> ToolResult:
        return ToolResult(
            step_id=uuid4(),
            tool=tool_name,
            ok=False,
            error=error,
            duration_ms=int((time.perf_counter() - started) * 1000),
            tool_version=tool_version,
        )

    async def adapter(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        started = time.perf_counter()

        try:
            parsed = input_model(**args)
        except ValidationError as e:
            return _fail(f"input_validation: {e.errors()}", started)

        handler_ctx = HandlerContext(ctx)
        try:
            data = await user_run(parsed, handler_ctx)
        except Exception as e:  # noqa: BLE001 — wrap any handler error
            return _fail(f"{type(e).__name__}: {e}", started)

        if not isinstance(data, dict):
            return _fail(
                f"handler_contract: run() must return dict, "
                f"got {type(data).__name__}",
                started,
            )

        return ToolResult(
            step_id=uuid4(),
            tool=tool_name,
            ok=True,
            data=data,
            citations=handler_ctx.citations,
            duration_ms=int((time.perf_counter() - started) * 1000),
            tool_version=tool_version,
        )

    adapter.__name__ = f"chisel_adapter_{tool_name}"
    return adapter
