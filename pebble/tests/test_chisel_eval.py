"""Tests for the chisel eval harness.

Covers Phase B.4 surface:
  * canonical_queries.yaml schema (Pydantic validation)
  * assert_plan: happy + step-count + tool-mismatch + arg-includes/excludes
  * assert_prose: substring includes / excludes
  * loader: discovery across tools + workflows, malformed file errors out
  * run_plan_eval: stub planner happy path, planner-error path, skip path
  * format_results: pass / fail / skip rendering
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from textwrap import dedent
from uuid import uuid4

import pytest
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from pebble.chisel.eval import (
    CanonicalQueriesFile,
    CanonicalQuery,
    EvalResult,
    ExpectedProse,
    ExpectedStep,
    LoadedQuery,
    assert_plan,
    assert_prose,
    format_results,
    load_canonical_queries,
    run_plan_eval,
)
from pebble.orchestrator.planner import Planner, PlannerLLMResponse
from pebble.orchestrator.schemas import Plan, PlanStep
from pebble.orchestrator.tools import (
    ToolContext,
    ToolRegistry,
    ToolSpec,
    make_input_schema,
)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def test_canonical_query_minimal_valid() -> None:
    q = CanonicalQuery(id="smoke_x", user_query="Find Acme")
    assert q.expected_plan == ()
    assert q.expected_prose is None


def test_canonical_query_rejects_bad_id() -> None:
    with pytest.raises(ValidationError):
        CanonicalQuery(id="BadID", user_query="x")
    with pytest.raises(ValidationError):
        CanonicalQuery(id="1bad", user_query="x")


def test_canonical_query_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        CanonicalQuery(id="ok_id", user_query="x", typo=1)


def test_expected_step_rejects_empty_tool() -> None:
    with pytest.raises(ValidationError):
        ExpectedStep(tool="")


# ---------------------------------------------------------------------------
# assert_plan
# ---------------------------------------------------------------------------

def _plan(*steps: PlanStep) -> Plan:
    return Plan(user_query="q", steps=tuple(steps))


def test_assert_plan_empty_expected_always_passes() -> None:
    plan = _plan(PlanStep(tool="search_crm", args={"query": "x"}))
    assert assert_plan(plan, ()) == []


def test_assert_plan_happy_path_with_args_includes() -> None:
    plan = _plan(PlanStep(tool="search_crm", args={"query": "Acme", "limit": 8}))
    expected = (ExpectedStep(tool="search_crm", args_includes={"query": "Acme"}),)
    assert assert_plan(plan, expected) == []


def test_assert_plan_flags_step_count_mismatch() -> None:
    plan = _plan(PlanStep(tool="search_crm", args={"query": "x"}))
    expected = (
        ExpectedStep(tool="search_crm"),
        ExpectedStep(tool="get_record"),
    )
    failures = assert_plan(plan, expected)
    assert any("step_count" in f for f in failures)


def test_assert_plan_flags_wrong_tool() -> None:
    plan = _plan(PlanStep(tool="get_record", args={"entity_id": "x"}))
    expected = (ExpectedStep(tool="search_crm"),)
    failures = assert_plan(plan, expected)
    assert any("step[0].tool" in f for f in failures)


def test_assert_plan_flags_missing_arg() -> None:
    plan = _plan(PlanStep(tool="search_crm", args={"limit": 10}))
    expected = (ExpectedStep(tool="search_crm", args_includes={"query": "Acme"}),)
    failures = assert_plan(plan, expected)
    assert any("missing key 'query'" in f for f in failures)


def test_assert_plan_flags_arg_value_mismatch() -> None:
    plan = _plan(PlanStep(tool="search_crm", args={"query": "Beta"}))
    expected = (ExpectedStep(tool="search_crm", args_includes={"query": "Acme"}),)
    failures = assert_plan(plan, expected)
    assert any("expected 'Acme', got 'Beta'" in f for f in failures)


def test_assert_plan_flags_forbidden_arg() -> None:
    plan = _plan(PlanStep(tool="search_crm", args={"query": "x", "secret": "leak"}))
    expected = (ExpectedStep(tool="search_crm", args_excludes=("secret",)),)
    failures = assert_plan(plan, expected)
    assert any("forbidden key 'secret'" in f for f in failures)


def test_assert_plan_tolerates_extra_steps() -> None:
    plan = _plan(
        PlanStep(tool="search_crm", args={"query": "x"}),
        PlanStep(tool="get_record", args={"entity_type": "sf_account", "entity_id": "1"}),
    )
    expected = (ExpectedStep(tool="search_crm"),)
    assert assert_plan(plan, expected) == []


# ---------------------------------------------------------------------------
# assert_prose
# ---------------------------------------------------------------------------

def test_assert_prose_includes_pass_and_fail() -> None:
    text = "Pipeline coverage: Alice 100, Bob 200."
    assert assert_prose(text, ExpectedProse(includes=("Alice", "Bob"))) == []
    failures = assert_prose(text, ExpectedProse(includes=("Carol",)))
    assert any("missing substring 'Carol'" in f for f in failures)


def test_assert_prose_excludes_pass_and_fail() -> None:
    text = "Pipeline coverage clean."
    assert assert_prose(text, ExpectedProse(excludes=("error",))) == []
    failures = assert_prose("System error encountered.", ExpectedProse(excludes=("error",)))
    assert any("forbidden substring 'error'" in f for f in failures)


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------

def test_load_canonical_queries_real_chisel_root() -> None:
    """Discovery walks pebble/chisel/ — must find the fixtures we
    shipped alongside the migrated tools."""
    loaded = load_canonical_queries()
    units = {lq.unit for lq in loaded}
    assert "search_crm" in units
    assert "aggregate_pipeline_views" in units
    assert "weekly_pipeline_review" in units


def test_load_canonical_queries_rejects_malformed(tmp_path: Path) -> None:
    """Malformed canonical_queries.yaml raises with the file path in
    the error message — easier than chasing nested Pydantic errors."""
    (tmp_path / "tools" / "broken_tool").mkdir(parents=True)
    (tmp_path / "tools" / "broken_tool" / "canonical_queries.yaml").write_text(
        dedent(
            """
            queries:
              - id: BadID
                user_query: x
            """
        ).strip(),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="canonical_queries.yaml"):
        load_canonical_queries(chisel_root=tmp_path)


def test_canonical_queries_file_round_trip() -> None:
    raw = {
        "queries": [
            {
                "id": "smoke_x",
                "user_query": "Find Acme",
                "expected_plan": [
                    {"tool": "search_crm", "args_includes": {"query": "Acme"}},
                ],
                "expected_prose": {"includes": ["Acme"], "excludes": ["error"]},
                "tags": ["smoke"],
            },
        ],
    }
    parsed = CanonicalQueriesFile(**raw)
    assert parsed.queries[0].expected_plan[0].args_includes == {"query": "Acme"}
    assert parsed.queries[0].expected_prose.includes == ("Acme",)


# ---------------------------------------------------------------------------
# run_plan_eval with stub planner
# ---------------------------------------------------------------------------

class _StubLLMClient:
    """Returns a hand-canned plan-JSON string."""
    def __init__(self, plan_json: str):
        self._plan_json = plan_json

    async def emit_plan(self, *, system, user, tools, max_tokens=2048):
        return PlannerLLMResponse(text=self._plan_json)


def _registry_with_search() -> ToolRegistry:
    reg = ToolRegistry()
    async def handler(args, ctx):
        from pebble.orchestrator.schemas import ToolResult
        return ToolResult(step_id=uuid4(), tool="search_crm", ok=True)
    reg.register(
        ToolSpec(
            name="search_crm",
            description="x",
            input_schema=make_input_schema(
                properties={"query": {"type": "string"}},
                required_keys=["query"],
            ),
            handler=handler,
        )
    )
    return reg


def _loaded(query: CanonicalQuery, tmp_path: Path) -> LoadedQuery:
    return LoadedQuery(source=tmp_path / "x.yaml", unit="search_crm", query=query)


@pytest.mark.asyncio
async def test_run_plan_eval_pass(tmp_path: Path) -> None:
    plan_json = (
        '{"rationale":"r","estimated_cost_usd":0,"estimated_tool_calls":1,'
        '"steps":[{"tool":"search_crm","args":{"query":"Acme"},'
        '"expected_shape":"","success_criteria":""}]}'
    )
    reg = _registry_with_search()
    planner = Planner(client=_StubLLMClient(plan_json), registry=reg)
    q = CanonicalQuery(
        id="smoke_x", user_query="Find Acme",
        expected_plan=(ExpectedStep(tool="search_crm", args_includes={"query": "Acme"}),),
    )
    res = await run_plan_eval(
        _loaded(q, tmp_path),
        planner=planner,
        ctx=ToolContext(user_email="t@x", conversation_id="c1"),
    )
    assert res.passed and not res.plan_failures


@pytest.mark.asyncio
async def test_run_plan_eval_planner_error(tmp_path: Path) -> None:
    reg = _registry_with_search()
    planner = Planner(client=_StubLLMClient("not json"), registry=reg)
    q = CanonicalQuery(id="smoke_x", user_query="Find Acme",
                      expected_plan=(ExpectedStep(tool="search_crm"),))
    res = await run_plan_eval(
        _loaded(q, tmp_path),
        planner=planner,
        ctx=ToolContext(user_email="t@x", conversation_id="c1"),
    )
    assert not res.passed
    assert res.planner_error is not None


@pytest.mark.asyncio
async def test_run_plan_eval_skip(tmp_path: Path) -> None:
    reg = _registry_with_search()
    planner = Planner(client=_StubLLMClient(""), registry=reg)
    q = CanonicalQuery(
        id="smoke_x", user_query="Find Acme",
        skip_reason="needs full pipeline",
    )
    res = await run_plan_eval(
        _loaded(q, tmp_path),
        planner=planner,
        ctx=ToolContext(user_email="t@x", conversation_id="c1"),
    )
    assert res.skipped and res.passed
    assert res.skip_reason == "needs full pipeline"


# ---------------------------------------------------------------------------
# format_results
# ---------------------------------------------------------------------------

def test_format_results_summary(tmp_path: Path) -> None:
    results = [
        EvalResult(query_id="a", unit="u", source=tmp_path / "x", passed=True, duration_ms=10),
        EvalResult(
            query_id="b", unit="u", source=tmp_path / "x",
            passed=False, plan_failures=["step[0].tool: expected 'x', got 'y'"],
            duration_ms=12,
        ),
        EvalResult(
            query_id="c", unit="u", source=tmp_path / "x",
            passed=True, skipped=True, skip_reason="deferred",
        ),
    ]
    out = format_results(results)
    assert "1/3 passed" in out
    assert "PASS u/a" in out
    assert "FAIL u/b" in out
    assert "SKIP u/c — deferred" in out
    assert "step[0].tool" in out
