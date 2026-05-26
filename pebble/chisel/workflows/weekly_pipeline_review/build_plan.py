"""Pre-baked Plan factory for /pipeline.

Engineer escape hatch (plan §3) — workflows with logic that doesn't
fit declarative ``steps[]`` ship a ``build_plan.py`` next to
``workflow.yaml`` exposing a ``build_plan`` callable. Autoload picks
it up and registers it in chisel's plan-builder map.
"""

from __future__ import annotations

from pebble.chisel.tools.aggregate_pipeline_views.compute import (
    DEFAULT_AT_RISK_DAYS_TO_CLOSE,
    DEFAULT_STALE_DAYS_NO_ACTIVITY,
    DEFAULT_TOP_N_COVERAGE,
)
from pebble.orchestrator.schemas import Plan, PlanStep


def build_plan(
    *,
    user_query: str = "weekly pipeline review",
    days_to_close: int = DEFAULT_AT_RISK_DAYS_TO_CLOSE,
    days_no_activity: int = DEFAULT_STALE_DAYS_NO_ACTIVITY,
    top_n_coverage: int = DEFAULT_TOP_N_COVERAGE,
    **_unused,
) -> Plan:
    """One step: call ``aggregate_pipeline_views`` with the configured
    windows. The orchestrator's ``run_stream_with_plan(allow_replan=False)``
    consumes this — no planner LLM call."""
    return Plan(
        user_query=user_query,
        steps=(
            PlanStep(
                tool="aggregate_pipeline_views",
                args={
                    "days_to_close": days_to_close,
                    "days_no_activity": days_no_activity,
                    "top_n_coverage": top_n_coverage,
                },
                expected_shape="summary text + 3 ChartSpec dicts",
                success_criteria="open_count is reported; charts non-empty when there's data",
            ),
        ),
        rationale=(
            "Workflow: weekly pipeline review. Aggregates at-risk, "
            "stale, and coverage views from open opportunities."
        ),
        estimated_tool_calls=1,
        estimated_cost_usd=0.0,
    )
