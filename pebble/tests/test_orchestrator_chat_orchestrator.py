"""Tests for ``pebble.orchestrator.chat_orchestrator`` — the
top-level loop tying planner + executor + evaluator + renderer.

Asserts the contract that's hard to verify in any single sub-module:

  A. Happy path: one plan → execute → eval pass → final ships the draft.
  B. Planner returns PlannerError → apology emitted, no execution.
  C. Eval RETRY triggers re-plan; second plan ships.
  D. Eval RETRY with replan budget exhausted ships first draft.
  E. Eval ABORT emits degraded apology, no re-plan.
  F. CHECKPOINT outcome skips eval entirely (intentional pause).
  G. PRE_FLIGHT_REJECTED skips eval (over-budget plan).
  H. Event stream order is: plan → tool_call(s) → draft → eval → final.
  I. Tool call events emit one started + one finished per step.
  J. Re-plan augments recent_messages with eval rationale.
  K. Re-plan that itself fails ships first draft (don't lose progress).
  L. ConversationResult bundle reconstructs from event stream.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.orchestrator.budget import Budget
from pebble.orchestrator.chat_orchestrator import (
    ChatOrchestrator, OrchestratorEvent,
)
from pebble.orchestrator.evaluator import Evaluator, EvaluatorLLMResponse
from pebble.orchestrator.planner import Planner, PlannerLLMResponse
from pebble.orchestrator.schemas import ToolResult
from pebble.orchestrator.scratchpad import ScratchpadWriter
from pebble.orchestrator.tools import (
    ToolContext, ToolRegistry, ToolSpec, make_input_schema,
)


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakePlannerLLM:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
    async def emit_plan(self, *, system, user, tools, max_tokens=2048):
        self.calls.append({"system": system, "user": user})
        head = self.responses.pop(0)
        if isinstance(head, Exception):
            raise head
        return PlannerLLMResponse(text=head)


class FakeJudge:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
    async def emit_evaluation(self, *, system, user, max_tokens=1024):
        self.calls.append({"system": system, "user": user})
        head = self.responses.pop(0)
        if isinstance(head, Exception):
            raise head
        return EvaluatorLLMResponse(text=head)


async def _ok_handler(args, ctx):
    return ToolResult(
        step_id=uuid4(), tool="search_crm", ok=True,
        data={
            "items": [{"entity_type": "sf_account", "entity_id": "001A",
                       "title": "Acme Corp"}],
            "total_count": 1, "query": args.get("query", ""),
        },
        citations=("sf_account:001A",),
    )


async def _checkpoint_handler(args, ctx):
    return ToolResult(
        step_id=uuid4(), tool="request_human_review", ok=True,
        data={"checkpoint": True, "reason": "Disambiguate Acme."},
    )


def _registry() -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(ToolSpec(
        name="search_crm",
        description="Search the CRM",
        input_schema=make_input_schema(
            properties={"query": {"type": "string"}},
            required_keys=["query"],
        ),
        handler=_ok_handler,
    ))
    reg.register(ToolSpec(
        name="request_human_review",
        description="Pause for human input",
        input_schema=make_input_schema(
            properties={"reason": {"type": "string"}},
            required_keys=["reason"],
        ),
        handler=_checkpoint_handler,
        requires_human=True,
    ))
    return reg


def _build_orchestrator(
    planner_responses, judge_responses, *, budget=None,
):
    reg = _registry()
    planner = Planner(client=FakePlannerLLM(planner_responses), registry=reg)
    evaluator = Evaluator(client=FakeJudge(judge_responses))
    scratchpad = ScratchpadWriter(
        pool=None, conversation_id=uuid4(), user_email="rm@pursuit.org",
    )
    ctx = ToolContext(user_email="rm@pursuit.org", conversation_id=str(uuid4()))
    return ChatOrchestrator(
        planner=planner, evaluator=evaluator, registry=reg,
        budget=budget or Budget(),
        ctx=ctx, scratchpad=scratchpad,
    )


_GOOD_PLAN = (
    '{"rationale":"search","estimated_tool_calls":1,"estimated_cost_usd":0.0,'
    '"steps":[{"id":"s1","tool":"search_crm","args":{"query":"Acme"},'
    '"expected_shape":"hits","success_criteria":"any","depends_on":[]}]}'
)
_PASS_EVAL = (
    '{"factuality":0.95,"completeness":0.9,"harm":"none","verdict":"pass","rationale":"good"}'
)
_RETRY_EVAL = (
    '{"factuality":0.5,"completeness":0.5,"harm":"none","verdict":"retry","rationale":"too thin"}'
)
_ABORT_EVAL = (
    '{"factuality":0.4,"completeness":0.4,"harm":"severe","verdict":"abort","rationale":"PII"}'
)


# ---------------------------------------------------------------------------
# A. Happy path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_happy_path_one_plan_one_eval_pass_one_final():
    orch = _build_orchestrator([_GOOD_PLAN], [_PASS_EVAL])
    events = []
    async for ev in orch.run_stream(user_query="find Acme"):
        events.append(ev)
    kinds = [e.kind for e in events]
    assert kinds[0] == "plan_emitted"
    assert "draft_emitted" in kinds
    assert "eval_emitted" in kinds
    assert kinds[-1] == "response_final"
    final_event = events[-1]
    assert "Acme" in final_event.payload["final"]["text"]
    assert final_event.payload["final"]["degraded"] is False


# ---------------------------------------------------------------------------
# B. Planner error → apology
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_planner_error_emits_apology_no_execution():
    orch = _build_orchestrator(["junk", "junk"], [])
    events = []
    async for ev in orch.run_stream(user_query="ambiguous"):
        events.append(ev)
    kinds = [e.kind for e in events]
    assert "error" in kinds
    assert kinds[-1] == "response_final"
    final = events[-1].payload["final"]
    assert final["degraded"] is True
    assert "planner:" in final["degradation_reason"]
    # No tool calls happened.
    assert "tool_call_started" not in kinds


# ---------------------------------------------------------------------------
# C. Re-plan path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_eval_retry_triggers_replan_and_ships_second_plan():
    orch = _build_orchestrator(
        planner_responses=[_GOOD_PLAN, _GOOD_PLAN],
        judge_responses=[_RETRY_EVAL],   # only first eval; second plan skips eval
    )
    events = []
    async for ev in orch.run_stream(user_query="q"):
        events.append(ev)
    kinds = [e.kind for e in events]
    assert kinds.count("plan_emitted") == 2
    # Second plan_emitted has is_replan flag
    second_plan = [e for e in events if e.kind == "plan_emitted"][1]
    assert second_plan.payload.get("is_replan") is True
    final = events[-1]
    assert final.payload.get("replanned") is True


# ---------------------------------------------------------------------------
# D. Re-plan budget exhausted → first draft ships
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_replan_budget_zero_ships_first_draft():
    orch = _build_orchestrator([_GOOD_PLAN], [_RETRY_EVAL])
    orch.max_replans = 0
    events = []
    async for ev in orch.run_stream(user_query="q"):
        events.append(ev)
    # No replan_started event
    assert all(e.kind != "replan_started" for e in events)
    # Final ships the original draft
    assert events[-1].kind == "response_final"


# ---------------------------------------------------------------------------
# E. ABORT path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_eval_abort_emits_degraded_apology():
    orch = _build_orchestrator([_GOOD_PLAN], [_ABORT_EVAL])
    events = []
    async for ev in orch.run_stream(user_query="q"):
        events.append(ev)
    final = events[-1]
    assert final.kind == "response_final"
    assert final.payload["final"]["degraded"] is True
    assert "evaluator_abort" in final.payload["final"]["degradation_reason"]


# ---------------------------------------------------------------------------
# F. Checkpoint skips eval
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_checkpoint_outcome_skips_eval_and_ships_directly():
    plan_with_checkpoint = (
        '{"rationale":"ask","estimated_tool_calls":1,"estimated_cost_usd":0.0,'
        '"steps":[{"id":"s1","tool":"request_human_review",'
        '"args":{"reason":"pick one"},"expected_shape":"","success_criteria":"",'
        '"depends_on":[]}]}'
    )
    orch = _build_orchestrator([plan_with_checkpoint], [])
    events = []
    async for ev in orch.run_stream(user_query="ambiguous"):
        events.append(ev)
    kinds = [e.kind for e in events]
    assert "eval_emitted" not in kinds   # checkpoint skips eval
    assert kinds[-1] == "response_final"


# ---------------------------------------------------------------------------
# G. Pre-flight rejected skips eval
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_pre_flight_rejection_skips_eval():
    over_budget_plan = (
        '{"rationale":"big","estimated_tool_calls":999,"estimated_cost_usd":99.0,'
        '"steps":[{"id":"s1","tool":"search_crm","args":{"query":"x"},'
        '"expected_shape":"","success_criteria":"","depends_on":[]}]}'
    )
    orch = _build_orchestrator([over_budget_plan], [])
    events = []
    async for ev in orch.run_stream(user_query="q"):
        events.append(ev)
    kinds = [e.kind for e in events]
    assert "eval_emitted" not in kinds
    final = events[-1].payload["final"]
    assert final["degraded"] is True


# ---------------------------------------------------------------------------
# H. Event order
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_event_order_is_contractual():
    orch = _build_orchestrator([_GOOD_PLAN], [_PASS_EVAL])
    events = []
    async for ev in orch.run_stream(user_query="q"):
        events.append(ev)
    kinds = [e.kind for e in events]
    # plan first, response_final last; everything else in between
    assert kinds[0] == "plan_emitted"
    assert kinds[-1] == "response_final"
    # tool_call events come before draft, draft before eval, eval before final
    plan_i = kinds.index("plan_emitted")
    draft_i = kinds.index("draft_emitted")
    eval_i = kinds.index("eval_emitted")
    final_i = kinds.index("response_final")
    assert plan_i < draft_i < eval_i < final_i


# ---------------------------------------------------------------------------
# I. One started + one finished per dispatched step
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_one_started_one_finished_event_per_dispatched_step():
    plan_two_steps = (
        '{"rationale":"r","estimated_tool_calls":2,"estimated_cost_usd":0.0,'
        '"steps":['
        '{"id":"s1","tool":"search_crm","args":{"query":"a"},'
        '"expected_shape":"","success_criteria":"","depends_on":[]},'
        '{"id":"s2","tool":"search_crm","args":{"query":"b"},'
        '"expected_shape":"","success_criteria":"","depends_on":[]}'
        ']}'
    )
    orch = _build_orchestrator([plan_two_steps], [_PASS_EVAL])
    events = []
    async for ev in orch.run_stream(user_query="q"):
        events.append(ev)
    started = [e for e in events if e.kind == "tool_call_started"]
    finished = [e for e in events if e.kind == "tool_call_finished"]
    assert len(started) == 2
    assert len(finished) == 2
    # Match by step_id
    started_ids = sorted(e.payload["step_id"] for e in started)
    finished_ids = sorted(e.payload["step_id"] for e in finished)
    assert started_ids == finished_ids


# ---------------------------------------------------------------------------
# J. Re-plan augments recent_messages
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_replan_passes_eval_rationale_to_planner_via_recent_messages():
    p_llm = FakePlannerLLM([_GOOD_PLAN, _GOOD_PLAN])
    j_llm = FakeJudge([_RETRY_EVAL])
    reg = _registry()
    planner = Planner(client=p_llm, registry=reg)
    evaluator = Evaluator(client=j_llm)
    sp = ScratchpadWriter(pool=None, conversation_id=uuid4(),
                           user_email="x@y.org")
    ctx = ToolContext(user_email="x@y.org", conversation_id=str(uuid4()))
    orch = ChatOrchestrator(
        planner=planner, evaluator=evaluator, registry=reg,
        budget=Budget(), ctx=ctx, scratchpad=sp,
    )
    async for _ in orch.run_stream(user_query="q"):
        pass
    # Two planner calls
    assert len(p_llm.calls) == 2
    # The second call's user prompt has the prior eval feedback woven in
    second_user = p_llm.calls[1]["user"]
    assert "rejected" in second_user.lower() or "retry" in second_user.lower()


# ---------------------------------------------------------------------------
# K. Re-plan failure preserves first draft
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_replan_failure_falls_back_to_first_draft():
    orch = _build_orchestrator(
        planner_responses=[_GOOD_PLAN, "junk", "junk"],
        judge_responses=[_RETRY_EVAL],
    )
    events = []
    async for ev in orch.run_stream(user_query="q"):
        events.append(ev)
    kinds = [e.kind for e in events]
    # We tried to re-plan and failed; final still ships
    assert kinds[-1] == "response_final"
    # The replan error event was emitted
    error_events = [e for e in events if e.kind == "error"]
    assert any(e.payload.get("phase") == "replan" for e in error_events)


# ---------------------------------------------------------------------------
# L. ConversationResult bundle
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_run_returns_conversation_result_bundle():
    orch = _build_orchestrator([_GOOD_PLAN], [_PASS_EVAL])
    bundle = await orch.run(user_query="find Acme")
    assert "Acme" in bundle.final.text
    assert bundle.final.degraded is False
    assert bundle.aborted is False


@pytest.mark.asyncio
async def test_run_returns_aborted_flag_when_eval_aborts():
    orch = _build_orchestrator([_GOOD_PLAN], [_ABORT_EVAL])
    bundle = await orch.run(user_query="q")
    assert bundle.aborted is True
    assert bundle.abort_reason is not None
    assert bundle.final.degraded is True


# ---------------------------------------------------------------------------
# M. run_stream_with_plan — direct entry for workflow paths
# ---------------------------------------------------------------------------

def _make_pre_baked_plan():
    """Build a Plan directly (no planner LLM) — what a workflow does."""
    from pebble.orchestrator.schemas import Plan, PlanStep
    return Plan(
        user_query="weekly pipeline review",
        steps=(
            PlanStep(
                tool="search_crm",
                args={"query": "open opportunities"},
                expected_shape="hits",
                success_criteria="any",
            ),
        ),
        rationale="Workflow: weekly_pipeline_review",
        estimated_tool_calls=1,
        estimated_cost_usd=0.0,
    )


@pytest.mark.asyncio
async def test_run_stream_with_plan_skips_planner_call():
    """Workflow path: pre-baked plan goes straight into executor.
    Planner LLM client must NOT be called (ChatOrchestrator's planner
    fixture has zero responses available — would throw if called)."""
    reg = _registry()
    planner = Planner(client=FakePlannerLLM([]), registry=reg)  # zero responses
    evaluator = Evaluator(client=FakeJudge([_PASS_EVAL]))
    ctx = ToolContext(user_email="rm@pursuit.org", conversation_id=str(uuid4()))
    scratchpad = ScratchpadWriter(
        pool=None, conversation_id=uuid4(), user_email="rm@pursuit.org",
    )
    orch = ChatOrchestrator(
        planner=planner, evaluator=evaluator, registry=reg,
        budget=Budget(), ctx=ctx, scratchpad=scratchpad,
    )

    plan = _make_pre_baked_plan()
    events = []
    async for ev in orch.run_stream_with_plan(plan=plan, allow_replan=False):
        events.append(ev)

    kinds = [e.kind for e in events]
    assert kinds[0] == "plan_emitted"
    assert kinds[-1] == "response_final"
    # Planner was NOT called even once
    assert len(planner.client.calls) == 0


@pytest.mark.asyncio
async def test_run_stream_with_plan_eval_retry_with_allow_replan_false_ships_draft():
    """When allow_replan=False (workflow path), eval RETRY ships the
    original draft instead of triggering a planner call."""
    reg = _registry()
    planner = Planner(client=FakePlannerLLM([]), registry=reg)  # zero — proves no replan
    evaluator = Evaluator(client=FakeJudge([_RETRY_EVAL]))
    ctx = ToolContext(user_email="rm@pursuit.org", conversation_id=str(uuid4()))
    scratchpad = ScratchpadWriter(
        pool=None, conversation_id=uuid4(), user_email="rm@pursuit.org",
    )
    orch = ChatOrchestrator(
        planner=planner, evaluator=evaluator, registry=reg,
        budget=Budget(), ctx=ctx, scratchpad=scratchpad, max_replans=1,
    )

    plan = _make_pre_baked_plan()
    events = []
    async for ev in orch.run_stream_with_plan(plan=plan, allow_replan=False):
        events.append(ev)

    kinds = [e.kind for e in events]
    # No replan_started event despite RETRY verdict
    assert "replan_started" not in kinds
    # Planner was NOT called
    assert len(planner.client.calls) == 0
    # Final shipped (the original draft)
    assert kinds[-1] == "response_final"


@pytest.mark.asyncio
async def test_run_stream_with_plan_eval_abort_still_emits_apology_workflow():
    """Workflow path still surfaces ABORT verdict — safety > convenience."""
    reg = _registry()
    planner = Planner(client=FakePlannerLLM([]), registry=reg)
    evaluator = Evaluator(client=FakeJudge([_ABORT_EVAL]))
    ctx = ToolContext(user_email="rm@pursuit.org", conversation_id=str(uuid4()))
    scratchpad = ScratchpadWriter(
        pool=None, conversation_id=uuid4(), user_email="rm@pursuit.org",
    )
    orch = ChatOrchestrator(
        planner=planner, evaluator=evaluator, registry=reg,
        budget=Budget(), ctx=ctx, scratchpad=scratchpad,
    )

    plan = _make_pre_baked_plan()
    events = []
    async for ev in orch.run_stream_with_plan(plan=plan, allow_replan=False):
        events.append(ev)

    final = events[-1]
    assert final.kind == "response_final"
    assert final.payload["final"]["degraded"] is True


@pytest.mark.asyncio
async def test_run_stream_with_plan_allow_replan_true_still_works():
    """Default allow_replan=True path — RETRY triggers planner call
    just like run_stream does. Sanity check the flag default."""
    reg = _registry()
    planner = Planner(client=FakePlannerLLM([_GOOD_PLAN]), registry=reg)
    evaluator = Evaluator(client=FakeJudge([_RETRY_EVAL, _PASS_EVAL]))
    ctx = ToolContext(user_email="rm@pursuit.org", conversation_id=str(uuid4()))
    scratchpad = ScratchpadWriter(
        pool=None, conversation_id=uuid4(), user_email="rm@pursuit.org",
    )
    orch = ChatOrchestrator(
        planner=planner, evaluator=evaluator, registry=reg,
        budget=Budget(), ctx=ctx, scratchpad=scratchpad, max_replans=1,
    )

    plan = _make_pre_baked_plan()
    events = []
    async for ev in orch.run_stream_with_plan(
        plan=plan, user_query="q", allow_replan=True,
    ):
        events.append(ev)

    kinds = [e.kind for e in events]
    # With allow_replan=True, RETRY triggers replan_started + new plan_emitted
    assert "replan_started" in kinds
    # Planner was called once for the re-plan
    assert len(planner.client.calls) == 1


@pytest.mark.asyncio
async def test_run_stream_with_plan_pre_flight_rejected_skips_eval():
    """Pre-flight rejection (plan over budget) skips eval same as in
    run_stream. Workflow callers see the same outcome."""
    reg = _registry()
    planner = Planner(client=FakePlannerLLM([]), registry=reg)
    evaluator = Evaluator(client=FakeJudge([]))  # zero — proves not called
    ctx = ToolContext(user_email="rm@pursuit.org", conversation_id=str(uuid4()))
    scratchpad = ScratchpadWriter(
        pool=None, conversation_id=uuid4(), user_email="rm@pursuit.org",
    )
    # Tiny budget that the plan's estimate will exceed
    tiny_budget = Budget(max_tool_calls=0, max_cost_usd=0.0)
    orch = ChatOrchestrator(
        planner=planner, evaluator=evaluator, registry=reg,
        budget=tiny_budget, ctx=ctx, scratchpad=scratchpad,
    )

    plan = _make_pre_baked_plan()  # estimated 1 tool call vs 0 budget
    events = []
    async for ev in orch.run_stream_with_plan(plan=plan, allow_replan=False):
        events.append(ev)

    kinds = [e.kind for e in events]
    assert kinds[0] == "plan_emitted"
    assert "eval_emitted" not in kinds  # skipped
    assert kinds[-1] == "response_final"
    final = events[-1]
    assert final.payload["final"]["degraded"] is True
