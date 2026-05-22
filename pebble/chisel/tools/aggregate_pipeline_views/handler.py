"""aggregate_pipeline_views — one SF call, three views.

Why one tool instead of three:
  * One SF API call (vs three). Friendlier to the rate limit.
  * Identical code path whether the user typed /pipeline or asked
    "show me the weekly pipeline review" — planner picks this same
    tool, no duplication.
  * Atomic: SF failure surfaces one clear error, not three stuck states.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from pebble.chisel.handler_adapter import HandlerContext

from .compute import (
    DEFAULT_AT_RISK_DAYS_TO_CLOSE,
    DEFAULT_STALE_DAYS_NO_ACTIVITY,
    DEFAULT_TOP_N_COVERAGE,
    chart_spec,
    compute_at_risk,
    compute_coverage,
    compute_stale,
    is_closed_stage,
    opp_amount,
)


class Input(BaseModel):
    days_to_close: int = Field(
        default=DEFAULT_AT_RISK_DAYS_TO_CLOSE, ge=1, le=365,
        description="At-risk window in days (close-date < this). Default 30.",
    )
    days_no_activity: int = Field(
        default=DEFAULT_STALE_DAYS_NO_ACTIVITY, ge=1, le=365,
        description="Stale threshold in days (no activity for this long). Default 60.",
    )
    top_n_coverage: int = Field(
        default=DEFAULT_TOP_N_COVERAGE, ge=1, le=50,
        description="Number of owners to include in coverage chart. Default 10.",
    )


class PipelineFetchError(Exception):
    """SF / crm_bridge transport or auth failure."""


async def run(args: Input, ctx: HandlerContext) -> dict[str, Any]:
    # Lazy import — crm_bridge imports request_context which calls back
    # into pebble.* during attribution, creating a circular dep at
    # module load.
    from pebble import crm_bridge

    opps = await crm_bridge.get_opportunities(limit=500)
    if opps is None:
        raise PipelineFetchError(
            "crm_bridge.get_opportunities returned None (auth or transport failure)",
        )

    at_risk = compute_at_risk(opps, days_to_close=args.days_to_close)
    stale = compute_stale(opps, days_no_activity=args.days_no_activity)
    coverage = compute_coverage(opps, top_n=args.top_n_coverage)

    total_open = sum(opp_amount(o) for o in opps if not is_closed_stage(o.get("StageName")))
    open_count = sum(1 for o in opps if not is_closed_stage(o.get("StageName")))

    summary = (
        f"**Weekly pipeline review** — {open_count} open opportunities "
        f"totaling ${total_open:,.0f}.\n"
        f"  • {len(at_risk)} at-risk (close < {args.days_to_close}d)\n"
        f"  • {len(stale)} stale (no activity in {args.days_no_activity}d)\n"
        f"  • Top {min(args.top_n_coverage, len(coverage))} owners shown by coverage."
    )

    charts = [
        chart_spec(
            kind="bar",
            title=f"At-risk opportunities (close <{args.days_to_close}d)",
            data=[{
                "name": r["name"][:40], "amount": r["amount"],
                "owner": r["owner"], "days_to_close": r["days_to_close"],
            } for r in at_risk],
            x_key="name", y_keys=["amount"],
        ),
        chart_spec(
            kind="bar",
            title=f"Stale opportunities (no activity {args.days_no_activity}+ days)",
            data=[{
                "name": r["name"][:40], "amount": r["amount"],
                "owner": r["owner"],
                "days_since_activity": r["days_since_activity"],
            } for r in stale],
            x_key="name", y_keys=["amount"],
        ),
        chart_spec(
            kind="bar",
            title=f"Pipeline coverage by owner (top {args.top_n_coverage})",
            data=[{
                "owner": r["owner"], "amount": r["amount"], "count": r["count"],
            } for r in coverage],
            x_key="owner", y_keys=["amount"],
        ),
    ]

    return {
        "summary": summary,
        "charts": charts,
        "at_risk": at_risk,
        "stale": stale,
        "coverage": coverage,
        "open_count": open_count,
        "total_open_amount": total_open,
        "days_to_close": args.days_to_close,
        "days_no_activity": args.days_no_activity,
        "top_n_coverage": args.top_n_coverage,
    }
