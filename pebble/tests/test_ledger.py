"""Tests for pebble.orchestrator.ledger — real-time token + cost ledger.

Pinned behaviors:
  A. TokenEvent + ToolCallEvent + RunLedger Pydantic models accept the
     four-field token shape from the cache-aware capture.
  B. CacheHitMetrics.cache_hit_ratio = cache_read / (cache_read + input).
  C. compute_run_rollup aggregates correctly:
       * total cost = sum of cost_usd over LLM + tool rows
       * cache metrics reflect cache_create + cache_read totals
       * by_cluster slices on the cluster column
       * by_purpose slices on the purpose column
       * error_count counts both LLM errors and tool failures
  D. harness_result_to_event_kwargs unpacks four-field tokens_used
     dict into record_token_event kwargs correctly.
  E. Empty session (no rows) returns a zeroed RunLedger.
  F. record_token_event + record_tool_call best-effort — DB exception
     does not raise (logged + swallowed).
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from pebble.orchestrator.ledger import (
    CacheHitMetrics,
    ClusterRollup,
    PurposeRollup,
    RunLedger,
    RunTotal,
    TokenEvent,
    ToolCallEvent,
    compute_run_rollup,
    harness_result_to_event_kwargs,
    observe_tool_call,
    record_token_event,
    record_tool_call,
)


# ---------------------------------------------------------------------------
# A. Pydantic shapes
# ---------------------------------------------------------------------------

def test_token_event_accepts_four_field_shape():
    ev = TokenEvent(
        id="abc",
        occurred_at=datetime.now(timezone.utc),
        agent_name="claim_verifier_singleclaim_haiku",
        outcome="success",
        input_tokens=1000,
        output_tokens=300,
        cache_creation_input_tokens=500,
        cache_read_input_tokens=2000,
        cost_usd=0.0042,
    )
    assert ev.has_cache_data is True
    assert ev.cache_hit_input_tokens == 2000


def test_token_event_defaults_to_zero_when_legacy_row():
    ev = TokenEvent(
        id="abc",
        occurred_at=datetime.now(timezone.utc),
        agent_name="legacy_agent",
        outcome="success",
        input_tokens=100,
        output_tokens=50,
    )
    assert ev.cache_creation_input_tokens == 0
    assert ev.cache_read_input_tokens == 0
    assert ev.has_cache_data is False


def test_tool_call_event_shape():
    ev = ToolCallEvent(
        id=1,
        occurred_at=datetime.now(timezone.utc),
        session_id="sess1",
        tool="fec.search_contributions",
        cluster="cluster_a_financial",
        success=True,
        elapsed_ms=420,
        cache_hit=False,
        originating_user_email="jp@pursuit.org",
    )
    assert ev.cost_usd == 0.0   # default
    assert ev.cache_hit is False


# ---------------------------------------------------------------------------
# B. CacheHitMetrics math
# ---------------------------------------------------------------------------

def test_cache_hit_ratio_empty():
    assert CacheHitMetrics().cache_hit_ratio == 0.0


def test_cache_hit_ratio_pure_cache():
    m = CacheHitMetrics(total_input_tokens=0, cache_read_tokens=1000)
    assert m.cache_hit_ratio == 1.0


def test_cache_hit_ratio_pure_fresh():
    m = CacheHitMetrics(total_input_tokens=1000, cache_read_tokens=0)
    assert m.cache_hit_ratio == 0.0


def test_cache_hit_ratio_mixed():
    # 4000 input + 6000 cache_read → 6000 / 10000 = 60%
    m = CacheHitMetrics(total_input_tokens=4000, cache_read_tokens=6000)
    assert m.cache_hit_ratio == pytest.approx(0.6, rel=1e-6)


def test_estimated_savings_proportional_to_cache_read():
    m = CacheHitMetrics(cache_read_tokens=1_000_000)
    # 1Mtok × $3/Mtok × 0.90 = $2.70 savings
    assert m.estimated_savings_usd == pytest.approx(2.70, rel=1e-6)


# ---------------------------------------------------------------------------
# C. compute_run_rollup aggregations
# ---------------------------------------------------------------------------

def _fake_pool(llm_rows, tool_rows):
    """Build an asyncpg-style pool mock that returns prepared row lists."""
    conn = AsyncMock()
    conn.fetch.side_effect = [llm_rows, tool_rows]

    acm = AsyncMock()
    acm.__aenter__ = AsyncMock(return_value=conn)
    acm.__aexit__ = AsyncMock(return_value=False)

    pool = MagicMock()
    pool.acquire.return_value = acm
    return pool


@pytest.mark.asyncio
async def test_compute_run_rollup_empty_session():
    pool = _fake_pool([], [])
    ledger = await compute_run_rollup(pool, "sess_empty")
    assert ledger.run_total.llm_call_count == 0
    assert ledger.run_total.tool_call_count == 0
    assert ledger.run_total.total_cost_usd == 0.0
    assert ledger.by_cluster == {}
    assert ledger.by_purpose == {}


@pytest.mark.asyncio
async def test_compute_run_rollup_sums_costs_across_llm_and_tools():
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
    pool = _fake_pool(llm_rows, tool_rows)
    ledger = await compute_run_rollup(pool, "sess1")

    assert ledger.run_total.llm_call_count == 2
    assert ledger.run_total.tool_call_count == 1
    assert ledger.run_total.total_cost_usd == pytest.approx(0.0432, rel=1e-6)
    assert ledger.run_total.cache.cache_create_tokens == 500
    assert ledger.run_total.cache.cache_read_tokens == 2000
    # Cache hit ratio = 2000 / (2000 + 4000_input) = 1/3
    assert ledger.run_total.cache.cache_hit_ratio == pytest.approx(1 / 3, rel=1e-6)

    assert "cluster_a_financial" in ledger.by_cluster
    cr = ledger.by_cluster["cluster_a_financial"]
    assert cr.call_count == 2
    assert cr.tool_call_count == 1
    assert cr.cost_usd == pytest.approx(0.0432, rel=1e-6)

    assert "doer" in ledger.by_purpose
    assert "verifier" in ledger.by_purpose
    assert ledger.by_purpose["doer"].call_count == 1
    assert ledger.by_purpose["verifier"].call_count == 1


@pytest.mark.asyncio
async def test_compute_run_rollup_counts_errors_from_both_tables():
    ts = datetime.now(timezone.utc)
    llm_rows = [
        {
            "id": "a", "occurred_at": ts, "agent_name": "doer", "outcome": "killed_schema_fail",
            "model_id": "", "provider": "",
            "input_tokens": 0, "output_tokens": 0,
            "cache_creation": 0, "cache_read": 0,
            "cost_usd": 0.0, "elapsed_seconds": 0.0, "attempts": 3, "redo_attempt": 0,
            "error": "JSON parse failed", "session_id": "sess1",
            "purpose": "doer", "cluster": "cluster_a", "tier": "T2",
            "prospect_id": None, "user_email": "jp@pursuit.org",
        },
    ]
    tool_rows = [
        {
            "id": 1, "occurred_at": ts, "session_id": "sess1",
            "tool": "propublica.download_990_xml", "cluster": "cluster_d",
            "agent_name": None, "cost_usd": 0.0, "success": False,
            "elapsed_ms": 5000, "bytes_returned": None, "cache_hit": False,
            "rate_limit_remaining": 0, "rate_limit_reset_at": None,
            "error_class": "RateLimitError", "originating_user_email": "jp@pursuit.org",
        },
    ]
    pool = _fake_pool(llm_rows, tool_rows)
    ledger = await compute_run_rollup(pool, "sess1")
    # Both errors counted in the run total
    assert ledger.run_total.error_count == 2
    # Cluster rollup error_count is LLM-side only
    assert ledger.by_cluster["cluster_a"].error_count == 1


# ---------------------------------------------------------------------------
# D. harness_result_to_event_kwargs adapter
# ---------------------------------------------------------------------------

def test_harness_result_to_event_kwargs_four_field():
    result = SimpleNamespace(
        outcome=SimpleNamespace(value="success"),
        cost_usd=0.039,
        tokens_used={"input": 3000, "output": 2000, "cache_create": 500, "cache_read": 1000},
        attempts=1,
        elapsed_seconds=1.2,
        error=None,
    )
    kwargs = harness_result_to_event_kwargs(
        result,
        agent_name="philanthropy_agent",
        session_id="sess1",
        purpose="doer",
        cluster="cluster_a_financial",
        tier="T3",
        provider="anthropic/claude-sonnet-4-6",
        model_id="claude-sonnet-4-6",
    )
    assert kwargs["tokens_input"] == 3000
    assert kwargs["tokens_output"] == 2000
    assert kwargs["cache_creation_input_tokens"] == 500
    assert kwargs["cache_read_input_tokens"] == 1000
    assert kwargs["cost_usd"] == 0.039
    assert kwargs["session_id"] == "sess1"
    assert kwargs["cluster"] == "cluster_a_financial"
    assert kwargs["outcome"] == "success"


def test_harness_result_to_event_kwargs_legacy_two_field():
    result = SimpleNamespace(
        outcome=SimpleNamespace(value="success"),
        cost_usd=0.01,
        tokens_used={"input": 1000, "output": 500},
        attempts=1,
        elapsed_seconds=0.5,
        error=None,
    )
    kwargs = harness_result_to_event_kwargs(result, agent_name="legacy")
    assert kwargs["cache_creation_input_tokens"] == 0
    assert kwargs["cache_read_input_tokens"] == 0
    assert kwargs["tokens_input"] == 1000


# ---------------------------------------------------------------------------
# F. Best-effort writes — don't raise on DB exception
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_record_token_event_swallows_db_errors():
    pool = MagicMock()
    pool.acquire.side_effect = RuntimeError("DB down")
    # Must not raise — the swarm step should continue even if ledger
    # write fails.
    await record_token_event(
        pool,
        agent_name="doer",
        outcome="success",
        cost_usd=0.01,
        tokens_input=100, tokens_output=50,
    )


@pytest.mark.asyncio
async def test_record_tool_call_swallows_db_errors():
    pool = MagicMock()
    pool.acquire.side_effect = RuntimeError("DB down")
    await record_tool_call(
        pool,
        session_id="sess1",
        tool="fec.search_contributions",
        success=True,
        elapsed_ms=420,
        originating_user_email="jp@pursuit.org",
    )


# ---------------------------------------------------------------------------
# G. observe_tool_call context manager
# ---------------------------------------------------------------------------

def _capture_pool():
    """Pool whose execute() captures the arguments."""
    captured: dict = {"calls": []}
    conn = AsyncMock()

    async def fake_execute(*args, **kwargs):
        captured["calls"].append({"args": args, "kwargs": kwargs})

    conn.execute.side_effect = fake_execute

    acm = AsyncMock()
    acm.__aenter__ = AsyncMock(return_value=conn)
    acm.__aexit__ = AsyncMock(return_value=False)

    pool = MagicMock()
    pool.acquire.return_value = acm
    return pool, captured


@pytest.mark.asyncio
async def test_observe_tool_call_records_success():
    pool, captured = _capture_pool()
    async with observe_tool_call(
        pool,
        session_id="sess1",
        tool="fec.search_contributions",
        cluster="cluster_a_financial",
        originating_user_email="jp@pursuit.org",
    ) as obs:
        obs["bytes_returned"] = 4096
        obs["rate_limit_remaining"] = 998
        obs["cost_usd"] = 0.0

    # One INSERT recorded
    assert len(captured["calls"]) == 1
    args = captured["calls"][0]["args"]
    # args[0] is the SQL, then positional: session_id, tool, cluster, agent_name,
    # cost_usd, success, elapsed_ms, bytes_returned, cache_hit, ...
    assert args[1] == "sess1"
    assert args[2] == "fec.search_contributions"
    assert args[3] == "cluster_a_financial"
    assert args[6] is True       # success
    assert args[8] == 4096        # bytes_returned
    assert args[10] == 998        # rate_limit_remaining


@pytest.mark.asyncio
async def test_observe_tool_call_records_failure_and_reraises():
    pool, captured = _capture_pool()

    class FakeRateLimitError(Exception):
        pass

    with pytest.raises(FakeRateLimitError):
        async with observe_tool_call(
            pool,
            session_id="sess1",
            tool="propublica.download_990_xml",
            cluster="cluster_d_network",
            originating_user_email="jp@pursuit.org",
        ) as obs:
            obs["rate_limit_remaining"] = 0
            raise FakeRateLimitError("retry-after 60")

    # Event still recorded — success=False, error_class set
    assert len(captured["calls"]) == 1
    args = captured["calls"][0]["args"]
    assert args[6] is False               # success
    assert args[12] == "FakeRateLimitError"  # error_class


@pytest.mark.asyncio
async def test_observe_tool_call_default_cost_zero():
    pool, captured = _capture_pool()
    async with observe_tool_call(
        pool,
        session_id="sess1",
        tool="wikipedia.fetch_full_profile",
        originating_user_email="jp@pursuit.org",
    ) as obs:
        pass

    args = captured["calls"][0]["args"]
    assert args[5] == 0.0   # cost_usd default
    assert args[9] is False  # cache_hit default


@pytest.mark.asyncio
async def test_observe_tool_call_cache_hit_marker():
    pool, captured = _capture_pool()
    async with observe_tool_call(
        pool,
        session_id="sess1",
        tool="propublica.download_990_xml",
        originating_user_email="jp@pursuit.org",
    ) as obs:
        obs["cache_hit"] = True   # bedrock.pebble_api_cache hit

    args = captured["calls"][0]["args"]
    assert args[9] is True  # cache_hit recorded
