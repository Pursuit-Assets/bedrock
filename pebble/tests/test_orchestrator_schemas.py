"""Pydantic-shape tests for ``pebble.orchestrator.schemas``.

The schemas are durable contracts (persisted, FE-shared, planner-shared)
so the constraints they encode must be enforced.
"""

import os
import sys
from uuid import uuid4

import pytest
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.orchestrator.schemas import (
    Citation, ChartSpec, EvalVerdict, Evaluation, FinalResponse,
    Plan, PlanStep, StepType, SuggestedAction, ToolCall, ToolResult,
)


# ---------------------------------------------------------------------------
# PlanStep
# ---------------------------------------------------------------------------

def test_plan_step_minimal_valid():
    step = PlanStep(tool="search_crm")
    assert step.tool == "search_crm"
    assert step.args == {}
    assert step.depends_on == ()
    assert step.step_id  # uuid auto-generated


def test_plan_step_strips_tool_whitespace():
    step = PlanStep(tool="  search_crm  ")
    assert step.tool == "search_crm"


def test_plan_step_rejects_empty_tool():
    with pytest.raises(ValidationError, match=r"non-empty"):
        PlanStep(tool="")


def test_plan_step_rejects_whitespace_only_tool():
    with pytest.raises(ValidationError, match=r"non-empty"):
        PlanStep(tool="   ")


def test_plan_step_frozen():
    """Frozen=True so steps can't be mutated after planning."""
    step = PlanStep(tool="search_crm")
    with pytest.raises(ValidationError):
        step.tool = "different"


# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------

def test_plan_minimal_valid():
    plan = Plan(
        user_query="show open deals",
        steps=(PlanStep(tool="search_crm"),),
    )
    assert plan.user_query == "show open deals"
    assert len(plan.steps) == 1


def test_plan_strips_query_whitespace():
    plan = Plan(user_query="  show open deals  ", steps=())
    assert plan.user_query == "show open deals"


def test_plan_rejects_empty_query():
    with pytest.raises(ValidationError, match=r"non-empty"):
        Plan(user_query="", steps=())


def test_plan_rejects_forward_reference_in_depends_on():
    """depends_on can only reference earlier steps. Forward refs are
    a bug — the planner must emit topologically ordered steps."""
    later_id = uuid4()
    earlier = PlanStep(tool="search_crm")
    later = PlanStep(tool="get_record", depends_on=(later_id,))
    with pytest.raises(ValidationError, match=r"depends_on"):
        Plan(user_query="x", steps=(earlier, later))


def test_plan_accepts_valid_dependency_chain():
    a = PlanStep(tool="search_crm")
    b = PlanStep(tool="get_record", depends_on=(a.step_id,))
    c = PlanStep(tool="generate_chart", depends_on=(a.step_id, b.step_id))
    plan = Plan(user_query="x", steps=(a, b, c))
    assert plan.steps[2].depends_on == (a.step_id, b.step_id)


def test_plan_frozen():
    plan = Plan(user_query="x", steps=(PlanStep(tool="search_crm"),))
    with pytest.raises(ValidationError):
        plan.user_query = "different"


# ---------------------------------------------------------------------------
# ToolResult
# ---------------------------------------------------------------------------

def test_tool_result_failure_default():
    r = ToolResult(step_id=uuid4(), tool="search_crm", ok=False, error="boom")
    assert r.ok is False
    assert r.data is None
    assert r.error == "boom"


def test_tool_result_success_carries_data():
    r = ToolResult(
        step_id=uuid4(), tool="search_crm", ok=True,
        data={"items": [{"id": "001"}]},
        citations=("hit_1",),
        duration_ms=42,
        cost_usd=0.001,
    )
    assert r.ok is True
    assert r.data["items"][0]["id"] == "001"
    assert r.citations == ("hit_1",)


def test_tool_result_frozen():
    r = ToolResult(step_id=uuid4(), tool="x", ok=True)
    with pytest.raises(ValidationError):
        r.ok = False


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def test_evaluation_factuality_bounds():
    with pytest.raises(ValidationError):
        Evaluation(
            plan_id=uuid4(), factuality=1.5, completeness=0.5,
            verdict=EvalVerdict.PASS,
        )
    with pytest.raises(ValidationError):
        Evaluation(
            plan_id=uuid4(), factuality=-0.1, completeness=0.5,
            verdict=EvalVerdict.PASS,
        )


def test_evaluation_harm_pattern():
    with pytest.raises(ValidationError):
        Evaluation(
            plan_id=uuid4(), factuality=1.0, completeness=1.0,
            verdict=EvalVerdict.PASS, harm="catastrophic",   # not in enum
        )


@pytest.mark.parametrize("harm", ["none", "mild", "severe"])
def test_evaluation_harm_accepted_values(harm):
    e = Evaluation(
        plan_id=uuid4(), factuality=1.0, completeness=1.0,
        verdict=EvalVerdict.PASS, harm=harm,
    )
    assert e.harm == harm


@pytest.mark.parametrize("verdict", [EvalVerdict.PASS, EvalVerdict.RETRY, EvalVerdict.ABORT])
def test_evaluation_verdict_enum(verdict):
    e = Evaluation(
        plan_id=uuid4(), factuality=0.5, completeness=0.5, verdict=verdict,
    )
    assert e.verdict == verdict


# ---------------------------------------------------------------------------
# Citation, ChartSpec, SuggestedAction, FinalResponse
# ---------------------------------------------------------------------------

def test_citation_minimal():
    c = Citation(cite_id="c1", entity_type="sf_account", entity_id="001ABC")
    assert c.cite_id == "c1"


def test_chart_spec_kind_pattern():
    with pytest.raises(ValidationError):
        ChartSpec(kind="bogus")
    ChartSpec(kind="bar")
    ChartSpec(kind="line")
    ChartSpec(kind="pie")


def test_suggested_action_carries_rationale():
    a = SuggestedAction(
        kind="update_stage",
        payload={"opportunity_id": "006XYZ", "new_stage": "Closed Won"},
        diff_preview="Stage: Ask in Progress → Closed Won",
        record_label="Acme · 006XYZ",
        rationale="3 prior contacts moved this account to verbal commitment.",
    )
    assert a.kind == "update_stage"


def test_final_response_immutable():
    fr = FinalResponse(plan_id=uuid4(), text="hi")
    with pytest.raises(ValidationError):
        fr.text = "different"


def test_step_type_enum_values():
    """The DB CHECK constraint on bedrock.pebble_chat_scratchpad.step_type
    must accept exactly these values. If this set drifts, the migration
    needs an update — this test is the canary."""
    expected = {
        "plan", "tool_call", "tool_result", "evaluation",
        "render", "conflict", "checkpoint", "error",
    }
    assert {st.value for st in StepType} == expected
