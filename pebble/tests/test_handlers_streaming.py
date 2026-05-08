"""Tests for ``pebble.handlers.streaming`` — predicates and the
streaming entry that builds ChatOrchestrator + dispatches to the
right path.

Asserts:
  A. orchestrator_enabled requires level=1 + flag truthy + ANTHROPIC_API_KEY.
  B. is_workflow_route true only for level=2.
  C. Workflow route streams events from a pre-baked plan, no planner LLM.
  D. L1 route streams events from run_stream (planner-driven).
  E. Anthropic client construction failure → graceful error stream.
  F. Unknown workflow intent → graceful error stream.
  G. Invalid conversation_id → mints fresh UUID, doesn't crash.
  H. _flag_truthy: true/1/yes/on (case-insensitive); false/0/no/off/missing.
"""

from __future__ import annotations

import os
import sys
from typing import Any
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.handlers.streaming import (
    _flag_truthy,
    is_workflow_route,
    orchestrator_enabled,
    stream_orchestrator_events,
)
from pebble.router import RouteResult


def _route(level: int, intent: str = "test") -> RouteResult:
    return RouteResult(level=level, intent=intent)


# ---------------------------------------------------------------------------
# A. orchestrator_enabled predicate
# ---------------------------------------------------------------------------

def test_orchestrator_enabled_requires_level_1(monkeypatch):
    monkeypatch.setenv("PEBBLE_USE_ORCHESTRATOR", "true")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    assert orchestrator_enabled(_route(1)) is True
    assert orchestrator_enabled(_route(0)) is False
    assert orchestrator_enabled(_route(2)) is False
    assert orchestrator_enabled(_route(10)) is False
    assert orchestrator_enabled(_route(-1)) is False


def test_orchestrator_disabled_when_flag_off(monkeypatch):
    monkeypatch.setenv("PEBBLE_USE_ORCHESTRATOR", "false")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    assert orchestrator_enabled(_route(1)) is False


def test_orchestrator_disabled_when_flag_missing(monkeypatch):
    monkeypatch.delenv("PEBBLE_USE_ORCHESTRATOR", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    assert orchestrator_enabled(_route(1)) is False


def test_orchestrator_disabled_when_no_api_key(monkeypatch):
    monkeypatch.setenv("PEBBLE_USE_ORCHESTRATOR", "true")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert orchestrator_enabled(_route(1)) is False


# ---------------------------------------------------------------------------
# B. is_workflow_route
# ---------------------------------------------------------------------------

def test_is_workflow_route_only_level_2():
    assert is_workflow_route(_route(2)) is True
    assert is_workflow_route(_route(1)) is False
    assert is_workflow_route(_route(0)) is False
    assert is_workflow_route(_route(10)) is False
    assert is_workflow_route(_route(-1)) is False


def test_workflow_route_independent_of_env_flag(monkeypatch):
    """Workflows are deterministic — no flag gating."""
    monkeypatch.delenv("PEBBLE_USE_ORCHESTRATOR", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert is_workflow_route(_route(2)) is True


# ---------------------------------------------------------------------------
# H. _flag_truthy values
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("value,expected", [
    ("true", True),
    ("True", True),
    ("TRUE", True),
    ("1", True),
    ("yes", True),
    ("YES", True),
    ("on", True),
    ("ON", True),
    ("false", False),
    ("0", False),
    ("no", False),
    ("off", False),
    ("", False),
    ("anything-else", False),
])
def test_flag_truthy_values(monkeypatch, value, expected):
    monkeypatch.setenv("MY_FLAG", value)
    assert _flag_truthy("MY_FLAG") is expected


def test_flag_truthy_unset_returns_false(monkeypatch):
    monkeypatch.delenv("MY_FLAG", raising=False)
    assert _flag_truthy("MY_FLAG") is False


def test_flag_truthy_default_can_override_unset(monkeypatch):
    monkeypatch.delenv("MY_FLAG", raising=False)
    assert _flag_truthy("MY_FLAG", default="true") is True


# ---------------------------------------------------------------------------
# C, D, E, F, G — stream_orchestrator_events behavior
# ---------------------------------------------------------------------------

class _MockAnthropicClient:
    """Mock that satisfies the AnthropicLLMClient surface used by Planner / Evaluator."""

    def __init__(self, planner_responses: list[str], judge_responses: list[str]) -> None:
        self._planner = list(planner_responses)
        self._judge = list(judge_responses)
        self.planner_calls: list[Any] = []
        self.judge_calls: list[Any] = []

    async def emit_plan(self, *, system, user, tools, max_tokens=2048):
        from pebble.orchestrator.planner import PlannerLLMResponse
        self.planner_calls.append({"system": system, "user": user})
        if not self._planner:
            raise AssertionError("planner stub exhausted")
        return PlannerLLMResponse(text=self._planner.pop(0))

    async def emit_evaluation(self, *, system, user, max_tokens=1024):
        from pebble.orchestrator.evaluator import EvaluatorLLMResponse
        self.judge_calls.append({"system": system, "user": user})
        if not self._judge:
            raise AssertionError("judge stub exhausted")
        return EvaluatorLLMResponse(text=self._judge.pop(0))


@pytest.mark.asyncio
async def test_workflow_route_yields_events_no_planner_call(monkeypatch):
    """Workflow path: no planner LLM, deterministic events."""
    # Mock crm_bridge.get_opportunities so the workflow tool can run
    async def fake_get_opportunities(limit=500):
        return []
    from pebble import crm_bridge as _crm
    monkeypatch.setattr(_crm, "get_opportunities", fake_get_opportunities)

    judge_responses = [
        '{"factuality":0.95,"completeness":0.9,"harm":"none","verdict":"pass","rationale":"ok"}',
    ]
    mock_client = _MockAnthropicClient(planner_responses=[], judge_responses=judge_responses)

    route = RouteResult(
        level=2, intent="workflow_weekly_pipeline_review",
        entities={"slash_command": "/pipeline", "args": ""},
    )
    events = []
    async for ev in stream_orchestrator_events(
        route=route,
        user_query="weekly pipeline review",
        conversation_id=str(uuid4()),
        user_email="rm@pursuit.org",
        anthropic_client=mock_client,
    ):
        events.append(ev)

    kinds = [e.kind for e in events]
    assert kinds[0] == "plan_emitted"
    assert kinds[-1] == "response_final"
    # Planner LLM was NOT called (workflow path skips it)
    assert mock_client.planner_calls == []


@pytest.mark.asyncio
async def test_l1_route_calls_planner(monkeypatch):
    """L1 route: planner LLM IS called."""
    # Patch crm_bridge._get_client to return a mock httpx client whose
    # GET /api/search returns an empty hit list — bypasses any real
    # Bedrock dependency. The real search_crm handler is unchanged.
    from pebble import crm_bridge as _crm

    class _FakeResp:
        def __init__(self, status, body):
            self.status_code = status
            self._body = body
        def json(self):
            return self._body

    class _FakeClient:
        async def get(self, path, params=None, headers=None):
            return _FakeResp(200, {"items": [], "total_count": 0, "grouped": {}})
        async def post(self, *args, **kwargs):
            return _FakeResp(200, {})
        async def put(self, *args, **kwargs):
            return _FakeResp(200, {})
        async def aclose(self):
            pass

    monkeypatch.setattr(_crm, "_get_client", lambda: _FakeClient())

    plan_text = (
        '{"rationale":"search","estimated_tool_calls":1,"estimated_cost_usd":0.0,'
        '"steps":[{"id":"s1","tool":"search_crm","args":{"query":"Acme"},'
        '"expected_shape":"hits","success_criteria":"any","depends_on":[]}]}'
    )
    judge_text = (
        '{"factuality":0.95,"completeness":0.9,"harm":"none","verdict":"pass","rationale":"ok"}'
    )
    mock_client = _MockAnthropicClient(planner_responses=[plan_text], judge_responses=[judge_text])

    route = RouteResult(level=1, intent="crm_lookup")
    events = []
    async for ev in stream_orchestrator_events(
        route=route,
        user_query="find Acme",
        conversation_id=str(uuid4()),
        user_email="rm@pursuit.org",
        anthropic_client=mock_client,
    ):
        events.append(ev)

    kinds = [e.kind for e in events]
    assert "plan_emitted" in kinds
    assert kinds[-1] == "response_final"
    # Planner WAS called once
    assert len(mock_client.planner_calls) == 1


@pytest.mark.asyncio
async def test_anthropic_client_construction_failure_yields_error(monkeypatch):
    """When constructing the LLM client raises, we surface an error
    + degraded final, never crash."""
    from pebble.llm import anthropic_client as ac_mod
    monkeypatch.setattr(ac_mod, "_SDK_AVAILABLE", False)
    # Don't pass anthropic_client; let stream_orchestrator_events
    # try to construct one and fail.
    route = RouteResult(level=1, intent="x")
    events = []
    async for ev in stream_orchestrator_events(
        route=route,
        user_query="anything",
        conversation_id=str(uuid4()),
        user_email="x",
        anthropic_client=None,
    ):
        events.append(ev)

    kinds = [e.kind for e in events]
    assert kinds == ["error", "response_final"]
    assert events[0].payload["phase"] == "construction"
    assert events[1].payload["final"]["degraded"] is True


@pytest.mark.asyncio
async def test_unknown_workflow_intent_yields_error():
    """Workflow route with unknown intent → clean error, no crash."""
    mock_client = _MockAnthropicClient(planner_responses=[], judge_responses=[])
    route = RouteResult(level=2, intent="workflow_bogus")
    events = []
    async for ev in stream_orchestrator_events(
        route=route,
        user_query="something",
        conversation_id=str(uuid4()),
        user_email="x",
        anthropic_client=mock_client,
    ):
        events.append(ev)

    kinds = [e.kind for e in events]
    assert kinds == ["error", "response_final"]
    assert "unknown_workflow_intent" in events[0].payload["reason"]


@pytest.mark.asyncio
async def test_invalid_conversation_id_mints_fresh(monkeypatch):
    """Garbage conversation_id → mint fresh UUID, log warning, continue."""
    async def fake_get_opportunities(limit=500):
        return []
    from pebble import crm_bridge as _crm
    monkeypatch.setattr(_crm, "get_opportunities", fake_get_opportunities)

    judge_responses = [
        '{"factuality":0.95,"completeness":0.9,"harm":"none","verdict":"pass","rationale":"ok"}',
    ]
    mock_client = _MockAnthropicClient(planner_responses=[], judge_responses=judge_responses)

    route = RouteResult(level=2, intent="workflow_weekly_pipeline_review")
    events = []
    async for ev in stream_orchestrator_events(
        route=route,
        user_query="x",
        conversation_id="not-a-uuid",
        user_email="x",
        anthropic_client=mock_client,
    ):
        events.append(ev)

    # Stream completes successfully despite bad conv_id
    kinds = [e.kind for e in events]
    assert kinds[-1] == "response_final"
