"""Tests for ``pebble.orchestrator.renderer`` — turns plan +
ExecutionResult into a FinalResponse the FE displays.

Asserts:
  A. COMPLETED happy path: text + citations populated, not degraded.
  B. PRE_FLIGHT_REJECTED → degraded apology, no tool prose.
  C. BUDGET_EXHAUSTED → partial answer + degradation flag.
  D. TOOL_FAILURE → surfaces what we did learn + names the failed tool.
  E. CHECKPOINT → renders the human-review reason.
  F. Empty plan → "no tool can answer this" message.
  G. Citation collection deduplicates across multiple tool results.
  H. Search results render top-3 hits with entity_type:id labels.
  I. get_record renders Name + salient fields.
  J. Unknown tool falls through to generic '<tool>: returned <keys>'.
  K. Title extraction from search items + get_record record.
  L. href built for known entity types only.
  M. Renderer never raises on garbage data — fallback prevails.
"""

from __future__ import annotations

import os
import sys
from uuid import uuid4

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.orchestrator.executor import ExecutionOutcome, ExecutionResult
from pebble.orchestrator.renderer import (
    _collect_citations, _maybe_build_href, _maybe_extract_title,
    _render_get_record, _render_search_crm, render,
)
from pebble.orchestrator.schemas import (
    Citation, Plan, PlanStep, ToolResult,
)


def _result(step_id, *, tool="x", ok=True, data=None, citations=()):
    return ToolResult(
        step_id=step_id, tool=tool, ok=ok, data=data, citations=citations,
    )


# ---------------------------------------------------------------------------
# A. COMPLETED happy path
# ---------------------------------------------------------------------------

def test_completed_search_renders_top_hits_with_citations():
    s1 = PlanStep(tool="search_crm", args={"query": "Acme"})
    plan = Plan(user_query="find Acme", steps=(s1,))
    exec_result = ExecutionResult(
        outcome=ExecutionOutcome.COMPLETED,
        plan_id=plan.plan_id,
        completed_step_ids=[s1.step_id],
        tool_results={s1.step_id: _result(
            s1.step_id, tool="search_crm",
            data={
                "items": [
                    {"entity_type": "sf_account", "entity_id": "001ABC",
                     "title": "Acme Corp"},
                ],
                "grouped": {"Accounts": [{"entity_type": "sf_account", "entity_id": "001ABC"}]},
                "total_count": 1, "query": "Acme",
            },
            citations=("sf_account:001ABC",),
        )},
    )
    out = render(plan=plan, execution=exec_result)
    assert out.degraded is False
    assert "Acme Corp" in out.text
    assert "1 result" in out.text
    assert len(out.citations) == 1
    assert out.citations[0].entity_type == "sf_account"
    assert out.citations[0].title == "Acme Corp"
    assert out.citations[0].href == "/accounts/001ABC"


# ---------------------------------------------------------------------------
# B. PRE_FLIGHT_REJECTED
# ---------------------------------------------------------------------------

def test_pre_flight_rejection_renders_narrowing_apology():
    plan = Plan(user_query="huge", steps=(PlanStep(tool="search_crm"),),
                estimated_tool_calls=999)
    exec_result = ExecutionResult(
        outcome=ExecutionOutcome.PRE_FLIGHT_REJECTED,
        plan_id=plan.plan_id,
        halt_reason="plan_exceeds_tool_call_budget",
    )
    out = render(plan=plan, execution=exec_result)
    assert out.degraded is True
    assert "narrow" in out.text.lower()
    assert out.degradation_reason == "plan_exceeds_tool_call_budget"


# ---------------------------------------------------------------------------
# C. BUDGET_EXHAUSTED
# ---------------------------------------------------------------------------

def test_budget_exhausted_partial_answer_with_degraded_flag():
    s1 = PlanStep(tool="search_crm")
    s2 = PlanStep(tool="get_record")
    plan = Plan(user_query="q", steps=(s1, s2))
    exec_result = ExecutionResult(
        outcome=ExecutionOutcome.BUDGET_EXHAUSTED,
        plan_id=plan.plan_id,
        completed_step_ids=[s1.step_id],
        tool_results={s1.step_id: _result(
            s1.step_id, tool="search_crm",
            data={"items": [{"entity_type": "sf_account", "entity_id": "001",
                              "title": "Acme"}],
                   "total_count": 1, "query": "Acme"},
            citations=("sf_account:001",),
        )},
        halt_reason="tool_call_budget_exhausted: spent 1 of 1",
    )
    out = render(plan=plan, execution=exec_result)
    assert out.degraded is True
    assert "Acme" in out.text                     # what we did learn
    assert "stopped early" in out.text.lower()    # explanation
    assert "1 planned step" in out.text           # missing count
    assert "budget_exhausted" in out.degradation_reason


# ---------------------------------------------------------------------------
# D. TOOL_FAILURE
# ---------------------------------------------------------------------------

def test_tool_failure_surfaces_learned_data_plus_failure_note():
    s1 = PlanStep(tool="search_crm")
    s2 = PlanStep(tool="get_record")
    plan = Plan(user_query="q", steps=(s1, s2))
    exec_result = ExecutionResult(
        outcome=ExecutionOutcome.TOOL_FAILURE,
        plan_id=plan.plan_id,
        completed_step_ids=[s1.step_id],
        failed_step_id=s2.step_id,
        halt_reason="get_record: timeout",
        tool_results={
            s1.step_id: _result(
                s1.step_id, tool="search_crm",
                data={"items": [{"entity_type": "sf_account", "entity_id": "001",
                                  "title": "Acme"}], "total_count": 1, "query": "Acme"},
            ),
            s2.step_id: _result(s2.step_id, tool="get_record", ok=False),
        },
    )
    out = render(plan=plan, execution=exec_result)
    assert out.degraded is True
    assert "Acme" in out.text
    assert "get_record" in out.text
    assert "timeout" in out.text
    assert "tool_failure:get_record" in out.degradation_reason


def test_tool_failure_unknown_step_falls_back_safely():
    """Edge case: failed_step_id not in plan.steps. Renderer mustn't
    crash."""
    plan = Plan(user_query="q", steps=(PlanStep(tool="x"),))
    exec_result = ExecutionResult(
        outcome=ExecutionOutcome.TOOL_FAILURE,
        plan_id=plan.plan_id, failed_step_id=uuid4(),
        halt_reason="boom",
    )
    out = render(plan=plan, execution=exec_result)
    assert "(unknown)" in out.text
    assert out.degraded is True


# ---------------------------------------------------------------------------
# E. CHECKPOINT
# ---------------------------------------------------------------------------

def test_checkpoint_renders_the_review_reason():
    plan = Plan(user_query="q", steps=(PlanStep(tool="request_human_review"),))
    exec_result = ExecutionResult(
        outcome=ExecutionOutcome.CHECKPOINT,
        plan_id=plan.plan_id,
        halt_reason="Multiple Acme matches; please pick one.",
    )
    out = render(plan=plan, execution=exec_result)
    assert "Acme" in out.text
    assert out.degraded is False     # checkpoint is intentional, not degraded


# ---------------------------------------------------------------------------
# F. Empty plan
# ---------------------------------------------------------------------------

def test_empty_plan_renders_apology():
    plan = Plan(user_query="weather?", steps=(),
                rationale="No CRM tool can answer weather.")
    exec_result = ExecutionResult(
        outcome=ExecutionOutcome.COMPLETED, plan_id=plan.plan_id,
    )
    out = render(plan=plan, execution=exec_result)
    assert "No CRM tool" in out.text


# ---------------------------------------------------------------------------
# G. Citation deduplication
# ---------------------------------------------------------------------------

def test_citations_deduplicated_across_results():
    sid1, sid2 = uuid4(), uuid4()
    results = {
        sid1: _result(sid1, citations=("sf_account:001", "sf_account:002")),
        sid2: _result(sid2, citations=("sf_account:001", "sf_account:003")),
    }
    cits = _collect_citations(results)
    ids = [c.cite_id for c in cits]
    assert sorted(ids) == ["sf_account:001", "sf_account:002", "sf_account:003"]
    assert len(cits) == 3


def test_citations_skip_unsuccessful_results():
    sid = uuid4()
    results = {sid: _result(sid, ok=False, citations=("sf_account:001",))}
    cits = _collect_citations(results)
    assert cits == ()


def test_citations_skip_malformed_ids():
    sid = uuid4()
    results = {sid: _result(sid, citations=("malformed_no_colon", ":missing_type"))}
    cits = _collect_citations(results)
    assert cits == ()


# ---------------------------------------------------------------------------
# H/I. Per-tool renderers
# ---------------------------------------------------------------------------

def test_search_crm_no_results_renders_empty_message():
    text = _render_search_crm({"items": [], "total_count": 0, "query": "xyzzy"})
    assert "didn't find anything" in text


def test_get_record_renders_name_and_salient_fields():
    text = _render_get_record({
        "entity_type": "sf_opportunity",
        "entity_id": "006X",
        "record": {"Name": "Acme Q4", "StageName": "Discovery", "Amount": 250000},
    })
    assert "Acme Q4" in text
    assert "Discovery" in text
    assert "250000" in text


def test_get_record_no_salient_fields_uses_minimal_template():
    text = _render_get_record({
        "entity_type": "sf_account", "entity_id": "001A",
        "record": {"Name": "Acme"},
    })
    assert "Acme" in text
    assert "record loaded" in text


def test_get_record_falls_back_to_id_when_no_name():
    text = _render_get_record({
        "entity_type": "sf_account", "entity_id": "001A",
        "record": {"some_other_field": "x"},
    })
    assert "001A" in text


# ---------------------------------------------------------------------------
# J. Generic fallback for unknown tool
# ---------------------------------------------------------------------------

def test_unknown_tool_falls_through_to_generic_renderer():
    s1 = PlanStep(tool="exotic_tool")
    plan = Plan(user_query="q", steps=(s1,))
    exec_result = ExecutionResult(
        outcome=ExecutionOutcome.COMPLETED, plan_id=plan.plan_id,
        completed_step_ids=[s1.step_id],
        tool_results={s1.step_id: _result(
            s1.step_id, tool="exotic_tool",
            data={"answer": 42, "metadata": "stuff"},
        )},
    )
    out = render(plan=plan, execution=exec_result)
    assert "exotic_tool" in out.text
    assert "answer" in out.text


# ---------------------------------------------------------------------------
# K. Title extraction
# ---------------------------------------------------------------------------

def test_title_extracted_from_search_items():
    data = {
        "items": [
            {"entity_type": "sf_account", "entity_id": "001A", "title": "Acme"},
            {"entity_type": "sf_account", "entity_id": "002B", "title": "Beta"},
        ],
    }
    assert _maybe_extract_title(data, "sf_account", "002B") == "Beta"


def test_title_extracted_from_get_record():
    data = {
        "entity_type": "sf_account", "entity_id": "001A",
        "record": {"Name": "Acme Corp"},
    }
    assert _maybe_extract_title(data, "sf_account", "001A") == "Acme Corp"


def test_title_missing_returns_empty():
    assert _maybe_extract_title(None, "sf_account", "001") == ""


# ---------------------------------------------------------------------------
# L. href construction
# ---------------------------------------------------------------------------

def test_href_for_known_entity_type():
    assert _maybe_build_href("sf_account", "001ABC") == "/accounts/001ABC"
    assert _maybe_build_href("pebble_profile", "p1") == "/research/profiles/p1"


def test_href_for_unknown_entity_type_is_empty():
    assert _maybe_build_href("unknown_type", "x") == ""


# ---------------------------------------------------------------------------
# M. Renderer doesn't crash on garbage data
# ---------------------------------------------------------------------------

def test_completed_with_no_useful_data_renders_degraded_message():
    s1 = PlanStep(tool="exotic_tool")
    plan = Plan(user_query="q", steps=(s1,))
    exec_result = ExecutionResult(
        outcome=ExecutionOutcome.COMPLETED, plan_id=plan.plan_id,
        completed_step_ids=[s1.step_id],
        tool_results={s1.step_id: _result(
            s1.step_id, tool="exotic_tool", data=None,
        )},
    )
    out = render(plan=plan, execution=exec_result)
    assert out.degraded is True
    assert "empty_tool_results" in out.degradation_reason


def test_individual_renderer_failure_falls_back_to_generic():
    """If a tool's renderer raises (e.g. malformed data), we don't
    crash — we use the generic fallback."""
    s1 = PlanStep(tool="search_crm")
    plan = Plan(user_query="q", steps=(s1,))
    # items is a string, not a list — search renderer will explode
    exec_result = ExecutionResult(
        outcome=ExecutionOutcome.COMPLETED, plan_id=plan.plan_id,
        completed_step_ids=[s1.step_id],
        tool_results={s1.step_id: _result(
            s1.step_id, tool="search_crm",
            data={"items": "garbage", "total_count": 0, "query": "x"},
        )},
    )
    out = render(plan=plan, execution=exec_result)
    # Either the generic renderer fired or the search renderer
    # tolerated the bad input — either way no exception escaped.
    assert isinstance(out.text, str)
    assert len(out.text) > 0
