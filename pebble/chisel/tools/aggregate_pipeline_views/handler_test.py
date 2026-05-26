"""Tests for aggregate_pipeline_views (chisel-migrated).

Compute helpers tested in isolation; handler tested end-to-end with a
monkeypatched crm_bridge.get_opportunities.
"""

from __future__ import annotations

import os
import sys
from datetime import date
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))

from pebble.chisel.handler_adapter import HandlerContext
from pebble.chisel.tools.aggregate_pipeline_views.compute import (
    compute_at_risk,
    compute_coverage,
    compute_stale,
    is_closed_stage,
    opp_amount,
    opp_owner_label,
)
from pebble.chisel.tools.aggregate_pipeline_views.handler import (
    Input,
    PipelineFetchError,
    run,
)
from pebble.orchestrator.tools import ToolContext


# ---------------------------------------------------------------------------
# compute.py — pure unit tests
# ---------------------------------------------------------------------------

def test_is_closed_stage_marker_match() -> None:
    assert is_closed_stage("Closed Won")
    assert is_closed_stage("closed lost")
    assert is_closed_stage("Closed / Completed")
    assert not is_closed_stage("Negotiation")
    assert not is_closed_stage(None)


def test_opp_amount_handles_garbage() -> None:
    assert opp_amount({"Amount": 100}) == 100.0
    assert opp_amount({"Amount": "250.5"}) == 250.5
    assert opp_amount({"Amount": None}) == 0.0
    assert opp_amount({"Amount": "n/a"}) == 0.0


def test_opp_owner_label_prefers_email() -> None:
    assert opp_owner_label({"Owner": {"Email": "rm@x.org", "Name": "RM"}}) == "rm@x.org"
    assert opp_owner_label({"Owner": {"Name": "RM"}}) == "RM"
    assert opp_owner_label({"OwnerEmail": "rm2@x.org"}) == "rm2@x.org"
    assert opp_owner_label({}) == "(unassigned)"


def test_compute_at_risk_filters_and_sorts() -> None:
    today = date(2026, 5, 22)
    opps = [
        {"Id": "1", "Name": "Acme", "StageName": "Negotiation", "CloseDate": "2026-05-30", "Amount": 100, "Owner": {"Email": "a@x"}},
        {"Id": "2", "Name": "Beta", "StageName": "Negotiation", "CloseDate": "2026-06-25", "Amount": 200, "Owner": {"Email": "b@x"}},  # outside 30d
        {"Id": "3", "Name": "Won", "StageName": "Closed Won", "CloseDate": "2026-05-25", "Amount": 999, "Owner": {"Email": "c@x"}},  # closed
        {"Id": "4", "Name": "Gamma", "StageName": "Discovery", "CloseDate": "2026-05-25", "Amount": 50, "Owner": {"Email": "d@x"}},
    ]
    result = compute_at_risk(opps, today=today, days_to_close=30)
    assert [r["Id" if False else "id"] for r in result] == ["4", "1"]  # sorted by days_to_close asc
    assert all(r["amount"] > 0 for r in result)


def test_compute_stale_ranks_oldest_first() -> None:
    today = date(2026, 5, 22)
    opps = [
        {"Id": "1", "Name": "Fresh", "StageName": "Discovery", "LastActivityDate": "2026-05-20", "Amount": 100},  # recent → excluded
        {"Id": "2", "Name": "Old", "StageName": "Discovery", "LastActivityDate": "2026-01-01", "Amount": 50},
        {"Id": "3", "Name": "Never", "StageName": "Discovery", "Amount": 25},  # no activity
        {"Id": "4", "Name": "Won", "StageName": "Closed Won", "Amount": 999},  # excluded
    ]
    result = compute_stale(opps, today=today, days_no_activity=60)
    # "Never" comes first (10**6), then "Old"
    assert [r["name"] for r in result] == ["Never", "Old"]


def test_compute_coverage_sums_by_owner_excluding_closed() -> None:
    opps = [
        {"StageName": "Negotiation", "Amount": 100, "Owner": {"Email": "a@x"}},
        {"StageName": "Negotiation", "Amount": 50, "Owner": {"Email": "a@x"}},
        {"StageName": "Discovery", "Amount": 200, "Owner": {"Email": "b@x"}},
        {"StageName": "Closed Won", "Amount": 999, "Owner": {"Email": "a@x"}},  # excluded
    ]
    cov = compute_coverage(opps, top_n=5)
    assert cov[0]["owner"] == "b@x" and cov[0]["amount"] == 200.0
    assert cov[1]["owner"] == "a@x" and cov[1]["amount"] == 150.0


# ---------------------------------------------------------------------------
# handler.py — end-to-end with monkeypatched crm_bridge
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_handler_returns_summary_and_three_charts(monkeypatch: pytest.MonkeyPatch) -> None:
    opps = [
        {"Id": "1", "Name": "Acme", "StageName": "Negotiation", "Amount": 100,
         "Owner": {"Email": "a@x"}, "CloseDate": "2099-01-01", "LastActivityDate": "2026-05-20"},
        {"Id": "2", "Name": "Beta", "StageName": "Closed Won", "Amount": 999,
         "Owner": {"Email": "b@x"}},
    ]
    from pebble import crm_bridge as cb
    monkeypatch.setattr(cb, "get_opportunities", AsyncMock(return_value=opps))

    hctx = HandlerContext(ToolContext(user_email="rm@pursuit.org", conversation_id="c1"))
    out = await run(Input(), hctx)

    assert "Weekly pipeline review" in out["summary"]
    assert out["open_count"] == 1
    assert out["total_open_amount"] == 100.0
    assert len(out["charts"]) == 3
    assert {c["kind"] for c in out["charts"]} == {"bar"}


@pytest.mark.asyncio
async def test_handler_raises_when_get_opportunities_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    from pebble import crm_bridge as cb
    monkeypatch.setattr(cb, "get_opportunities", AsyncMock(return_value=None))

    hctx = HandlerContext(ToolContext(user_email="rm@pursuit.org", conversation_id="c1"))
    with pytest.raises(PipelineFetchError):
        await run(Input(), hctx)
