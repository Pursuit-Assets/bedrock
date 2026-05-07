"""Renderer — turns executor results into a FinalResponse the FE
can display.

This is the LAST stage of the orchestrator. It takes the plan, the
tool results, and any halt reason, and produces:

  * text          — the user-facing prose
  * citations     — concrete entity refs the renderer-component wraps
  * suggested_actions — write-action confirm cards (none in v1.0
                        unless the planner emitted propose_write)
  * charts        — Recharts-shape JSON specs

Pattern: the renderer is INTENTIONALLY simple in v1.0 — deterministic
templates per outcome, NOT an LLM call. Adding an LLM render step
later is a flag-flip. For now, simple templates are:

  * Auditable (no hallucination risk on the final response).
  * Free (no extra LLM cost).
  * Easy to test exhaustively.
  * Honest about what we know.

The eval pass still runs over the renderer's output to catch
inconsistencies — even templates can produce surprising output if
the plan skipped steps.

When v1.1 adds a synthesis-LLM step, this module is where it
plugs in (a ``RendererLLMClient`` protocol mirroring the planner
pattern). For 1.0, ship the templates — proves the orchestrator
contract end-to-end without LLM-2.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from .executor import ExecutionOutcome, ExecutionResult
from .schemas import (
    Citation, FinalResponse, Plan, ToolResult,
)

logger = logging.getLogger(__name__)


def render(
    *,
    plan: Plan,
    execution: ExecutionResult,
) -> FinalResponse:
    """Synthesize a FinalResponse from the execution output.

    Branches on the execution outcome:

      * COMPLETED — render the tool results into prose.
      * BUDGET_EXHAUSTED — partial answer + degradation flag.
      * TOOL_FAILURE — surface what we did learn + name what failed.
      * CHECKPOINT — the agent paused; render the human-review prompt.
      * PRE_FLIGHT_REJECTED — too-expensive plan; ask user to narrow.
    """
    outcome = execution.outcome

    if outcome == ExecutionOutcome.PRE_FLIGHT_REJECTED:
        return _render_pre_flight(plan, execution)
    if outcome == ExecutionOutcome.BUDGET_EXHAUSTED:
        return _render_budget_exhausted(plan, execution)
    if outcome == ExecutionOutcome.CHECKPOINT:
        return _render_checkpoint(plan, execution)
    if outcome == ExecutionOutcome.TOOL_FAILURE:
        return _render_tool_failure(plan, execution)
    if outcome == ExecutionOutcome.CONFLICT:
        return _render_conflict(plan, execution)

    return _render_completed(plan, execution)


# ---------------------------------------------------------------------------
# Per-outcome templates
# ---------------------------------------------------------------------------

def _render_completed(plan: Plan, execution: ExecutionResult) -> FinalResponse:
    """All steps succeeded. Stitch the tool outputs into a prose
    answer using the success_criteria as section headings.

    Concrete templates per tool — the renderer knows the shape of each
    tool's data so it can pick the right phrasing. Falls back to a
    generic 'returned X items' for unknown tools.
    """
    if not plan.steps:
        return FinalResponse(
            plan_id=plan.plan_id,
            text=plan.rationale or "I don't have a tool that can answer this directly.",
        )

    parts: list[str] = []
    citations = _collect_citations(execution.tool_results)

    for step in plan.steps:
        result = execution.tool_results.get(step.step_id)
        if result is None or not result.ok:
            continue
        rendered = _render_one_result(step.tool, result.data)
        if rendered:
            parts.append(rendered)

    if not parts:
        text = (
            "I ran the plan but the tools didn't return useful data. "
            "Try rephrasing your question or narrowing the entity."
        )
        return FinalResponse(plan_id=plan.plan_id, text=text, degraded=True,
                              degradation_reason="empty_tool_results")

    return FinalResponse(
        plan_id=plan.plan_id,
        text="\n\n".join(parts),
        citations=citations,
    )


def _render_pre_flight(plan: Plan, execution: ExecutionResult) -> FinalResponse:
    text = (
        "I planned this work but it would exceed the per-conversation "
        "budget. Please narrow the request — for example, ask about "
        "one account or one quarter rather than the full pipeline."
    )
    return FinalResponse(
        plan_id=plan.plan_id, text=text, degraded=True,
        degradation_reason=execution.halt_reason or "pre_flight_rejected",
    )


def _render_budget_exhausted(plan: Plan, execution: ExecutionResult) -> FinalResponse:
    """Partial-answer mode. Show what we have, flag what we missed."""
    completed = _render_completed(plan, execution).text
    missing = len(plan.steps) - len(execution.completed_step_ids)
    text = (
        f"{completed}\n\n"
        f"_Note: I stopped early — {missing} planned step(s) didn't run "
        f"because the conversation budget was exhausted. The answer "
        f"above is partial. Ask a narrower follow-up to fill in the gap._"
    )
    return FinalResponse(
        plan_id=plan.plan_id,
        text=text,
        citations=_collect_citations(execution.tool_results),
        degraded=True,
        degradation_reason=execution.halt_reason or "budget_exhausted",
    )


def _render_tool_failure(plan: Plan, execution: ExecutionResult) -> FinalResponse:
    """A blocking tool failure. Surface what we did learn from earlier
    steps, then explain the halt."""
    parts: list[str] = []
    failed_step = next(
        (s for s in plan.steps if s.step_id == execution.failed_step_id),
        None,
    )
    failed_tool = failed_step.tool if failed_step else "(unknown)"

    for step in plan.steps:
        result = execution.tool_results.get(step.step_id)
        if result is None or not result.ok:
            continue
        rendered = _render_one_result(step.tool, result.data)
        if rendered:
            parts.append(rendered)

    if parts:
        prefix = "\n\n".join(parts) + "\n\n"
    else:
        prefix = ""

    text = (
        f"{prefix}_I couldn't finish answering — `{failed_tool}` failed: "
        f"{execution.halt_reason}. The information above is what I was "
        f"able to gather before the failure._"
    )
    return FinalResponse(
        plan_id=plan.plan_id, text=text,
        citations=_collect_citations(execution.tool_results),
        degraded=True,
        degradation_reason=f"tool_failure:{failed_tool}",
    )


def _render_checkpoint(plan: Plan, execution: ExecutionResult) -> FinalResponse:
    """The plan asked for human review (e.g. ambiguous match,
    irreversible write). Render the question; the FE shows option chips.
    """
    reason = execution.halt_reason or "Pebble needs your input to continue."
    return FinalResponse(
        plan_id=plan.plan_id,
        text=reason,
        citations=_collect_citations(execution.tool_results),
        degraded=False,
        degradation_reason=None,
    )


def _render_conflict(plan: Plan, execution: ExecutionResult) -> FinalResponse:
    """Two tool results disagreed above the threshold. v1.0 surfaces
    both with explicit attribution; the user picks. v1.1 adds an
    auto-reconcile path."""
    text = (
        "I got conflicting answers from two sources and I'd rather "
        "show both than guess. Please pick the one you trust."
    )
    return FinalResponse(
        plan_id=plan.plan_id, text=text,
        citations=_collect_citations(execution.tool_results),
        degraded=True, degradation_reason="conflict",
    )


# ---------------------------------------------------------------------------
# Per-tool rendering
# ---------------------------------------------------------------------------

def _render_one_result(tool: str, data: Optional[dict[str, Any]]) -> str:
    """Map a tool's data shape to a prose paragraph. Each known tool
    has a renderer; unknown tools fall back to a generic line so the
    user sees *something* and can adjust their next message."""
    if data is None:
        return ""
    fn = _RENDERERS.get(tool)
    if fn is None:
        return _render_generic(tool, data)
    try:
        return fn(data)
    except Exception:
        logger.exception("renderer.failed tool=%s", tool)
        return _render_generic(tool, data)


def _render_search_crm(data: dict[str, Any]) -> str:
    items = data.get("items") or []
    total = data.get("total_count", len(items))
    query = data.get("query", "")
    if not items:
        return f'I searched the CRM for "{query}" and didn\'t find anything matching.'
    grouped = data.get("grouped") or {}
    if grouped:
        bucket_names = ", ".join(
            f"{len(v)} {k}" for k, v in grouped.items() if v
        )
        head = (
            f'I found {total} result(s) for "{query}": {bucket_names}.'
        )
    else:
        head = f'I found {total} result(s) for "{query}".'
    # Show the top 3 hits with their titles.
    bullets: list[str] = []
    for hit in items[:3]:
        title = hit.get("title") or hit.get("subtitle") or "(untitled)"
        etype = hit.get("entity_type", "?")
        eid = hit.get("entity_id", "?")
        bullets.append(f"  • {title} [{etype}:{eid}]")
    if bullets:
        return head + "\n" + "\n".join(bullets)
    return head


def _render_get_record(data: dict[str, Any]) -> str:
    rec = data.get("record") or {}
    etype = data.get("entity_type", "record")
    eid = data.get("entity_id", "")
    name = (
        rec.get("Name")
        or rec.get("name")
        or rec.get("title")
        or eid
    )
    # Pick a few salient fields if present.
    salient: list[str] = []
    for k in ("StageName", "Stage", "Amount", "CloseDate", "OwnerEmail",
              "Email", "Status", "summary"):
        if k in rec and rec[k] is not None:
            salient.append(f"{k}: {rec[k]}")
    if salient:
        return f"**{name}** ({etype})\n  " + " · ".join(salient[:5])
    return f"**{name}** ({etype}) — record loaded."


def _render_request_human_review(data: dict[str, Any]) -> str:
    """Renderer for checkpoints that fall through to the COMPLETED
    branch (rare — usually checkpoints take their own outcome path).
    Defensive in case the planner emits review without halting.
    """
    return data.get("reason", "Pebble needs input to continue.")


def _render_generic(tool: str, data: dict[str, Any]) -> str:
    """Fallback for tools the renderer doesn't know about. List the
    top-level keys; honest 'I got something but I can't pretty-print it'.
    """
    keys = list(data.keys())[:5]
    if not keys:
        return f"`{tool}`: returned no data."
    return f"`{tool}`: returned " + ", ".join(keys) + "."


_RENDERERS = {
    "search_crm": _render_search_crm,
    "get_record": _render_get_record,
    "request_human_review": _render_request_human_review,
}


# ---------------------------------------------------------------------------
# Citation collection
# ---------------------------------------------------------------------------

def _collect_citations(
    tool_results: dict[Any, ToolResult],
) -> tuple[Citation, ...]:
    """Walk every successful tool result and turn the citation IDs
    into Citation objects. Format produced by tools is
    'entity_type:entity_id'; we split, look up titles where possible.
    """
    seen: set[str] = set()
    citations: list[Citation] = []
    for result in tool_results.values():
        if not result.ok:
            continue
        for cid in result.citations:
            if cid in seen:
                continue
            seen.add(cid)
            etype, _, eid = cid.partition(":")
            if not etype or not eid:
                continue
            citations.append(Citation(
                cite_id=cid,
                entity_type=etype,
                entity_id=eid,
                title=_maybe_extract_title(result.data, etype, eid),
                href=_maybe_build_href(etype, eid),
            ))
    return tuple(citations)


def _maybe_extract_title(
    data: Optional[dict[str, Any]], etype: str, eid: str,
) -> str:
    """Best-effort title lookup from the result's data. Search
    results have items[].title; get_record has record.Name."""
    if not data:
        return ""
    items = data.get("items")
    if isinstance(items, list):
        for hit in items:
            if (hit.get("entity_type") == etype and hit.get("entity_id") == eid):
                return str(hit.get("title") or "")
    rec = data.get("record")
    if (data.get("entity_type") == etype and data.get("entity_id") == eid
            and isinstance(rec, dict)):
        return str(rec.get("Name") or rec.get("name") or rec.get("title") or "")
    return ""


_HREF_FORMATS = {
    "sf_account": "/accounts/{id}",
    "sf_opportunity": "/opportunities/{id}",
    "sf_contact": "/contacts/{id}",
    "sf_task": "/tasks/{id}",
    "bedrock_award": "/awards/{id}",
    "bedrock_project": "/projects/{id}",
    "pebble_profile": "/research/profiles/{id}",
}


def _maybe_build_href(etype: str, eid: str) -> str:
    fmt = _HREF_FORMATS.get(etype)
    return fmt.format(id=eid) if fmt else ""
