"""generate_chart — pure shape transformer for FE Recharts rendering.

No I/O, no LLM call. Validates inputs + emits a ChartSpec-shaped payload
the renderer hands to a Recharts component. Kept in sync with
``ChartSpec.kind`` in ``pebble.orchestrator.schemas``.
"""

from __future__ import annotations

from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field

from pebble.chisel.handler_adapter import HandlerContext


ChartKind = Literal["line", "bar", "pie", "area", "scatter", "funnel"]


class Input(BaseModel):
    kind: ChartKind = Field(
        description=(
            "Chart type. bar=category counts; line=time series; "
            "pie=parts of whole; area=cumulative; scatter=2D distribution; "
            "funnel=stage progression."
        ),
    )
    data: list[dict[str, Any]] = Field(
        description="List of row objects. Each row is {<x_key>: <category>, <y_keys[i]>: <number>}.",
    )
    title: str = Field(default="", description="Short chart title shown above the plot.")
    x_key: str | None = Field(
        default=None,
        description="Field name in data rows used for the X-axis category / ordinal.",
    )
    y_keys: tuple[str, ...] = Field(
        default=(),
        description="Field names in data rows used as numeric Y-series. Multiple keys = grouped/stacked.",
    )


async def run(args: Input, ctx: HandlerContext) -> dict[str, Any]:
    return {
        "chart_id": str(uuid4()),
        "kind": args.kind,
        "title": args.title,
        "data": args.data,
        "x_key": args.x_key,
        "y_keys": list(args.y_keys),
        "row_count": len(args.data),
    }
