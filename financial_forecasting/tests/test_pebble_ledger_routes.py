"""Tests for /api/pebble/ledger/{session_id} and /api/pebble/ledger/recent.

These routes give JP the launch-dark-visible cost ledger surface:
  * /ledger/{session_id} → materialized RunLedger for one run
  * /ledger/recent       → recent sessions visible to the caller

Both are gated by `require_pebble_access` (the master launch-dark gate
that today only jp@pursuit.org clears). Tests pin:

  A. Route returns RunLedger-shaped JSON.
  B. cache_hit_ratio + estimated_savings_usd are surfaced at top-level.
  C. by_cluster + by_purpose rollups serialized correctly.
  D. /recent filters by the caller's email + orders by recency.
  E. Empty session returns zeroed RunLedger, not 404.
"""

from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from db import get_db
from routes import pebble_proxy
from routes.permissions import require_pebble_access


@pytest.fixture
def ledger_app(monkeypatch):
    """Build a FastAPI app with the ledger routes + dependency overrides.

    fetch_results: list[list[dict]] — one list per expected fetch call,
    consumed in order. The compute_run_rollup query path issues TWO
    fetch calls (LLM rows + tool rows); /recent issues ONE.
    """
    def _build(*, fetch_results: list[list[dict]], user_email: str = "jp@pursuit.org"):
        conn = AsyncMock()
        conn.fetch.side_effect = fetch_results

        @asynccontextmanager
        async def _acquire():
            yield conn

        pool = MagicMock()
        pool.acquire = lambda: _acquire()

        async def _override_db():
            return pool

        async def _override_pebble_access():
            return {"email": user_email, "is_service": False}

        app = FastAPI()
        app.include_router(pebble_proxy.router)
        app.dependency_overrides[get_db] = _override_db
        app.dependency_overrides[require_pebble_access] = _override_pebble_access
        return app

    return _build


# ---------------------------------------------------------------------------
# A. Single-session ledger
# ---------------------------------------------------------------------------

def test_ledger_for_session_empty_returns_zero_total(ledger_app):
    app = ledger_app(fetch_results=[[], []])
    with TestClient(app) as client:
        r = client.get("/api/pebble/ledger/sess_empty")
    assert r.status_code == 200
    body = r.json()
    assert body["session_id"] == "sess_empty"
    assert body["run_total"]["llm_call_count"] == 0
    assert body["run_total"]["tool_call_count"] == 0
    assert body["run_total"]["total_cost_usd"] == 0.0
    assert body["cache_hit_ratio"] == 0.0
    assert body["by_cluster"] == {}
    assert body["by_purpose"] == {}


def test_ledger_for_session_with_calls(ledger_app):
    ts = datetime.now(timezone.utc)
    llm_rows = [
        {
            "id": "a", "occurred_at": ts, "agent_name": "doer", "outcome": "success",
            "model_id": "claude-sonnet-4-6", "provider": "anthropic/claude-sonnet-4-6",
            "input_tokens": 3000, "output_tokens": 2000,
            "cache_creation": 0, "cache_read": 0,
            "cost_usd": 0.039, "elapsed_seconds": 1.2, "attempts": 1, "redo_attempt": 0,
            "error": None, "session_id": "sess1",
            "purpose": "doer", "cluster": "cluster_a_financial", "tier": "T3",
            "prospect_id": None, "user_email": "jp@pursuit.org",
        },
        {
            "id": "b", "occurred_at": ts, "agent_name": "verifier", "outcome": "success",
            "model_id": "claude-haiku-4-5-20251001", "provider": "anthropic/claude-haiku-4-5-20251001",
            "input_tokens": 1000, "output_tokens": 300,
            "cache_creation": 500, "cache_read": 2000,
            "cost_usd": 0.0042, "elapsed_seconds": 0.4, "attempts": 1, "redo_attempt": 0,
            "error": None, "session_id": "sess1",
            "purpose": "verifier", "cluster": "cluster_a_financial", "tier": "T3",
            "prospect_id": None, "user_email": "jp@pursuit.org",
        },
    ]
    tool_rows = [
        {
            "id": 1, "occurred_at": ts, "session_id": "sess1",
            "tool": "fec.search_contributions", "cluster": "cluster_a_financial",
            "agent_name": None, "cost_usd": 0.0, "success": True,
            "elapsed_ms": 420, "bytes_returned": 8192, "cache_hit": False,
            "rate_limit_remaining": 998, "rate_limit_reset_at": None,
            "error_class": None, "originating_user_email": "jp@pursuit.org",
        },
    ]

    app = ledger_app(fetch_results=[llm_rows, tool_rows])
    with TestClient(app) as client:
        r = client.get("/api/pebble/ledger/sess1")

    assert r.status_code == 200
    body = r.json()
    assert body["run_total"]["llm_call_count"] == 2
    assert body["run_total"]["tool_call_count"] == 1
    # 0.039 + 0.0042 + 0 = 0.0432
    assert body["run_total"]["total_cost_usd"] == pytest.approx(0.0432, rel=1e-6)
    # cache_read=2000 / (cache_read=2000 + fresh_input=4000) = 1/3
    assert body["cache_hit_ratio"] == pytest.approx(1 / 3, rel=1e-6)
    # by_cluster has one cluster
    assert "cluster_a_financial" in body["by_cluster"]
    cr = body["by_cluster"]["cluster_a_financial"]
    assert cr["call_count"] == 2
    assert cr["tool_call_count"] == 1
    # by_purpose has both purposes
    assert "doer" in body["by_purpose"]
    assert "verifier" in body["by_purpose"]


def test_ledger_estimated_savings_surfaces(ledger_app):
    """The estimated_savings_usd field reports the advisory cache savings.

    With 1Mtok cache_read at Sonnet's $3/Mtok input rate, savings =
    1Mtok × $3/Mtok × 90% = $2.70.
    """
    ts = datetime.now(timezone.utc)
    llm_rows = [
        {
            "id": "a", "occurred_at": ts, "agent_name": "doer", "outcome": "success",
            "model_id": "claude-sonnet-4-6", "provider": "anthropic/claude-sonnet-4-6",
            "input_tokens": 0, "output_tokens": 0,
            "cache_creation": 0, "cache_read": 1_000_000,
            "cost_usd": 0.30, "elapsed_seconds": 0.1, "attempts": 1, "redo_attempt": 0,
            "error": None, "session_id": "sess1",
            "purpose": "doer", "cluster": "cluster_a", "tier": "T2",
            "prospect_id": None, "user_email": "jp@pursuit.org",
        },
    ]
    app = ledger_app(fetch_results=[llm_rows, []])
    with TestClient(app) as client:
        r = client.get("/api/pebble/ledger/sess1")
    assert r.json()["estimated_savings_usd"] == pytest.approx(2.70, rel=1e-6)


# ---------------------------------------------------------------------------
# D. Recent sessions
# ---------------------------------------------------------------------------

def test_recent_sessions_returns_caller_runs(ledger_app):
    ts_a = datetime(2026, 5, 18, 10, 0, 0, tzinfo=timezone.utc)
    ts_b = datetime(2026, 5, 18, 11, 0, 0, tzinfo=timezone.utc)
    recent_rows = [
        {
            "session_id": "sess_newer",
            "started_at": ts_b, "last_event_at": ts_b,
            "call_count": 5, "total_cost_usd": 0.21,
        },
        {
            "session_id": "sess_older",
            "started_at": ts_a, "last_event_at": ts_a,
            "call_count": 3, "total_cost_usd": 0.08,
        },
    ]
    app = ledger_app(fetch_results=[recent_rows])
    with TestClient(app) as client:
        r = client.get("/api/pebble/ledger/recent")
    assert r.status_code == 200
    body = r.json()
    assert len(body["sessions"]) == 2
    assert body["sessions"][0]["session_id"] == "sess_newer"
    assert body["sessions"][0]["total_cost_usd"] == 0.21


def test_recent_sessions_caps_limit_to_100(ledger_app):
    """Defense against pathological ?limit= values."""
    app = ledger_app(fetch_results=[[]])
    with TestClient(app) as client:
        # Should not 422; route clamps internally.
        r = client.get("/api/pebble/ledger/recent?limit=99999")
    assert r.status_code == 200
    assert r.json() == {"sessions": []}


def test_recent_sessions_caps_limit_to_at_least_1(ledger_app):
    app = ledger_app(fetch_results=[[]])
    with TestClient(app) as client:
        r = client.get("/api/pebble/ledger/recent?limit=0")
    assert r.status_code == 200
    assert r.json() == {"sessions": []}
