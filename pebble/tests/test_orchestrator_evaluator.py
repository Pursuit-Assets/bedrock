"""Tests for ``pebble.orchestrator.evaluator`` — Haiku-as-judge.

Asserts:
  A. Happy PASS — high scores, no harm → PASS verdict.
  B. RETRY when factuality below floor.
  C. RETRY when completeness below floor.
  D. ABORT when harm == 'severe'.
  E. Empty draft short-circuits to RETRY without LLM call.
  F. Malformed LLM JSON → RETRY (conservative default).
  G. LLM exception → failsafe PASS (don't block users on judge outage).
  H. LLM verdict can be more conservative than derived; we honor it.
  I. Floor-derived verdict can be more conservative than LLM; we honor it.
  J. Code-fence wrapped JSON parses.
  K. Out-of-range scores get clamped to [0, 1].
  L. Tool trace built from plan + results, includes failures.
  M. Citations summarized into prompt.
  N. rejected_claims captured.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from uuid import uuid4

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.orchestrator.evaluator import (
    Evaluator, EvaluatorLLMResponse,
    _clamp_unit, _derive_verdict, _format_tool_trace,
    _more_conservative, _parse_evaluation,
)
from pebble.orchestrator.schemas import (
    Citation, EvalVerdict, FinalResponse, Plan, PlanStep, ToolResult,
)


class FakeJudge:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
    async def emit_evaluation(self, *, system, user, max_tokens=1024):
        self.calls.append({"system": system, "user": user})
        if not self.responses:
            raise AssertionError("FakeJudge exhausted")
        head = self.responses.pop(0)
        if isinstance(head, Exception):
            raise head
        if isinstance(head, str):
            return EvaluatorLLMResponse(text=head)
        return head


def _plan() -> Plan:
    s1 = PlanStep(tool="search_crm", args={"query": "x"})
    return Plan(user_query="What's Acme's status?", steps=(s1,), rationale="search")


def _draft(text="Acme is in Discovery, $200k MRR.", citations=()):
    return FinalResponse(plan_id=uuid4(), text=text, citations=citations)


# ---------------------------------------------------------------------------
# A. PASS
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_pass_when_scores_high_and_no_harm():
    judge = FakeJudge(['{"factuality":0.95,"completeness":0.9,"harm":"none","verdict":"pass","rationale":"ok"}'])
    e = Evaluator(client=judge)
    plan = _plan()
    result = await e.evaluate(plan=plan, tool_results={}, draft=_draft())
    assert result.verdict == EvalVerdict.PASS
    assert result.factuality == 0.95


# ---------------------------------------------------------------------------
# B. RETRY on factuality
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_retry_when_factuality_low():
    judge = FakeJudge(['{"factuality":0.5,"completeness":0.9,"harm":"none","verdict":"retry","rationale":"too speculative"}'])
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft())
    assert result.verdict == EvalVerdict.RETRY


# ---------------------------------------------------------------------------
# C. RETRY on completeness
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_retry_when_completeness_low():
    judge = FakeJudge(['{"factuality":0.95,"completeness":0.3,"harm":"none","verdict":"retry","rationale":"didn\'t finish"}'])
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft())
    assert result.verdict == EvalVerdict.RETRY


# ---------------------------------------------------------------------------
# D. ABORT on severe harm
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_abort_when_severe_harm():
    judge = FakeJudge(['{"factuality":0.9,"completeness":0.9,"harm":"severe","verdict":"abort","rationale":"PII leak"}'])
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft())
    assert result.verdict == EvalVerdict.ABORT
    assert result.harm == "severe"


# ---------------------------------------------------------------------------
# E. Empty draft short-circuits — no LLM call
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_empty_draft_short_circuits_to_retry():
    judge = FakeJudge([])   # exhausted = test will fail if called
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft(text="   "))
    assert result.verdict == EvalVerdict.RETRY
    assert result.completeness == 0.0
    assert len(judge.calls) == 0


# ---------------------------------------------------------------------------
# F. Malformed JSON → conservative RETRY
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_malformed_json_defaults_retry():
    judge = FakeJudge(["not json"])
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft())
    assert result.verdict == EvalVerdict.RETRY
    assert "malformed" in result.rationale.lower()


@pytest.mark.asyncio
async def test_non_object_json_defaults_retry():
    judge = FakeJudge(["[1, 2, 3]"])
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft())
    assert result.verdict == EvalVerdict.RETRY


# ---------------------------------------------------------------------------
# G. LLM outage = failsafe PASS
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_llm_outage_failsafe_pass():
    judge = FakeJudge([RuntimeError("Anthropic 500")])
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft())
    assert result.verdict == EvalVerdict.PASS
    assert "failsafe" in result.rationale.lower()


# ---------------------------------------------------------------------------
# H. LLM verdict ABORT overrides derived PASS
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_llm_abort_wins_over_derived_pass():
    """LLM gave high scores but said abort — we honor abort because
    the LLM saw something the floors didn't."""
    judge = FakeJudge(['{"factuality":0.95,"completeness":0.95,"harm":"none","verdict":"abort","rationale":"caught a wrong-entity issue"}'])
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft())
    assert result.verdict == EvalVerdict.ABORT


# ---------------------------------------------------------------------------
# I. Derived RETRY overrides LLM PASS (LLM tries to over-pass)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_derived_retry_wins_over_llm_pass():
    """LLM said pass but scores are below floor — we retry. Defense
    in depth: don't trust the LLM's verdict alone if its own scores
    contradict it."""
    judge = FakeJudge(['{"factuality":0.4,"completeness":0.4,"harm":"none","verdict":"pass","rationale":"good enough"}'])
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft())
    assert result.verdict == EvalVerdict.RETRY


# ---------------------------------------------------------------------------
# J. Code fence
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_code_fence_wrapped_response_parses():
    text = '```json\n{"factuality":0.9,"completeness":0.9,"harm":"none","verdict":"pass","rationale":"ok"}\n```'
    judge = FakeJudge([text])
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft())
    assert result.verdict == EvalVerdict.PASS


# ---------------------------------------------------------------------------
# K. Score clamping
# ---------------------------------------------------------------------------

def test_clamp_unit_clamps_high():
    assert _clamp_unit(1.5, default=0.5) == 1.0


def test_clamp_unit_clamps_low():
    assert _clamp_unit(-0.2, default=0.5) == 0.0


def test_clamp_unit_garbage_returns_default():
    assert _clamp_unit("not a float", default=0.5) == 0.5


def test_clamp_unit_none_returns_default():
    assert _clamp_unit(None, default=0.7) == 0.7


# ---------------------------------------------------------------------------
# L. Tool trace formatting
# ---------------------------------------------------------------------------

def test_tool_trace_includes_failures_and_successes():
    s1 = PlanStep(tool="a")
    s2 = PlanStep(tool="b")
    plan = Plan(user_query="q", steps=(s1, s2))
    results = {
        s1.step_id: ToolResult(step_id=s1.step_id, tool="a", ok=True, data={"x": 1}),
        s2.step_id: ToolResult(step_id=s2.step_id, tool="b", ok=False, error="boom"),
    }
    trace = _format_tool_trace(plan, results)
    assert "OK" in trace
    assert "FAIL" in trace
    assert "boom" in trace


def test_tool_trace_marks_unexecuted_step():
    s1 = PlanStep(tool="a")
    s2 = PlanStep(tool="b")
    plan = Plan(user_query="q", steps=(s1, s2))
    # s1 ran, s2 didn't (e.g., budget exhausted before reaching it)
    results = {
        s1.step_id: ToolResult(step_id=s1.step_id, tool="a", ok=True, data={}),
    }
    trace = _format_tool_trace(plan, results)
    assert "NOT EXECUTED" in trace


# ---------------------------------------------------------------------------
# M. Citations make it into the prompt
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_citations_summarized_into_prompt():
    cite = Citation(cite_id="c1", entity_type="sf_account", entity_id="001ABC", title="Acme Corp")
    draft = _draft(citations=(cite,))
    judge = FakeJudge(['{"factuality":0.9,"completeness":0.9,"harm":"none","verdict":"pass","rationale":"ok"}'])
    e = Evaluator(client=judge)
    await e.evaluate(plan=_plan(), tool_results={}, draft=draft)
    prompt = judge.calls[0]["user"]
    assert "c1" in prompt
    assert "sf_account:001ABC" in prompt


# ---------------------------------------------------------------------------
# N. rejected_claims preserved
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_rejected_claims_round_trip():
    judge = FakeJudge(['{"factuality":0.5,"completeness":0.9,"harm":"none","verdict":"retry","rationale":"r","rejected_claims":["$2.4M figure not in tool result","stage Discovery not confirmed"]}'])
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft())
    assert len(result.rejected_claims) == 2
    assert "$2.4M" in result.rejected_claims[0]


@pytest.mark.asyncio
async def test_rejected_claims_non_list_ignored():
    judge = FakeJudge(['{"factuality":0.9,"completeness":0.9,"harm":"none","verdict":"pass","rationale":"r","rejected_claims":"not a list"}'])
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft())
    assert result.rejected_claims == ()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def test_more_conservative():
    assert _more_conservative(EvalVerdict.PASS, EvalVerdict.RETRY) == EvalVerdict.RETRY
    assert _more_conservative(EvalVerdict.RETRY, EvalVerdict.PASS) == EvalVerdict.RETRY
    assert _more_conservative(EvalVerdict.RETRY, EvalVerdict.ABORT) == EvalVerdict.ABORT
    assert _more_conservative(EvalVerdict.PASS, EvalVerdict.PASS) == EvalVerdict.PASS


def test_derive_verdict_severe_harm_aborts():
    v = _derive_verdict(
        factuality=1.0, completeness=1.0, harm="severe",
        factuality_floor=0.85, completeness_floor=0.7,
    )
    assert v == EvalVerdict.ABORT


def test_derive_verdict_default_pass():
    v = _derive_verdict(
        factuality=0.9, completeness=0.9, harm="none",
        factuality_floor=0.85, completeness_floor=0.7,
    )
    assert v == EvalVerdict.PASS


def test_parse_evaluation_unknown_verdict_string_falls_back_to_derived():
    """LLM emits a verdict word we don't recognize — we ignore it
    and use the derived verdict."""
    text = '{"factuality":0.9,"completeness":0.9,"harm":"none","verdict":"shrug","rationale":"x"}'
    plan_id = uuid4()
    e = _parse_evaluation(text, plan_id=plan_id, factuality_floor=0.85, completeness_floor=0.7)
    assert e.verdict == EvalVerdict.PASS   # derived from high scores


def test_parse_evaluation_unknown_harm_word_normalized():
    text = '{"factuality":0.9,"completeness":0.9,"harm":"medium","verdict":"pass","rationale":"x"}'
    plan_id = uuid4()
    e = _parse_evaluation(text, plan_id=plan_id, factuality_floor=0.85, completeness_floor=0.7)
    assert e.harm == "none"   # unknown harm word maps to none


# ---------------------------------------------------------------------------
# Cost / token plumbing — the LLM-call accounting flows from
# EvaluatorLLMResponse onto the Evaluation model so the orchestrator's
# eval_emitted SSE event can include it for the FE running tally.
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_evaluation_carries_cost_and_tokens_from_llm_response():
    judge = FakeJudge([EvaluatorLLMResponse(
        text='{"factuality":0.95,"completeness":0.9,"harm":"none","verdict":"pass","rationale":"ok"}',
        cost_usd=0.0008, tokens_in=425, tokens_out=78,
    )])
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft())
    assert result.verdict == EvalVerdict.PASS
    assert result.cost_usd == pytest.approx(0.0008)
    assert result.tokens_in == 425
    assert result.tokens_out == 78


@pytest.mark.asyncio
async def test_evaluation_zero_cost_on_failsafe_path():
    """When the LLM raises, evaluator returns failsafe PASS with zero
    cost — the call never completed, no spend to charge."""
    judge = FakeJudge([RuntimeError("LLM timeout")])
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft())
    assert result.verdict == EvalVerdict.PASS
    assert result.cost_usd == 0.0
    assert result.tokens_in == 0
    assert result.tokens_out == 0


@pytest.mark.asyncio
async def test_evaluation_carries_cost_on_malformed_json_retry():
    """The judge call DID complete (cost incurred) but JSON was bad.
    Cost still recorded so we don't underreport eval spend."""
    judge = FakeJudge([EvaluatorLLMResponse(
        text="not valid json",
        cost_usd=0.0005, tokens_in=400, tokens_out=10,
    )])
    e = Evaluator(client=judge)
    result = await e.evaluate(plan=_plan(), tool_results={}, draft=_draft())
    assert result.verdict == EvalVerdict.RETRY
    assert result.cost_usd == pytest.approx(0.0005)
    assert result.tokens_in == 400
    assert result.tokens_out == 10


def test_parse_evaluation_passes_through_cost_and_tokens():
    """Direct unit test of _parse_evaluation — kwargs propagate."""
    text = '{"factuality":0.9,"completeness":0.9,"harm":"none","verdict":"pass","rationale":""}'
    plan_id = uuid4()
    e = _parse_evaluation(
        text, plan_id=plan_id,
        factuality_floor=0.85, completeness_floor=0.7,
        cost_usd=0.001, tokens_in=300, tokens_out=50,
    )
    assert e.cost_usd == pytest.approx(0.001)
    assert e.tokens_in == 300
    assert e.tokens_out == 50
