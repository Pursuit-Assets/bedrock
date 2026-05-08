"""Weekly pipeline review — the worked example workflow.

Three views that an RM / executive checks weekly:

  * **At-risk renewals** — opportunities with close date inside 30 days,
    in an active stage, lacking recent activity. Surface them so
    someone follows up before the deadline slides.
  * **Stale opportunities** — open opps with no logged activity in 60+
    days. The pipeline-hygiene metric: are we actually working these?
  * **Coverage by owner** — sum(amount) grouped by owner_email,
    descending. The "who's carrying weight this quarter" view.

Two entry points produce identical output:

  1. ``/pipeline`` slash command — the router classifies as
     ``level=2, intent="workflow_weekly_pipeline_review"``.
     ``handlers.dispatch_handler`` runs
     ``build_weekly_pipeline_review_plan()`` → orchestrator's
     ``run_stream_with_plan(plan, allow_replan=False)``. No planner
     LLM call; deterministic, free.
  2. Natural-language query like "show me the weekly pipeline review"
     — the L1 planner sees ``aggregate_pipeline_views`` in its tool
     list and emits a plan with this tool. Planner LLM call ($) but
     same downstream tool execution.

Why both paths: the slash command is fastest-path for power users.
The tool entry exposes the same compound view to the planner so
casual users get it via NL too. Architecture-doc workflow-vs-agent
pattern materialized.

Data backend
------------

v1.0 calls ``crm_bridge.get_opportunities()`` (live Salesforce REST,
same source as ``handlers.level0.handle_l0``). When ``sf_*_mirror``
tables ship (PARKED item 7), this swaps to SQL against the mirror
without changing the tool's output shape — callers depend on the
ToolResult shape, not the data path.

The choice of "live SF REST" not "SF SOQL via mirror" trades:

  * fast to ship, no mirror dependency
  * 1 SF API call per workflow run (counts against SF's rate limit)
  * same SF stage labels as the rest of the app — no drift

Stages
------

We use a conservative set of "active" stages — anything that's not
explicitly closed-won/closed-lost. Per memory ``feedback_sf_stages_sacred``
SF stages are sacred; the workflow does NOT collapse stage values, just
filters on a known-closed set. Anything not in that set counts as
active. Defensive against new stages getting added mid-quarter.
"""

from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional
from uuid import uuid4

from ..orchestrator.schemas import Plan, PlanStep, ToolResult
from ..orchestrator.tools import (
    DEFAULT_REGISTRY, ToolContext, ToolSpec, make_input_schema,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Stage classification — what counts as "open / active" for this workflow.
# ---------------------------------------------------------------------------

# Anything matching these (case-insensitive contains) is closed; everything
# else counts as active. Safer than an allowlist — new stages added later
# default to active rather than disappearing from the workflow.
_CLOSED_STAGE_MARKERS: frozenset[str] = frozenset({
    "closed won",
    "closed lost",
    "closed completed",
    "closed / completed",
    "closed / fulfilled",
    "lost",
})


def _is_closed_stage(stage: Optional[str]) -> bool:
    if not stage:
        return False
    s = stage.strip().lower()
    for marker in _CLOSED_STAGE_MARKERS:
        if marker in s:
            return True
    return False


# ---------------------------------------------------------------------------
# Aggregation thresholds — defaults; overridable per call.
# ---------------------------------------------------------------------------

DEFAULT_AT_RISK_DAYS_TO_CLOSE = 30
DEFAULT_STALE_DAYS_NO_ACTIVITY = 60
DEFAULT_TOP_N_COVERAGE = 10


# ---------------------------------------------------------------------------
# Pure compute helpers — no I/O, easy to test in isolation.
# ---------------------------------------------------------------------------

def _parse_date(value: Any) -> Optional[date]:
    """Salesforce returns dates as ISO strings — parse defensively.
    Returns None on missing or unparseable; callers decide policy."""
    if not value:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        # Strip Z / time component if present
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _opp_amount(opp: dict[str, Any]) -> float:
    raw = opp.get("Amount")
    if raw is None:
        return 0.0
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


def _opp_owner_label(opp: dict[str, Any]) -> str:
    """Pull the owner identifier — email preferred (stable), fallback
    to owner name. Defaults to '(unassigned)' so the chart has a
    bucket rather than dropping rows.
    """
    owner = opp.get("Owner")
    if isinstance(owner, dict):
        email = owner.get("Email") or owner.get("email")
        if email:
            return str(email)
        name = owner.get("Name") or owner.get("name")
        if name:
            return str(name)
    # Some endpoints flatten Owner.* into the top dict
    if opp.get("OwnerEmail"):
        return str(opp["OwnerEmail"])
    if opp.get("Owner__Email"):
        return str(opp["Owner__Email"])
    return "(unassigned)"


def _clamp_int_arg(value: Any, default: int, *, lo: int, hi: int) -> int:
    """Coerce ``value`` to int, clamp to [lo, hi], default on garbage.

    Treats None and missing as 'use default', but a valid 0 IS the
    user's choice — ``or`` short-circuits would silently override
    the user's 0 with the default.
    """
    if value is None:
        return max(lo, min(default, hi))
    try:
        v = int(value)
    except (TypeError, ValueError):
        v = default
    return max(lo, min(v, hi))


def _account_name(opp: dict[str, Any]) -> str:
    acct = opp.get("Account")
    if isinstance(acct, dict):
        n = acct.get("Name") or acct.get("name")
        if n:
            return str(n)
    if opp.get("AccountName"):
        return str(opp["AccountName"])
    return ""


def compute_at_risk(
    opps: list[dict[str, Any]],
    *,
    today: Optional[date] = None,
    days_to_close: int = DEFAULT_AT_RISK_DAYS_TO_CLOSE,
) -> list[dict[str, Any]]:
    """Open opps whose close_date is within ``days_to_close`` from
    today, sorted by closest first. The list shape matches what
    Recharts wants (each row = one chart bar).
    """
    today = today or datetime.now(tz=timezone.utc).date()
    horizon = today + timedelta(days=days_to_close)

    out: list[dict[str, Any]] = []
    for opp in opps or []:
        if _is_closed_stage(opp.get("StageName")):
            continue
        cd = _parse_date(opp.get("CloseDate"))
        if cd is None or cd < today or cd > horizon:
            continue
        out.append({
            "name": str(opp.get("Name") or "(unnamed)")[:80],
            "account": _account_name(opp),
            "owner": _opp_owner_label(opp),
            "amount": _opp_amount(opp),
            "stage": str(opp.get("StageName") or ""),
            "close_date": cd.isoformat(),
            "days_to_close": (cd - today).days,
            "id": str(opp.get("Id") or ""),
        })
    # Closest deadline first.
    out.sort(key=lambda r: r["days_to_close"])
    return out


def compute_stale(
    opps: list[dict[str, Any]],
    *,
    today: Optional[date] = None,
    days_no_activity: int = DEFAULT_STALE_DAYS_NO_ACTIVITY,
) -> list[dict[str, Any]]:
    """Open opps with no recent activity in ``days_no_activity`` days.

    Sources ``LastActivityDate`` (SF rolls up activity onto the opp).
    Missing date is interpreted as 'never had activity' — most likely
    stale by definition; included.
    """
    today = today or datetime.now(tz=timezone.utc).date()
    cutoff = today - timedelta(days=days_no_activity)

    out: list[dict[str, Any]] = []
    for opp in opps or []:
        if _is_closed_stage(opp.get("StageName")):
            continue
        last = _parse_date(opp.get("LastActivityDate"))
        if last is not None and last >= cutoff:
            continue
        days_since = (today - last).days if last else None
        out.append({
            "name": str(opp.get("Name") or "(unnamed)")[:80],
            "account": _account_name(opp),
            "owner": _opp_owner_label(opp),
            "amount": _opp_amount(opp),
            "stage": str(opp.get("StageName") or ""),
            "last_activity_date": last.isoformat() if last else None,
            "days_since_activity": days_since,
            "id": str(opp.get("Id") or ""),
        })
    # Stalest first (None last_activity = effectively oldest)
    out.sort(
        key=lambda r: r["days_since_activity"] if r["days_since_activity"] is not None else 10**6,
        reverse=True,
    )
    return out


def compute_coverage(
    opps: list[dict[str, Any]],
    *,
    top_n: int = DEFAULT_TOP_N_COVERAGE,
) -> list[dict[str, Any]]:
    """Sum(open amount) by owner, descending, top N.

    Excludes closed stages — coverage is about WHO is carrying open
    pipeline weight, not historical wins.
    """
    by_owner: dict[str, dict[str, Any]] = {}
    for opp in opps or []:
        if _is_closed_stage(opp.get("StageName")):
            continue
        owner = _opp_owner_label(opp)
        bucket = by_owner.setdefault(owner, {"owner": owner, "amount": 0.0, "count": 0})
        bucket["amount"] += _opp_amount(opp)
        bucket["count"] += 1
    rows = sorted(by_owner.values(), key=lambda r: r["amount"], reverse=True)
    return rows[:top_n]


# ---------------------------------------------------------------------------
# Chart spec composition — build one ChartSpec dict per view.
# ---------------------------------------------------------------------------

def _chart_spec(
    *, kind: str, title: str, data: list[dict[str, Any]],
    x_key: str, y_keys: list[str],
) -> dict[str, Any]:
    """Same shape as ``schemas.ChartSpec`` (and what generate_chart
    emits). Inlined here so the workflow doesn't have to round-trip
    through generate_chart for every chart — we already have the data
    aggregated, no need for another tool call's overhead.
    """
    return {
        "chart_id": str(uuid4()),
        "kind": kind,
        "title": title,
        "data": data,
        "x_key": x_key,
        "y_keys": y_keys,
    }


# ---------------------------------------------------------------------------
# aggregate_pipeline_views — the tool that does it all.
# ---------------------------------------------------------------------------

async def _handle_aggregate_pipeline_views(
    args: dict[str, Any], ctx: ToolContext,
) -> ToolResult:
    """One tool, three views.

    Calls ``crm_bridge.get_opportunities()`` once, then computes
    at-risk / stale / coverage in pure Python. Returns a structured
    payload the renderer extracts (a) prose summary text and (b)
    three Recharts-shape chart specs from.

    Why one tool not three:
      * One SF API call (vs three). Friendlier to the SF rate limit.
      * Identical workflow + agent code path — no duplication if the
        planner picks this tool for natural-language requests.
      * Atomic — if the SF call fails, the user gets one clear error
        instead of three stuck states.

    When mirror tables land (PARKED item 7), this becomes one SQL
    call against the mirror with the same output shape — same
    contract, less SF dependency.
    """
    started = time.perf_counter()

    # Lazy import — workflows live inside pebble package; importing
    # crm_bridge at module load creates a circular-ish dep with
    # request_context which calls into pebble.* during attribution.
    from .. import crm_bridge

    try:
        opps = await crm_bridge.get_opportunities(limit=500)
    except Exception as e:
        logger.exception("aggregate_pipeline_views.get_opportunities_failed")
        return ToolResult(
            step_id=uuid4(), tool="aggregate_pipeline_views", ok=False,
            error=f"aggregate_pipeline_views: failed to fetch opportunities ({type(e).__name__})",
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    if opps is None:
        return ToolResult(
            step_id=uuid4(), tool="aggregate_pipeline_views", ok=False,
            error="aggregate_pipeline_views: crm_bridge.get_opportunities returned None (auth or transport failure)",
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    # Apply optional overrides from args. Defensive: validate ranges
    # before the compute functions see them. ``or`` would short-circuit
    # on a legitimate 0 — use explicit None check + try/int + clamp.
    days_to_close = _clamp_int_arg(
        args.get("days_to_close"), DEFAULT_AT_RISK_DAYS_TO_CLOSE, lo=1, hi=365,
    )
    days_no_activity = _clamp_int_arg(
        args.get("days_no_activity"), DEFAULT_STALE_DAYS_NO_ACTIVITY, lo=1, hi=365,
    )
    top_n = _clamp_int_arg(
        args.get("top_n_coverage"), DEFAULT_TOP_N_COVERAGE, lo=1, hi=50,
    )

    at_risk = compute_at_risk(opps, days_to_close=days_to_close)
    stale = compute_stale(opps, days_no_activity=days_no_activity)
    coverage = compute_coverage(opps, top_n=top_n)

    # Total open pipeline (excludes closed) — useful summary stat.
    total_open = sum(_opp_amount(o) for o in opps if not _is_closed_stage(o.get("StageName")))
    open_count = sum(1 for o in opps if not _is_closed_stage(o.get("StageName")))

    summary = (
        f"**Weekly pipeline review** — {open_count} open opportunities "
        f"totaling ${total_open:,.0f}.\n"
        f"  • {len(at_risk)} at-risk (close < {days_to_close}d)\n"
        f"  • {len(stale)} stale (no activity in {days_no_activity}d)\n"
        f"  • Top {min(top_n, len(coverage))} owners shown by coverage."
    )

    charts = [
        _chart_spec(
            kind="bar", title=f"At-risk opportunities (close <{days_to_close}d)",
            data=[{
                "name": r["name"][:40], "amount": r["amount"],
                "owner": r["owner"], "days_to_close": r["days_to_close"],
            } for r in at_risk],
            x_key="name", y_keys=["amount"],
        ),
        _chart_spec(
            kind="bar", title=f"Stale opportunities (no activity {days_no_activity}+ days)",
            data=[{
                "name": r["name"][:40], "amount": r["amount"],
                "owner": r["owner"],
                "days_since_activity": r["days_since_activity"],
            } for r in stale],
            x_key="name", y_keys=["amount"],
        ),
        _chart_spec(
            kind="bar", title=f"Pipeline coverage by owner (top {top_n})",
            data=[{
                "owner": r["owner"], "amount": r["amount"], "count": r["count"],
            } for r in coverage],
            x_key="owner", y_keys=["amount"],
        ),
    ]

    duration_ms = int((time.perf_counter() - started) * 1000)
    return ToolResult(
        step_id=uuid4(), tool="aggregate_pipeline_views", ok=True,
        data={
            "summary": summary,
            "charts": charts,
            "at_risk": at_risk,
            "stale": stale,
            "coverage": coverage,
            "open_count": open_count,
            "total_open_amount": total_open,
            "days_to_close": days_to_close,
            "days_no_activity": days_no_activity,
            "top_n_coverage": top_n,
        },
        duration_ms=duration_ms,
    )


AGGREGATE_PIPELINE_VIEWS_SPEC = ToolSpec(
    name="aggregate_pipeline_views",
    description=(
        "Generate a three-view pipeline review: at-risk opportunities "
        "(close date within N days), stale opportunities (no activity "
        "in M days), and coverage by owner. Use for queries like "
        "'weekly pipeline review', 'what's at risk', 'who's carrying "
        "the most pipeline'. One SF call; returns a summary string + "
        "three chart specs the renderer embeds inline."
    ),
    input_schema=make_input_schema(
        properties={
            "days_to_close": {
                "type": "integer", "minimum": 1, "maximum": 365,
                "description": "At-risk window in days (close-date < this). Default 30.",
            },
            "days_no_activity": {
                "type": "integer", "minimum": 1, "maximum": 365,
                "description": "Stale threshold in days (no activity for this long). Default 60.",
            },
            "top_n_coverage": {
                "type": "integer", "minimum": 1, "maximum": 50,
                "description": "Number of owners to include in coverage chart. Default 10.",
            },
        },
        required_keys=[],   # all optional — sane defaults
    ),
    handler=_handle_aggregate_pipeline_views,
    cost_estimate_usd=0.0,    # one /api/salesforce/opportunities call; no LLM
    tags=("workflow", "pipeline"),
)


# ---------------------------------------------------------------------------
# Pre-baked Plan for the slash-command path.
# ---------------------------------------------------------------------------

def build_weekly_pipeline_review_plan(
    *,
    user_query: str = "weekly pipeline review",
    days_to_close: int = DEFAULT_AT_RISK_DAYS_TO_CLOSE,
    days_no_activity: int = DEFAULT_STALE_DAYS_NO_ACTIVITY,
    top_n_coverage: int = DEFAULT_TOP_N_COVERAGE,
) -> Plan:
    """Construct a deterministic Plan for the /pipeline slash command.

    One step: call ``aggregate_pipeline_views``. The renderer +
    evaluator handle the rest. ``ChatOrchestrator.run_stream_with_plan(
    plan, allow_replan=False)`` consumes this — no planner LLM call.
    """
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


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

def register_workflow_tools(registry=None) -> None:
    """Idempotently register workflow tools on ``registry`` (default
    process-wide). Called at package import time so the planner sees
    these tools without explicit setup. Tests can pass an isolated
    registry to avoid cross-test interference.
    """
    reg = registry if registry is not None else DEFAULT_REGISTRY
    if AGGREGATE_PIPELINE_VIEWS_SPEC.name not in reg:
        reg.register(AGGREGATE_PIPELINE_VIEWS_SPEC)
