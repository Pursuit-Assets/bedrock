"""Tests for ``pebble.orchestrator.planner`` — LLM-driven Plan
emission with strict JSON-schema validation and bounded retries.

Asserts:
  A. Happy path — well-formed JSON yields a Plan with valid PlanStep DAG.
  B. Empty user_query returns PlannerError.
  C. Empty registry returns PlannerError.
  D. Malformed JSON triggers retry; second-attempt success returns Plan.
  E. Both attempts malformed → PlannerError with last_response_text.
  F. Tool name not in registry → retry with feedback in prompt.
  G. Args fail tool input_schema → retry with feedback in prompt.
  H. Code-fence wrapped JSON (```json...```) parses successfully.
  I. depends_on referencing unknown step → retry with feedback.
  J. depends_on UUIDs resolved correctly across PlanStep objects.
  K. Empty steps list = clean apology Plan, not error.
  L. LLM client exception captured (not raised), retry attempted.
  M. Anthropic tool list passed through unchanged.
  N. Estimated cost / tool_calls round-trip into Plan.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.orchestrator.planner import (
    Planner, PlannerError, PlannerLLMResponse,
    _format_tool_list, _strip_code_fence,
)
from pebble.orchestrator.schemas import Plan, PlanStep
from pebble.orchestrator.tools import (
    ToolContext, ToolRegistry, ToolSpec, make_input_schema,
)


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeLLM:
    """Records prompts, returns canned responses in order. Raises on
    over-call so tests fail loudly when retry count exceeds expected.
    """
    def __init__(self, responses: list[Any]) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    async def emit_plan(self, *, system, user, tools, max_tokens=2048):
        self.calls.append({"system": system, "user": user, "tools": tools})
        if not self.responses:
            raise AssertionError("FakeLLM exhausted — test expected fewer LLM calls")
        head = self.responses.pop(0)
        if isinstance(head, Exception):
            raise head
        if isinstance(head, str):
            return PlannerLLMResponse(text=head)
        return head


async def _ok_handler(args, ctx):
    from pebble.orchestrator.schemas import ToolResult
    return ToolResult(step_id=uuid4(), tool="x", ok=True, data={})


def _make_registry_with(specs: list[ToolSpec]) -> ToolRegistry:
    reg = ToolRegistry()
    for s in specs:
        reg.register(s)
    return reg


def _two_tool_registry() -> ToolRegistry:
    return _make_registry_with([
        ToolSpec(
            name="search_crm",
            description="Search the CRM",
            input_schema=make_input_schema(
                properties={
                    "query": {"type": "string", "minLength": 1},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                },
                required_keys=["query"],
            ),
            handler=_ok_handler,
        ),
        ToolSpec(
            name="get_record",
            description="Fetch a single record",
            input_schema=make_input_schema(
                properties={
                    "entity_type": {"type": "string", "enum": ["sf_account"]},
                    "entity_id": {"type": "string", "minLength": 1},
                },
                required_keys=["entity_type", "entity_id"],
            ),
            handler=_ok_handler,
        ),
    ])


def _ctx() -> ToolContext:
    return ToolContext(user_email="rm@pursuit.org", conversation_id=str(uuid4()))


# ---------------------------------------------------------------------------
# A. Happy path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_planner_happy_path():
    reg = _two_tool_registry()
    canned = '''{
        "rationale": "Search then fetch.",
        "estimated_tool_calls": 2,
        "estimated_cost_usd": 0.001,
        "steps": [
            {"id": "s1", "tool": "search_crm", "args": {"query": "Acme"},
             "expected_shape": "list of hits", "success_criteria": "at least 1 hit",
             "depends_on": []},
            {"id": "s2", "tool": "get_record",
             "args": {"entity_type": "sf_account", "entity_id": "001ABC"},
             "expected_shape": "record dict", "success_criteria": "record returned",
             "depends_on": ["s1"]}
        ]
    }'''
    llm = FakeLLM([canned])
    planner = Planner(client=llm, registry=reg)
    result = await planner.plan(user_query="Find Acme and load the account", ctx=_ctx())
    assert isinstance(result, Plan)
    assert result.user_query == "Find Acme and load the account"
    assert len(result.steps) == 2
    assert result.steps[0].tool == "search_crm"
    assert result.steps[1].tool == "get_record"
    # depends_on resolved to the prior step's actual UUID
    assert result.steps[1].depends_on == (result.steps[0].step_id,)
    assert result.estimated_tool_calls == 2
    assert result.estimated_cost_usd == 0.001
    assert len(llm.calls) == 1   # no retry needed


# ---------------------------------------------------------------------------
# B. Empty user_query
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_empty_user_query_returns_error():
    planner = Planner(client=FakeLLM([]), registry=_two_tool_registry())
    result = await planner.plan(user_query="   ", ctx=_ctx())
    assert isinstance(result, PlannerError)
    assert result.reason == "empty_query"


# ---------------------------------------------------------------------------
# C. Empty registry
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_empty_registry_returns_error():
    planner = Planner(client=FakeLLM([]), registry=ToolRegistry())
    result = await planner.plan(user_query="anything", ctx=_ctx())
    assert isinstance(result, PlannerError)
    assert result.reason == "no_tools_registered"


# ---------------------------------------------------------------------------
# D. Malformed JSON → retry → success
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_malformed_json_triggers_retry_and_succeeds():
    reg = _two_tool_registry()
    bad = "not json at all {[)}"
    good = '''{"rationale":"r","estimated_tool_calls":1,"estimated_cost_usd":0.0,
        "steps":[{"id":"s1","tool":"search_crm","args":{"query":"x"},
        "expected_shape":"","success_criteria":"","depends_on":[]}]}'''
    llm = FakeLLM([bad, good])
    planner = Planner(client=llm, registry=reg)
    result = await planner.plan(user_query="q", ctx=_ctx())
    assert isinstance(result, Plan)
    assert len(llm.calls) == 2
    # Retry prompt mentions the prior error
    assert "REJECTED" in llm.calls[1]["user"]


# ---------------------------------------------------------------------------
# E. All attempts malformed → PlannerError preserves last response
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_all_attempts_malformed_returns_error_with_last_text():
    reg = _two_tool_registry()
    llm = FakeLLM(["junk one", "junk two"])
    planner = Planner(client=llm, registry=reg, max_retries=1)
    result = await planner.plan(user_query="q", ctx=_ctx())
    assert isinstance(result, PlannerError)
    assert result.reason == "planner_max_retries_exceeded"
    assert "junk two" in result.last_response_text


# ---------------------------------------------------------------------------
# F. Unknown tool → retry feedback
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_unknown_tool_triggers_retry():
    reg = _two_tool_registry()
    bad = '''{"rationale":"r","estimated_tool_calls":1,"estimated_cost_usd":0.0,
        "steps":[{"id":"s1","tool":"summon_demon","args":{},
        "expected_shape":"","success_criteria":"","depends_on":[]}]}'''
    good = '''{"rationale":"r","estimated_tool_calls":1,"estimated_cost_usd":0.0,
        "steps":[{"id":"s1","tool":"search_crm","args":{"query":"x"},
        "expected_shape":"","success_criteria":"","depends_on":[]}]}'''
    llm = FakeLLM([bad, good])
    planner = Planner(client=llm, registry=reg)
    result = await planner.plan(user_query="q", ctx=_ctx())
    assert isinstance(result, Plan)
    assert "summon_demon" in llm.calls[1]["user"]   # retry prompt cites the bad tool


# ---------------------------------------------------------------------------
# G. Args schema violation → retry
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_args_schema_violation_triggers_retry():
    reg = _two_tool_registry()
    # missing required "query"
    bad = '''{"rationale":"r","estimated_tool_calls":1,"estimated_cost_usd":0.0,
        "steps":[{"id":"s1","tool":"search_crm","args":{"limit":5},
        "expected_shape":"","success_criteria":"","depends_on":[]}]}'''
    good = '''{"rationale":"r","estimated_tool_calls":1,"estimated_cost_usd":0.0,
        "steps":[{"id":"s1","tool":"search_crm","args":{"query":"x","limit":5},
        "expected_shape":"","success_criteria":"","depends_on":[]}]}'''
    llm = FakeLLM([bad, good])
    planner = Planner(client=llm, registry=reg)
    result = await planner.plan(user_query="q", ctx=_ctx())
    assert isinstance(result, Plan)
    assert "schema" in llm.calls[1]["user"].lower()


@pytest.mark.asyncio
async def test_args_wrong_type_rejected():
    """limit must be int; planner sends string → schema fails."""
    reg = _two_tool_registry()
    bad = '''{"rationale":"r","estimated_tool_calls":1,"estimated_cost_usd":0.0,
        "steps":[{"id":"s1","tool":"search_crm","args":{"query":"x","limit":"five"},
        "expected_shape":"","success_criteria":"","depends_on":[]}]}'''
    llm = FakeLLM([bad, bad])   # both attempts wrong → planner gives up
    planner = Planner(client=llm, registry=reg, max_retries=1)
    result = await planner.plan(user_query="q", ctx=_ctx())
    assert isinstance(result, PlannerError)


# ---------------------------------------------------------------------------
# H. Code-fence handling
# ---------------------------------------------------------------------------

def test_strip_code_fence_handles_json_label():
    s = "```json\n{\"a\":1}\n```"
    assert _strip_code_fence(s) == '{"a":1}'


def test_strip_code_fence_handles_bare_fence():
    s = "```\n{\"a\":1}\n```"
    assert _strip_code_fence(s) == '{"a":1}'


def test_strip_code_fence_no_fence_passthrough():
    assert _strip_code_fence('  {"a":1}  ') == '{"a":1}'


@pytest.mark.asyncio
async def test_planner_accepts_code_fence_wrapped_json():
    reg = _two_tool_registry()
    canned = '```json\n' + (
        '{"rationale":"r","estimated_tool_calls":1,"estimated_cost_usd":0.0,'
        '"steps":[{"id":"s1","tool":"search_crm","args":{"query":"x"},'
        '"expected_shape":"","success_criteria":"","depends_on":[]}]}'
    ) + '\n```'
    llm = FakeLLM([canned])
    planner = Planner(client=llm, registry=reg)
    result = await planner.plan(user_query="q", ctx=_ctx())
    assert isinstance(result, Plan)


# ---------------------------------------------------------------------------
# I. Forward-reference depends_on rejected
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_forward_dependency_rejected():
    reg = _two_tool_registry()
    # s1 depends on s2 (a later step) — not a prior step
    bad = '''{"rationale":"r","estimated_tool_calls":2,"estimated_cost_usd":0.0,
        "steps":[
            {"id":"s1","tool":"search_crm","args":{"query":"x"},
             "expected_shape":"","success_criteria":"","depends_on":["s2"]},
            {"id":"s2","tool":"search_crm","args":{"query":"y"},
             "expected_shape":"","success_criteria":"","depends_on":[]}
        ]}'''
    good = '''{"rationale":"r","estimated_tool_calls":1,"estimated_cost_usd":0.0,
        "steps":[{"id":"s1","tool":"search_crm","args":{"query":"x"},
        "expected_shape":"","success_criteria":"","depends_on":[]}]}'''
    llm = FakeLLM([bad, good])
    planner = Planner(client=llm, registry=reg)
    result = await planner.plan(user_query="q", ctx=_ctx())
    assert isinstance(result, Plan)
    assert "s2" in llm.calls[1]["user"]   # retry prompt cites the bad dep


# ---------------------------------------------------------------------------
# J. Empty plan = apology, not error
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_empty_steps_list_is_clean_apology():
    reg = _two_tool_registry()
    canned = '''{"rationale":"User asked something I can't help with.",
        "estimated_tool_calls":0,"estimated_cost_usd":0.0,"steps":[]}'''
    llm = FakeLLM([canned])
    planner = Planner(client=llm, registry=reg)
    result = await planner.plan(user_query="q", ctx=_ctx())
    assert isinstance(result, Plan)
    assert len(result.steps) == 0
    assert "can't help" in result.rationale


# ---------------------------------------------------------------------------
# K. LLM exception surfaces as PlannerError, not raise
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_llm_exception_is_caught_and_retried():
    reg = _two_tool_registry()
    good = '''{"rationale":"r","estimated_tool_calls":1,"estimated_cost_usd":0.0,
        "steps":[{"id":"s1","tool":"search_crm","args":{"query":"x"},
        "expected_shape":"","success_criteria":"","depends_on":[]}]}'''
    llm = FakeLLM([RuntimeError("anthropic 500"), good])
    planner = Planner(client=llm, registry=reg)
    result = await planner.plan(user_query="q", ctx=_ctx())
    assert isinstance(result, Plan)


@pytest.mark.asyncio
async def test_repeated_llm_exception_returns_error():
    reg = _two_tool_registry()
    llm = FakeLLM([RuntimeError("a"), RuntimeError("b")])
    planner = Planner(client=llm, registry=reg, max_retries=1)
    result = await planner.plan(user_query="q", ctx=_ctx())
    assert isinstance(result, PlannerError)
    assert "RuntimeError" in result.detail


# ---------------------------------------------------------------------------
# L. Tool list passed to LLM is the registry's anthropic shape
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_tool_list_passed_to_llm():
    reg = _two_tool_registry()
    canned = '''{"rationale":"r","estimated_tool_calls":0,"estimated_cost_usd":0.0,"steps":[]}'''
    llm = FakeLLM([canned])
    planner = Planner(client=llm, registry=reg)
    await planner.plan(user_query="q", ctx=_ctx())
    tools = llm.calls[0]["tools"]
    names = [t["name"] for t in tools]
    assert names == ["search_crm", "get_record"]
    # Each tool def has the strict schema
    for t in tools:
        assert t["input_schema"]["additionalProperties"] is False


# ---------------------------------------------------------------------------
# M. Numeric estimate fields round-trip
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_estimate_fields_round_trip():
    reg = _two_tool_registry()
    canned = '''{"rationale":"r","estimated_tool_calls":7,"estimated_cost_usd":0.123,
        "steps":[{"id":"s1","tool":"search_crm","args":{"query":"x"},
        "expected_shape":"","success_criteria":"","depends_on":[]}]}'''
    llm = FakeLLM([canned])
    planner = Planner(client=llm, registry=reg)
    result = await planner.plan(user_query="q", ctx=_ctx())
    assert result.estimated_tool_calls == 7
    assert result.estimated_cost_usd == 0.123


# ---------------------------------------------------------------------------
# N. _format_tool_list — ergonomic prompt block
# ---------------------------------------------------------------------------

def test_format_tool_list_marks_required_keys():
    reg = _two_tool_registry()
    block = _format_tool_list(reg.iter_specs())
    # required keys get a star; optional keys don't.
    assert "query*" in block
    assert "limit," in block or "limit\n" in block or "limit " in block
    # Each tool gets one bullet
    assert block.count("- **") == 2


# ---------------------------------------------------------------------------
# O. Plan with > max_steps rejected
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_max_steps_enforced():
    reg = _two_tool_registry()
    steps_json = ",".join(
        f'{{"id":"s{i}","tool":"search_crm","args":{{"query":"x{i}"}},'
        f'"expected_shape":"","success_criteria":"","depends_on":[]}}'
        for i in range(15)
    )
    bad = (
        '{"rationale":"r","estimated_tool_calls":15,"estimated_cost_usd":0.0,'
        f'"steps":[{steps_json}]}}'
    )
    llm = FakeLLM([bad, bad])
    planner = Planner(client=llm, registry=reg, max_steps=5, max_retries=1)
    result = await planner.plan(user_query="q", ctx=_ctx())
    assert isinstance(result, PlannerError)
    assert "max" in result.detail.lower() or "15" in result.detail
