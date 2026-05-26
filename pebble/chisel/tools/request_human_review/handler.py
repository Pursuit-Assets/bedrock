"""request_human_review — pure control-flow tool.

Returns a checkpoint payload; the executor halts on it and the renderer
emits a "Pebble needs your input" card. No I/O.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from pebble.chisel.handler_adapter import HandlerContext


class Input(BaseModel):
    reason: str = Field(min_length=1, description="Short explanation of why you need input.")
    options: tuple[str, ...] = Field(
        default=(),
        description="Optional list of choices to render as buttons.",
    )


async def run(args: Input, ctx: HandlerContext) -> dict[str, Any]:
    return {
        "checkpoint": True,
        "reason": args.reason.strip() or "Pebble requested confirmation.",
        "options": list(args.options),
    }
