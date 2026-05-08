"""Tests for ``pebble.workflows.weekly_pipeline_review`` — the
worked-example workflow.

Asserts:
  A. _is_closed_stage — case insensitive, contains-match for SF stage variants.
  B. _parse_date — ISO strings, datetimes, dates, garbage, None.
  C. compute_at_risk — close date inside window, in active stage, sorted ascending.
  D. compute_stale — last activity outside window OR null, sorted descending.
  E. compute_coverage — grouped by owner, summed, sorted, top_n capped.
  F. _opp_owner_label — Owner.Email / .Name / OwnerEmail / fallback to (unassigned).
  G. _account_name — Account.Name / .name / AccountName / "".
  H. _opp_amount — float coercion, None, garbage.
  I. _handle_aggregate_pipeline_views — happy path with mocked crm_bridge.
  J. _handle_aggregate_pipeline_views — crm_bridge returns None → error result.
  K. _handle_aggregate_pipeline_views — crm_bridge raises → error result.
  L. _handle_aggregate_pipeline_views — empty opps → ok=True with empty views.
  M. build_weekly_pipeline_review_plan — returns valid Plan with one step.
  N. AGGREGATE_PIPELINE_VIEWS_SPEC registered in DEFAULT_REGISTRY at import.
  O. Renderer — chart specs collected from aggregate_pipeline_views tool data.
  P. Renderer — chart specs collected from generate_chart tool data.
  Q. Args overrides — days_to_close / days_no_activity / top_n_coverage clamped.
"""

from __future__ import annotations

import os
import sys
from datetime import date, timedelta
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.orchestrator.executor import ExecutionOutcome, ExecutionResult
from pebble.orchestrator.renderer import _collect_charts, render
from pebble.orchestrator.schemas import (
    ChartSpec, Plan, PlanStep, ToolResult,
)
from pebble.orchestrator.tools import DEFAULT_REGISTRY, ToolContext
from pebble.workflows.weekly_pipeline_review import (
    AGGREGATE_PIPELINE_VIEWS_SPEC,
    _account_name,
    _handle_aggregate_pipeline_views,
    _is_closed_stage,
    _opp_amount,
    _opp_owner_label,
    _parse_date,
    build_weekly_pipeline_review_plan,
    compute_at_risk,
    compute_coverage,
    compute_stale,
)


# ---------------------------------------------------------------------------
# A. _is_closed_stage
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("stage,expected", [
    ("Closed Won", True),
    ("CLOSED WON", True),
    ("closed won", True),
    ("Closed Lost", True),
    ("Closed / Completed", True),
    ("Closed / Fulfilled", True),
    ("Lost", True),
    ("In Effect", False),
    ("Negotiation", False),
    ("Discovery", False),
    ("", False),
    (None, False),
])
def test_is_closed_stage(stage, expected):
    assert _is_closed_stage(stage) is expected


# ---------------------------------------------------------------------------
# B. _parse_date
# ---------------------------------------------------------------------------

def test_parse_date_iso_string():
    assert _parse_date("2026-05-08") == date(2026, 5, 8)


def test_parse_date_iso_with_time():
    # SF returns ISO datetimes for some fields; we keep just the date
    assert _parse_date("2026-05-08T12:34:56Z") == date(2026, 5, 8)


def test_parse_date_date_object():
    d = date(2026, 1, 15)
    assert _parse_date(d) == d


def test_parse_date_garbage_returns_none():
    assert _parse_date("not a date") is None
    assert _parse_date("2026/05/08") is None  # wrong format
    assert _parse_date(None) is None
    assert _parse_date("") is None


# ---------------------------------------------------------------------------
# C. compute_at_risk
# ---------------------------------------------------------------------------

def _opp(**kw):
    """Helper to build a Salesforce-shape opp dict."""
    base = {
        "Id": kw.get("id", "006X" + str(id(kw))),
        "Name": kw.get("name", "Test Opp"),
        "Amount": kw.get("amount", 1000.0),
        "StageName": kw.get("stage", "Negotiation"),
        "CloseDate": kw.get("close_date"),
        "LastActivityDate": kw.get("last_activity_date"),
        "Owner": {"Email": kw.get("owner_email", "alice@pursuit.org")},
        "Account": {"Name": kw.get("account_name", "Acme")},
    }
    return base


def test_compute_at_risk_filters_to_window():
    today = date(2026, 5, 8)
    opps = [
        _opp(name="In Window", close_date="2026-05-25"),    # 17d → in
        _opp(name="At Edge", close_date="2026-06-07"),       # 30d → in (≤ horizon)
        _opp(name="Over Horizon", close_date="2026-06-15"),  # 38d → out
        _opp(name="Past Date", close_date="2026-05-01"),     # past → out
    ]
    out = compute_at_risk(opps, today=today, days_to_close=30)
    names = {r["name"] for r in out}
    assert "In Window" in names
    assert "At Edge" in names
    assert "Over Horizon" not in names
    assert "Past Date" not in names


def test_compute_at_risk_excludes_closed_stages():
    today = date(2026, 5, 8)
    opps = [
        _opp(name="Won", close_date="2026-05-20", stage="Closed Won"),
        _opp(name="Open", close_date="2026-05-20", stage="Negotiation"),
    ]
    out = compute_at_risk(opps, today=today, days_to_close=30)
    assert len(out) == 1
    assert out[0]["name"] == "Open"


def test_compute_at_risk_sorted_by_closest_deadline():
    today = date(2026, 5, 8)
    opps = [
        _opp(name="Far", close_date="2026-06-01"),   # 24d
        _opp(name="Near", close_date="2026-05-12"),  # 4d
        _opp(name="Medium", close_date="2026-05-20"),  # 12d
    ]
    out = compute_at_risk(opps, today=today, days_to_close=30)
    names = [r["name"] for r in out]
    assert names == ["Near", "Medium", "Far"]


def test_compute_at_risk_empty_opps():
    assert compute_at_risk([]) == []
    assert compute_at_risk(None) == []


def test_compute_at_risk_missing_close_date_excluded():
    today = date(2026, 5, 8)
    opps = [_opp(name="No Date", close_date=None)]
    assert compute_at_risk(opps, today=today) == []


# ---------------------------------------------------------------------------
# D. compute_stale
# ---------------------------------------------------------------------------

def test_compute_stale_recent_activity_excluded():
    today = date(2026, 5, 8)
    # 60 days ago = 2026-03-09
    opps = [
        _opp(name="Recent", last_activity_date="2026-04-10"),  # 28d ago — fresh
        _opp(name="Old", last_activity_date="2026-02-01"),     # 96d ago — stale
    ]
    out = compute_stale(opps, today=today, days_no_activity=60)
    names = {r["name"] for r in out}
    assert "Old" in names
    assert "Recent" not in names


def test_compute_stale_null_activity_treated_as_stale():
    today = date(2026, 5, 8)
    opps = [_opp(name="Never", last_activity_date=None)]
    out = compute_stale(opps, today=today, days_no_activity=60)
    assert len(out) == 1
    assert out[0]["days_since_activity"] is None


def test_compute_stale_excludes_closed():
    today = date(2026, 5, 8)
    opps = [
        _opp(name="Won Old", last_activity_date="2026-01-01", stage="Closed Won"),
        _opp(name="Open Old", last_activity_date="2026-01-01", stage="Discovery"),
    ]
    out = compute_stale(opps, today=today, days_no_activity=60)
    assert len(out) == 1
    assert out[0]["name"] == "Open Old"


def test_compute_stale_sorted_stalest_first():
    today = date(2026, 5, 8)
    opps = [
        _opp(name="Mid", last_activity_date="2026-02-15"),  # ~82d ago
        _opp(name="Oldest", last_activity_date="2026-01-01"),  # ~127d ago
        _opp(name="Edge", last_activity_date="2026-03-08"),  # ~61d ago
    ]
    out = compute_stale(opps, today=today, days_no_activity=60)
    assert out[0]["name"] == "Oldest"
    assert out[-1]["name"] == "Edge"


# ---------------------------------------------------------------------------
# E. compute_coverage
# ---------------------------------------------------------------------------

def test_compute_coverage_groups_and_sums():
    opps = [
        _opp(owner_email="alice@x.org", amount=100_000),
        _opp(owner_email="alice@x.org", amount=50_000),
        _opp(owner_email="bob@x.org", amount=200_000),
    ]
    out = compute_coverage(opps)
    by_owner = {r["owner"]: r for r in out}
    assert by_owner["alice@x.org"]["amount"] == 150_000
    assert by_owner["alice@x.org"]["count"] == 2
    assert by_owner["bob@x.org"]["amount"] == 200_000


def test_compute_coverage_sorted_descending():
    opps = [
        _opp(owner_email="small@x.org", amount=10_000),
        _opp(owner_email="big@x.org", amount=1_000_000),
        _opp(owner_email="med@x.org", amount=100_000),
    ]
    out = compute_coverage(opps)
    owners = [r["owner"] for r in out]
    assert owners == ["big@x.org", "med@x.org", "small@x.org"]


def test_compute_coverage_top_n_caps_results():
    opps = [_opp(owner_email=f"u{i}@x.org", amount=i * 1000) for i in range(20)]
    out = compute_coverage(opps, top_n=5)
    assert len(out) == 5


def test_compute_coverage_excludes_closed():
    opps = [
        _opp(owner_email="a@x.org", amount=100, stage="Closed Won"),
        _opp(owner_email="b@x.org", amount=50, stage="Discovery"),
    ]
    out = compute_coverage(opps)
    owners = {r["owner"] for r in out}
    assert owners == {"b@x.org"}


# ---------------------------------------------------------------------------
# F. _opp_owner_label
# ---------------------------------------------------------------------------

def test_owner_label_email_preferred():
    assert _opp_owner_label({"Owner": {"Email": "x@y.com", "Name": "X"}}) == "x@y.com"


def test_owner_label_name_fallback():
    assert _opp_owner_label({"Owner": {"Name": "Alice"}}) == "Alice"


def test_owner_label_flat_email_field():
    assert _opp_owner_label({"OwnerEmail": "flat@x.com"}) == "flat@x.com"


def test_owner_label_unassigned_default():
    assert _opp_owner_label({}) == "(unassigned)"
    assert _opp_owner_label({"Owner": None}) == "(unassigned)"


# ---------------------------------------------------------------------------
# G. _account_name
# ---------------------------------------------------------------------------

def test_account_name_dict():
    assert _account_name({"Account": {"Name": "Acme"}}) == "Acme"


def test_account_name_lowercase_key():
    assert _account_name({"Account": {"name": "Lowercase"}}) == "Lowercase"


def test_account_name_flat_field():
    assert _account_name({"AccountName": "Flat"}) == "Flat"


def test_account_name_missing_returns_empty():
    assert _account_name({}) == ""


# ---------------------------------------------------------------------------
# H. _opp_amount
# ---------------------------------------------------------------------------

def test_opp_amount_float_coercion():
    assert _opp_amount({"Amount": "12345.67"}) == 12345.67
    assert _opp_amount({"Amount": 100}) == 100.0


def test_opp_amount_none_returns_zero():
    assert _opp_amount({"Amount": None}) == 0.0
    assert _opp_amount({}) == 0.0


def test_opp_amount_garbage_returns_zero():
    assert _opp_amount({"Amount": "bad"}) == 0.0


# ---------------------------------------------------------------------------
# I. _handle_aggregate_pipeline_views — happy path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_handle_aggregate_views_happy_path(monkeypatch):
    """Mock crm_bridge to return a synthetic dataset; verify the
    handler returns ok=True with the three views + charts."""
    today = date(2026, 5, 8)

    fake_opps = [
        _opp(name="A", amount=100_000, close_date="2026-05-20",
             last_activity_date="2026-04-30", owner_email="alice@x.org"),
        _opp(name="B", amount=50_000, close_date="2026-07-15",
             last_activity_date="2026-02-01", owner_email="bob@x.org"),
        _opp(name="C", amount=200_000, close_date=None,
             last_activity_date="2026-05-01", owner_email="alice@x.org",
             stage="Closed Won"),
    ]

    async def fake_get_opportunities(limit=500):
        return fake_opps

    from pebble import crm_bridge as _crm
    monkeypatch.setattr(_crm, "get_opportunities", fake_get_opportunities)

    ctx = ToolContext(user_email="rm@pursuit.org", conversation_id="c")
    result = await _handle_aggregate_pipeline_views({}, ctx)

    assert result.ok is True
    assert result.tool == "aggregate_pipeline_views"
    assert "summary" in result.data
    assert isinstance(result.data["charts"], list)
    assert len(result.data["charts"]) == 3
    # Verify the three chart titles include their threshold metadata
    titles = [c["title"] for c in result.data["charts"]]
    assert any("At-risk" in t for t in titles)
    assert any("Stale" in t for t in titles)
    assert any("coverage" in t.lower() for t in titles)
    # Open count excludes the Closed Won opp
    assert result.data["open_count"] == 2


@pytest.mark.asyncio
async def test_handle_aggregate_views_args_clamped(monkeypatch):
    """Out-of-range arg overrides get clamped to safe values."""
    async def fake_get_opportunities(limit=500):
        return []
    from pebble import crm_bridge as _crm
    monkeypatch.setattr(_crm, "get_opportunities", fake_get_opportunities)

    ctx = ToolContext(user_email="x", conversation_id="c")
    result = await _handle_aggregate_pipeline_views({
        "days_to_close": 99999,        # clamps to 365
        "days_no_activity": 0,         # clamps to 1
        "top_n_coverage": -5,          # clamps to 1
    }, ctx)
    assert result.ok is True
    assert result.data["days_to_close"] == 365
    assert result.data["days_no_activity"] == 1
    assert result.data["top_n_coverage"] == 1


# ---------------------------------------------------------------------------
# J. crm_bridge returns None → error
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_handle_aggregate_views_crm_bridge_none(monkeypatch):
    async def fake_get_opportunities(limit=500):
        return None
    from pebble import crm_bridge as _crm
    monkeypatch.setattr(_crm, "get_opportunities", fake_get_opportunities)

    ctx = ToolContext(user_email="x", conversation_id="c")
    result = await _handle_aggregate_pipeline_views({}, ctx)
    assert result.ok is False
    assert "None" in (result.error or "")


# ---------------------------------------------------------------------------
# K. crm_bridge raises → error
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_handle_aggregate_views_crm_bridge_raises(monkeypatch):
    async def fake_get_opportunities(limit=500):
        raise RuntimeError("simulated transport error")
    from pebble import crm_bridge as _crm
    monkeypatch.setattr(_crm, "get_opportunities", fake_get_opportunities)

    ctx = ToolContext(user_email="x", conversation_id="c")
    result = await _handle_aggregate_pipeline_views({}, ctx)
    assert result.ok is False
    assert "RuntimeError" in (result.error or "")


# ---------------------------------------------------------------------------
# L. Empty opps → ok with empty views
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_handle_aggregate_views_empty_opps(monkeypatch):
    async def fake_get_opportunities(limit=500):
        return []
    from pebble import crm_bridge as _crm
    monkeypatch.setattr(_crm, "get_opportunities", fake_get_opportunities)

    ctx = ToolContext(user_email="x", conversation_id="c")
    result = await _handle_aggregate_pipeline_views({}, ctx)
    assert result.ok is True
    assert result.data["open_count"] == 0
    assert result.data["at_risk"] == []
    assert result.data["stale"] == []
    assert result.data["coverage"] == []
    # All three charts still exist (with empty data arrays)
    assert len(result.data["charts"]) == 3
    for chart in result.data["charts"]:
        assert chart["data"] == []


# ---------------------------------------------------------------------------
# M. build_weekly_pipeline_review_plan
# ---------------------------------------------------------------------------

def test_build_plan_returns_valid_plan():
    plan = build_weekly_pipeline_review_plan()
    assert isinstance(plan, Plan)
    assert plan.user_query == "weekly pipeline review"
    assert len(plan.steps) == 1
    step = plan.steps[0]
    assert step.tool == "aggregate_pipeline_views"
    assert step.args["days_to_close"] == 30
    assert step.args["days_no_activity"] == 60
    assert step.args["top_n_coverage"] == 10


def test_build_plan_overridable_args():
    plan = build_weekly_pipeline_review_plan(
        user_query="custom",
        days_to_close=14, days_no_activity=30, top_n_coverage=5,
    )
    assert plan.user_query == "custom"
    step = plan.steps[0]
    assert step.args["days_to_close"] == 14
    assert step.args["days_no_activity"] == 30
    assert step.args["top_n_coverage"] == 5


# ---------------------------------------------------------------------------
# N. Registration
# ---------------------------------------------------------------------------

def test_aggregate_pipeline_views_registered_at_import():
    """Importing pebble.workflows triggers registration."""
    import pebble.workflows  # noqa: F401 — side effect: register
    assert "aggregate_pipeline_views" in DEFAULT_REGISTRY


def test_aggregate_pipeline_views_spec_metadata():
    spec = AGGREGATE_PIPELINE_VIEWS_SPEC
    assert spec.name == "aggregate_pipeline_views"
    assert spec.cost_estimate_usd == 0.0
    assert spec.requires_human is False
    assert "workflow" in spec.tags
    assert "pipeline" in spec.tags


# ---------------------------------------------------------------------------
# O. Renderer — collects charts from aggregate_pipeline_views
# ---------------------------------------------------------------------------

def test_renderer_collects_charts_from_aggregate_view():
    step_id = uuid4()
    plan = Plan(
        user_query="q",
        steps=(PlanStep(step_id=step_id, tool="aggregate_pipeline_views", args={}),),
    )
    fake_data = {
        "summary": "3 open opps",
        "charts": [
            {"chart_id": str(uuid4()), "kind": "bar", "title": "At-risk",
             "data": [{"name": "x", "amount": 100}],
             "x_key": "name", "y_keys": ["amount"]},
            {"chart_id": str(uuid4()), "kind": "bar", "title": "Stale",
             "data": [], "x_key": "name", "y_keys": ["amount"]},
        ],
        "open_count": 3, "total_open_amount": 100,
    }
    tool_results = {
        step_id: ToolResult(
            step_id=step_id, tool="aggregate_pipeline_views",
            ok=True, data=fake_data,
        ),
    }
    execution = ExecutionResult(
        outcome=ExecutionOutcome.COMPLETED, plan_id=plan.plan_id,
        completed_step_ids=[step_id], tool_results=tool_results,
    )
    final = render(plan=plan, execution=execution)
    assert len(final.charts) == 2
    assert final.charts[0].title == "At-risk"
    assert final.charts[1].title == "Stale"


# ---------------------------------------------------------------------------
# P. Renderer — collects from generate_chart shape too
# ---------------------------------------------------------------------------

def test_renderer_collects_charts_from_generate_chart():
    step_id = uuid4()
    plan = Plan(
        user_query="q",
        steps=(PlanStep(step_id=step_id, tool="generate_chart", args={}),),
    )
    fake_data = {
        "chart_id": str(uuid4()),
        "kind": "line",
        "title": "Revenue trend",
        "data": [{"month": "Jan", "rev": 100}, {"month": "Feb", "rev": 120}],
        "x_key": "month", "y_keys": ["rev"],
    }
    tool_results = {
        step_id: ToolResult(
            step_id=step_id, tool="generate_chart",
            ok=True, data=fake_data,
        ),
    }
    execution = ExecutionResult(
        outcome=ExecutionOutcome.COMPLETED, plan_id=plan.plan_id,
        completed_step_ids=[step_id], tool_results=tool_results,
    )
    final = render(plan=plan, execution=execution)
    assert len(final.charts) == 1
    assert final.charts[0].title == "Revenue trend"
    assert final.charts[0].kind == "line"


def test_collect_charts_skips_invalid_specs():
    """Malformed chart dicts get skipped, not crashed-on."""
    step_id = uuid4()
    tool_results = {
        step_id: ToolResult(
            step_id=step_id, tool="aggregate_pipeline_views",
            ok=True,
            data={"charts": [
                {"kind": "invalid_kind", "data": []},  # invalid kind regex
                {"kind": "bar", "data": [{"x": 1}], "title": "Valid"},
            ]},
        ),
    }
    charts = _collect_charts(tool_results)
    # The valid chart survives; invalid one is dropped
    assert len(charts) == 1
    assert charts[0].title == "Valid"


def test_collect_charts_skips_failed_tool_results():
    step_id = uuid4()
    tool_results = {
        step_id: ToolResult(
            step_id=step_id, tool="aggregate_pipeline_views",
            ok=False, error="some failure",
            data={"charts": [{"kind": "bar", "data": [], "title": "Should skip"}]},
        ),
    }
    charts = _collect_charts(tool_results)
    assert charts == ()
