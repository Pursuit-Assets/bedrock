"""Tool registry — formal Anthropic-shape tool definitions for the
Pebble chat orchestrator.

Each tool is a ``ToolSpec`` with:

  * ``name``             — what Sonnet calls in tool_use blocks
  * ``description``      — natural-language description (planner's only
                            guide for when to use this tool)
  * ``input_schema``     — JSON Schema for the args
  * ``handler``          — async callable: ``(args, context) -> ToolResult``
  * ``cost_estimate``    — USD per call (rough; for budget pre-flight)
  * ``requires_human``   — True for write actions that must hard-stop
                            and route through a confirm card

The registry is the single source of truth. The planner is fed
``[tool.to_anthropic_dict() for tool in registry.iter_specs()]``; the
executor dispatches on ``tool_use`` blocks via
``registry.invoke(name, args, context)``.

Adding a new tool = new file in this package + register at import time.
No core orchestrator changes needed.
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional, Protocol

from .schemas import ToolResult


# ---------------------------------------------------------------------------
# ToolContext — what handlers can read from the calling environment.
# ---------------------------------------------------------------------------

@dataclass
class ToolContext:
    """Carried into every tool handler. Centralizes the auth principal,
    DB pool reference, and HTTP client so handlers don't have to hunt
    for them globally.
    """
    user_email: str           # the originating human; never service:pebble
    conversation_id: str
    org_id: str = "pursuit"
    db_pool: Any = None       # asyncpg pool (or test mock)
    http_client: Any = None   # httpx.AsyncClient pointed at Bedrock


# ---------------------------------------------------------------------------
# ToolSpec
# ---------------------------------------------------------------------------

# Handler signature: ``async def(args: dict, ctx: ToolContext) -> ToolResult``.
ToolHandler = Callable[[dict[str, Any], ToolContext], Awaitable[ToolResult]]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]
    handler: ToolHandler
    cost_estimate_usd: float = 0.0
    requires_human: bool = False
    tags: tuple[str, ...] = ()

    def to_anthropic_dict(self) -> dict[str, Any]:
        """Shape the planner consumes via the Anthropic tool-use API."""
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

class ToolRegistry:
    """Process-local registry. One instance per app; mutable at module
    import time (each tool module registers itself), frozen for the
    lifetime of any orchestrator instance.

    Test isolation: tests instantiate a fresh ``ToolRegistry()``,
    register stub handlers, hand it to the orchestrator. The default
    process-wide registry is at ``DEFAULT_REGISTRY``; production paths
    use it.
    """

    def __init__(self) -> None:
        self._specs: dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> None:
        if spec.name in self._specs:
            raise ValueError(
                f"Tool {spec.name!r} already registered. Names must be unique."
            )
        if not callable(spec.handler):
            raise TypeError(f"Tool {spec.name!r} handler must be callable")
        if not inspect.iscoroutinefunction(spec.handler):
            raise TypeError(
                f"Tool {spec.name!r} handler must be async (got "
                f"{type(spec.handler).__name__})"
            )
        self._specs[spec.name] = spec

    def unregister(self, name: str) -> None:
        """Test-only: drop a tool from the registry."""
        self._specs.pop(name, None)

    def get(self, name: str) -> Optional[ToolSpec]:
        return self._specs.get(name)

    def iter_specs(self) -> list[ToolSpec]:
        """Stable order = insertion order (Python dict guarantee).
        Planner sees tools in the order they were registered."""
        return list(self._specs.values())

    def names(self) -> list[str]:
        return list(self._specs.keys())

    def to_anthropic_list(self) -> list[dict[str, Any]]:
        """Convenience: shape the entire registry for the Sonnet
        planner's ``tools=`` argument."""
        return [s.to_anthropic_dict() for s in self.iter_specs()]

    async def invoke(
        self,
        name: str,
        args: dict[str, Any],
        ctx: ToolContext,
    ) -> ToolResult:
        """Dispatch to the registered handler. Unknown tool name →
        ToolResult(ok=False, error='unknown_tool'). Handler exceptions
        are caught and wrapped — the orchestrator should not crash on
        a bad tool, only halt the failing step.
        """
        spec = self._specs.get(name)
        if spec is None:
            return ToolResult(
                step_id=__import__("uuid").uuid4(),
                tool=name,
                ok=False,
                error=f"unknown_tool: {name!r} not in registry "
                      f"(known: {self.names()})",
            )
        try:
            return await spec.handler(args, ctx)
        except Exception as e:
            return ToolResult(
                step_id=__import__("uuid").uuid4(),
                tool=name,
                ok=False,
                error=f"{type(e).__name__}: {e}",
            )

    def __len__(self) -> int:
        return len(self._specs)

    def __contains__(self, name: str) -> bool:
        return name in self._specs


# Process-wide default registry. Tool modules import + register on this.
DEFAULT_REGISTRY = ToolRegistry()


# ---------------------------------------------------------------------------
# Validation helpers — input_schema utility for tool authors.
# ---------------------------------------------------------------------------

def required(*keys: str) -> dict[str, Any]:
    return {"type": "object", "required": list(keys), "properties": {}}


def make_input_schema(
    *,
    properties: dict[str, dict[str, Any]],
    required_keys: list[str] | None = None,
    additional_properties: bool = False,
) -> dict[str, Any]:
    """Compose a JSON Schema dict in the shape Anthropic's tool-use
    API expects. additional_properties=False by default — strict
    schemas mean the planner can't smuggle unknown args.
    """
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
    }
    if required_keys:
        schema["required"] = required_keys
    if not additional_properties:
        schema["additionalProperties"] = False
    return schema
