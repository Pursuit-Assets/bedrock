"""Post-execution judge for the Pebble chat orchestrator.

Pattern: LLM-as-judge / evaluator-optimizer (Anthropic
Architect-course session-2). Cheaper / faster model (Haiku) reads the
plan + tool results + the renderer's draft and scores three things:

  * factuality   — Are the claims in the draft grounded in the tool
                    results? Or did the renderer hallucinate?
  * completeness — Did the plan + execution actually answer the
                    user's original question? Or did we stop short?
  * harm         — Did we produce anything unsafe / off-policy?

Verdict is one of three:

  * PASS  — ship the draft as-is. Renderer's job is done.
  * RETRY — re-plan with the evaluator's rationale appended. Bounded
            to ONE re-plan per conversation; the orchestrator owns
            the count, the evaluator just emits a verdict.
  * ABORT — stop. Surface a degraded "I couldn't answer that
            confidently" response. Used for harm-detected cases or
            for queries the planner has already retried once.

The evaluator is BLOCKING but cheap — Haiku's pricing makes the
factuality check trivially affordable on every conversation. Skipping
it for cost reasons is a false economy: the cost of shipping a
hallucinated CRM answer is higher than the eval token cost.

Like the planner, this module is purely a consumer of an LLM client
protocol. Tests inject a stub.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Optional, Protocol

from .schemas import EvalVerdict, Evaluation, FinalResponse, Plan, ToolResult

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# LLM client protocol
# ---------------------------------------------------------------------------

class EvaluatorLLMClient(Protocol):
    """Minimal protocol for the evaluator's LLM dependency."""

    async def emit_evaluation(
        self,
        *,
        system: str,
        user: str,
        max_tokens: int = 1024,
    ) -> "EvaluatorLLMResponse": ...


@dataclass(frozen=True)
class EvaluatorLLMResponse:
    text: str
    cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are Pebble's evaluator — an LLM-as-judge that reads an agent
trace and scores whether the response is good enough to ship.

You DO NOT generate the response. You only judge what the planner
and renderer have produced.

# Output format

Emit a single JSON object on one line, no prose, no markdown fences.
Schema:

  {
    "factuality": 0.0-1.0,        // 1.0 = every claim is grounded in tool results
    "completeness": 0.0-1.0,      // 1.0 = the user's question is fully answered
    "harm": "none" | "mild" | "severe",
    "verdict": "pass" | "retry" | "abort",
    "rationale": "one or two sentences explaining the score",
    "rejected_claims": ["literal string from draft that's not supported", ...]
  }

# Verdict rules

  * verdict = "pass"   — factuality >= 0.85 AND completeness >= 0.7
                          AND harm == "none". Default to pass when in doubt.
  * verdict = "retry"  — factuality < 0.85 OR completeness < 0.7,
                          AND harm != "severe". Re-planning may help.
  * verdict = "abort"  — harm == "severe" OR the response is
                          fundamentally wrong in a way re-planning
                          won't fix (e.g. plan touched the wrong
                          entity entirely).

# Calibration

  * Prefer pass when the draft is approximately right. Perfect is
    not the bar. Useful is.
  * Be skeptical of crisp numbers ("$2.4M pipeline"); double-check
    the supporting tool result actually contains that figure.
  * Empty or near-empty drafts on a non-trivial question should
    score completeness <= 0.5.
"""


_USER_TEMPLATE = """\
Original user query:
{user_query}

Plan rationale:
{rationale}

Tool calls + results:
{tool_trace}

Renderer draft (the text Pebble is about to ship):
{draft_text}

Citations attached to the draft:
{citation_summary}

Emit the evaluation JSON now.
"""


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------

class Evaluator:
    """Stateless evaluator. One method: ``evaluate(...)``. Same
    instance can score many conversations in parallel.
    """

    def __init__(
        self,
        client: EvaluatorLLMClient,
        *,
        factuality_floor: float = 0.85,
        completeness_floor: float = 0.7,
    ) -> None:
        self.client = client
        self.factuality_floor = factuality_floor
        self.completeness_floor = completeness_floor

    async def evaluate(
        self,
        *,
        plan: Plan,
        tool_results: dict[Any, ToolResult],
        draft: FinalResponse,
    ) -> Evaluation:
        """Score the draft. Never raises — on LLM error returns a
        conservative PASS so a transient evaluator outage doesn't
        block all responses (the renderer's draft is what users see;
        the eval is a safety net, not a gate).

        TODO: harm-classifier path is upgrade target — for now we trust
        the evaluator LLM to detect 'severe'.
        """
        if not draft.text or not draft.text.strip():
            # Trivial guard — no draft is incomplete by definition.
            return Evaluation(
                plan_id=plan.plan_id,
                factuality=1.0,
                completeness=0.0,
                harm="none",
                verdict=EvalVerdict.RETRY,
                rationale="Draft was empty; re-plan needed.",
            )

        tool_trace = _format_tool_trace(plan, tool_results)
        citation_summary = _format_citations(draft)
        user_prompt = _USER_TEMPLATE.format(
            user_query=plan.user_query,
            rationale=plan.rationale or "(no rationale)",
            tool_trace=tool_trace or "(no tool calls)",
            draft_text=draft.text.strip(),
            citation_summary=citation_summary or "(no citations)",
        )

        try:
            resp = await self.client.emit_evaluation(
                system=_SYSTEM_PROMPT,
                user=user_prompt,
            )
        except Exception as e:
            logger.exception("evaluator.llm_call_failed")
            # Failsafe PASS — don't let an evaluator outage block users.
            return Evaluation(
                plan_id=plan.plan_id,
                factuality=1.0,
                completeness=1.0,
                harm="none",
                verdict=EvalVerdict.PASS,
                rationale=f"Evaluator unavailable ({type(e).__name__}); failsafe pass.",
            )

        return _parse_evaluation(
            resp.text,
            plan_id=plan.plan_id,
            factuality_floor=self.factuality_floor,
            completeness_floor=self.completeness_floor,
        )


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def _parse_evaluation(
    text: str,
    *,
    plan_id,
    factuality_floor: float,
    completeness_floor: float,
) -> Evaluation:
    """Parse the LLM's JSON output. On any malformed response,
    return a conservative RETRY verdict — better to spend one re-plan
    than to ship an unevaluated response.
    """
    raw = (text or "").strip()
    if raw.startswith("```"):
        # Strip code fence
        lines = raw.split("\n")
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        raw = "\n".join(lines).strip()

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("evaluator.malformed_json text=%r", text[:200])
        return Evaluation(
            plan_id=plan_id,
            factuality=0.5,
            completeness=0.5,
            harm="none",
            verdict=EvalVerdict.RETRY,
            rationale="Evaluator returned malformed JSON; defaulting to retry.",
        )

    if not isinstance(parsed, dict):
        return Evaluation(
            plan_id=plan_id,
            factuality=0.5, completeness=0.5, harm="none",
            verdict=EvalVerdict.RETRY,
            rationale="Evaluator output not a JSON object; defaulting to retry.",
        )

    factuality = _clamp_unit(parsed.get("factuality"), default=0.5)
    completeness = _clamp_unit(parsed.get("completeness"), default=0.5)
    harm_raw = str(parsed.get("harm") or "none").lower()
    harm = harm_raw if harm_raw in {"none", "mild", "severe"} else "none"

    rationale = str(parsed.get("rationale") or "")[:500]

    rejected = parsed.get("rejected_claims") or []
    if not isinstance(rejected, list):
        rejected = []
    rejected_tuple = tuple(str(r) for r in rejected if isinstance(r, str))[:10]

    # Verdict: trust the LLM when it gave us a valid one; otherwise
    # derive from floors. (Defense-in-depth: the LLM's word AND the
    # floors must both agree on PASS.)
    raw_verdict = str(parsed.get("verdict") or "").lower()
    derived = _derive_verdict(
        factuality=factuality,
        completeness=completeness,
        harm=harm,
        factuality_floor=factuality_floor,
        completeness_floor=completeness_floor,
    )
    if raw_verdict in {"pass", "retry", "abort"}:
        # Use the more conservative of the two.
        llm_verdict = EvalVerdict(raw_verdict)
        verdict = _more_conservative(llm_verdict, derived)
    else:
        verdict = derived

    return Evaluation(
        plan_id=plan_id,
        factuality=factuality,
        completeness=completeness,
        harm=harm,
        verdict=verdict,
        rationale=rationale,
        rejected_claims=rejected_tuple,
    )


def _clamp_unit(value: Any, *, default: float) -> float:
    """Coerce to float in [0, 1]; default on garbage."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    if f < 0.0:
        return 0.0
    if f > 1.0:
        return 1.0
    return f


def _derive_verdict(
    *,
    factuality: float,
    completeness: float,
    harm: str,
    factuality_floor: float,
    completeness_floor: float,
) -> EvalVerdict:
    if harm == "severe":
        return EvalVerdict.ABORT
    if factuality < factuality_floor or completeness < completeness_floor:
        return EvalVerdict.RETRY
    return EvalVerdict.PASS


def _more_conservative(a: EvalVerdict, b: EvalVerdict) -> EvalVerdict:
    """ABORT > RETRY > PASS. Used to AND the LLM's verdict with the
    floor-derived verdict — if either says retry, retry.
    """
    rank = {EvalVerdict.PASS: 0, EvalVerdict.RETRY: 1, EvalVerdict.ABORT: 2}
    return a if rank[a] >= rank[b] else b


def _format_tool_trace(plan: Plan, results: dict[Any, ToolResult]) -> str:
    """Compact rendering: each tool call + its OK/error + the data
    keys returned. Full data goes through the user prompt only for
    small payloads; large payloads get summarized.
    """
    if not plan.steps:
        return ""
    lines: list[str] = []
    for idx, step in enumerate(plan.steps, 1):
        result = results.get(step.step_id)
        if result is None:
            lines.append(f"  step {idx} ({step.tool}): NOT EXECUTED")
            continue
        if result.ok:
            data_summary = _summarize_data(result.data)
            lines.append(f"  step {idx} ({step.tool}): OK · {data_summary}")
        else:
            lines.append(f"  step {idx} ({step.tool}): FAIL · {result.error}")
    return "\n".join(lines)


def _summarize_data(data: Optional[dict[str, Any]]) -> str:
    """One-liner summary of a tool's data dict. Caps at ~240 chars
    so the eval prompt stays bounded.
    """
    if data is None:
        return "(no data)"
    s = json.dumps(data, default=str)
    if len(s) <= 240:
        return s
    return s[:240] + "…"


def _format_citations(draft: FinalResponse) -> str:
    if not draft.citations:
        return ""
    return "; ".join(
        f"{c.cite_id}={c.entity_type}:{c.entity_id}"
        for c in draft.citations
    )
