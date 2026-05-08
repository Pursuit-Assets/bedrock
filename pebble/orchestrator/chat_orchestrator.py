"""Top-level chat orchestrator — ties planner + executor + renderer
+ evaluator into a single coherent agentic loop.

Lifecycle (per user message):

    1. planner.plan(user_query)            → Plan or PlannerError
    2. executor.run(plan)                  → ExecutionResult
    3. renderer.render(plan, execution)    → FinalResponse draft
    4. evaluator.evaluate(plan, results, draft) → Evaluation
    5. if evaluator says RETRY and we have re-plans left:
         - re-prompt the planner with the evaluator's rationale
         - go back to step 2 with the new plan
       elif ABORT:
         - surface a degraded "couldn't answer confidently" response
       else (PASS):
         - emit FinalResponse to the user

Bounded autonomy: ONE re-plan per conversation by default. Two would
let the agent oscillate; one is enough to recover from transient
issues.

Streaming: ``run_stream(...)`` yields ``OrchestratorEvent`` records
for the SSE relay in ``routes/pebble_proxy.py``. Events:

    plan_emitted, tool_call_started, tool_call_finished,
    eval_emitted, replan_started, draft_emitted, response_final, error

Each event carries enough payload that the FE can render the agent's
"plan as todos" view live without re-fetching anything.

The orchestrator is testable in isolation: every dependency
(planner, executor, evaluator) is injected. Integration tests stub
the LLM clients with FakeLLM/FakeJudge; unit tests above each
sub-module already cover the depth.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Optional
from uuid import UUID, uuid4

from .budget import Budget
from .evaluator import Evaluator
from .executor import ExecutionOutcome, ExecutionResult, Executor
from .planner import Planner, PlannerError
from .renderer import render as render_response
from .schemas import (
    EvalVerdict, Evaluation, FinalResponse, Plan,
)
from .scratchpad import ScratchpadWriter
from .tools import ToolContext, ToolRegistry

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Streaming events
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class OrchestratorEvent:
    """Single SSE event. ``kind`` drives the FE component, ``payload``
    is shape-specific.
    """
    kind: str
    payload: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Conversation result
# ---------------------------------------------------------------------------

@dataclass
class ConversationResult:
    """The full bundle of what happened in a conversation turn.
    The /api/pebble/ask route returns this; the FE displays final +
    persists trace ids for follow-ups.
    """
    final: FinalResponse
    plan: Optional[Plan] = None
    execution: Optional[ExecutionResult] = None
    evaluation: Optional[Evaluation] = None
    replanned: bool = False
    aborted: bool = False
    abort_reason: Optional[str] = None


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

class ChatOrchestrator:
    """Top-level coordinator. Inject planner + executor-deps + evaluator;
    call ``run(user_query)`` per turn. The orchestrator owns the
    re-plan budget — sub-modules don't know they may be invoked twice.
    """

    def __init__(
        self,
        *,
        planner: Planner,
        evaluator: Evaluator,
        registry: ToolRegistry,
        budget: Budget,
        ctx: ToolContext,
        scratchpad: ScratchpadWriter,
        max_replans: int = 1,
    ) -> None:
        self.planner = planner
        self.evaluator = evaluator
        self.registry = registry
        self.budget = budget
        self.ctx = ctx
        self.scratchpad = scratchpad
        self.max_replans = max_replans

    # ---- Public surface ----

    async def run(
        self,
        *,
        user_query: str,
        recent_messages: Optional[list[dict[str, str]]] = None,
    ) -> ConversationResult:
        """Non-streaming entry point — runs the full loop and returns
        the ConversationResult once final.
        """
        events: list[OrchestratorEvent] = []
        async for ev in self.run_stream(
            user_query=user_query, recent_messages=recent_messages,
        ):
            events.append(ev)
        # The last event by contract is the final or error event.
        final_event = next(
            (e for e in reversed(events) if e.kind in ("response_final", "error")),
            None,
        )
        # Reconstruct from the events we accumulated.
        return _bundle_from_events(events)

    async def run_stream(
        self,
        *,
        user_query: str,
        recent_messages: Optional[list[dict[str, str]]] = None,
    ) -> AsyncIterator[OrchestratorEvent]:
        """Top-level entry — calls planner, then defers to
        ``run_stream_with_plan`` for the post-planner pipeline.

        Order is contractually:
          plan_emitted → (tool_call_started + tool_call_finished)*
          → draft_emitted → eval_emitted
          → optionally replan_started → ... → response_final
        """
        plan_or_err = await self.planner.plan(
            user_query=user_query,
            ctx=self.ctx,
            recent_messages=recent_messages,
        )
        if isinstance(plan_or_err, PlannerError):
            yield OrchestratorEvent(
                kind="error",
                payload={"phase": "planning", **plan_or_err.to_dict()},
            )
            apology = FinalResponse(
                plan_id=uuid4(),
                text=(
                    "I couldn't put together a plan for that question. "
                    "Try rephrasing — for example, name the specific "
                    "account, person, or metric you're after."
                ),
                degraded=True,
                degradation_reason=f"planner:{plan_or_err.reason}",
            )
            yield OrchestratorEvent(
                kind="response_final",
                payload={"final": _final_to_dict(apology)},
            )
            return

        async for ev in self.run_stream_with_plan(
            plan=plan_or_err,
            user_query=user_query,
            recent_messages=recent_messages,
            allow_replan=True,
        ):
            yield ev

    async def run_stream_with_plan(
        self,
        *,
        plan: Plan,
        user_query: Optional[str] = None,
        recent_messages: Optional[list[dict[str, str]]] = None,
        allow_replan: bool = True,
    ) -> AsyncIterator[OrchestratorEvent]:
        """Run a pre-baked Plan through the post-planner pipeline:
        executor → render → eval → (optional re-plan) → response_final.

        Workflow callers (e.g. ``/pipeline`` slash command) pass
        ``allow_replan=False`` so an evaluator RETRY verdict ships the
        original draft instead of triggering a planner LLM call —
        workflows are deterministic by design and a re-plan would
        defeat the purpose.

        Args:
          plan: the plan to execute. Pre-baked (workflow) or planner-
            emitted (``run_stream``).
          user_query: original user query string. Used in the re-plan
            prompt — required when ``allow_replan=True``, optional
            otherwise.
          recent_messages: prior conversation context for re-plan.
          allow_replan: when False, eval RETRY verdict ships the
            current draft. Workflows pass False; agent runs pass True.
        """
        # Emit the initial plan event so FE renders the todo-list.
        yield OrchestratorEvent(
            kind="plan_emitted",
            payload={
                "plan_id": str(plan.plan_id),
                "rationale": plan.rationale,
                "steps": [
                    {"step_id": str(s.step_id), "tool": s.tool, "args": s.args}
                    for s in plan.steps
                ],
                "estimated_tool_calls": plan.estimated_tool_calls,
                "estimated_cost_usd": plan.estimated_cost_usd,
            },
        )

        # First execution + render.
        execution = await self._execute_with_events(plan)
        async for ev in execution["events"]:
            yield ev
        result: ExecutionResult = execution["result"]

        draft = render_response(plan=plan, execution=result)
        yield OrchestratorEvent(
            kind="draft_emitted",
            payload={"draft": _final_to_dict(draft)},
        )

        # Skip eval / re-plan when execution itself halted on a clean
        # checkpoint or pre-flight rejection — re-planning won't help
        # because the issue was the request, not the answer.
        if result.outcome in (
            ExecutionOutcome.PRE_FLIGHT_REJECTED,
            ExecutionOutcome.CHECKPOINT,
        ):
            yield OrchestratorEvent(
                kind="response_final",
                payload={"final": _final_to_dict(draft)},
            )
            return

        evaluation = await self.evaluator.evaluate(
            plan=plan, tool_results=result.tool_results, draft=draft,
        )
        await self.scratchpad.write_evaluation({
            "verdict": evaluation.verdict.value,
            "factuality": evaluation.factuality,
            "completeness": evaluation.completeness,
            "harm": evaluation.harm,
            "rationale": evaluation.rationale,
            "rejected_claims": list(evaluation.rejected_claims),
        })
        yield OrchestratorEvent(
            kind="eval_emitted",
            payload={
                "verdict": evaluation.verdict.value,
                "factuality": evaluation.factuality,
                "completeness": evaluation.completeness,
                "harm": evaluation.harm,
                "rationale": evaluation.rationale,
            },
        )

        if evaluation.verdict == EvalVerdict.ABORT:
            aborted_text = (
                "I had an answer ready but my safety check flagged it. "
                f"Reason: {evaluation.rationale or '(no rationale)'}. "
                "Try rephrasing or ask a more specific question."
            )
            apology = FinalResponse(
                plan_id=plan.plan_id, text=aborted_text,
                degraded=True, degradation_reason="evaluator_abort",
            )
            yield OrchestratorEvent(
                kind="response_final",
                payload={"final": _final_to_dict(apology),
                         "abort_reason": evaluation.rationale},
            )
            return

        if evaluation.verdict == EvalVerdict.RETRY and allow_replan and self.max_replans > 0:
            yield OrchestratorEvent(
                kind="replan_started",
                payload={"reason": evaluation.rationale,
                          "replan_index": 1},
            )
            # Augment recent_messages with the eval feedback so the
            # planner sees what went wrong on the first attempt.
            replan_msgs = list(recent_messages or [])
            replan_msgs.append({
                "role": "system",
                "content": (
                    f"Previous plan was rejected by the evaluator. "
                    f"Verdict: {evaluation.verdict.value}. "
                    f"Reason: {evaluation.rationale}. "
                    "Try a different approach."
                ),
            })
            replan_or_err = await self.planner.plan(
                user_query=user_query or plan.user_query, ctx=self.ctx,
                recent_messages=replan_msgs,
            )
            if isinstance(replan_or_err, PlannerError):
                # Stick with the first draft — better than nothing.
                yield OrchestratorEvent(
                    kind="error",
                    payload={"phase": "replan", **replan_or_err.to_dict()},
                )
                yield OrchestratorEvent(
                    kind="response_final",
                    payload={"final": _final_to_dict(draft)},
                )
                return

            plan2 = replan_or_err
            yield OrchestratorEvent(
                kind="plan_emitted",
                payload={
                    "plan_id": str(plan2.plan_id),
                    "rationale": plan2.rationale,
                    "is_replan": True,
                    "steps": [
                        {"step_id": str(s.step_id), "tool": s.tool, "args": s.args}
                        for s in plan2.steps
                    ],
                },
            )
            execution2 = await self._execute_with_events(plan2)
            async for ev in execution2["events"]:
                yield ev
            result2: ExecutionResult = execution2["result"]
            draft2 = render_response(plan=plan2, execution=result2)
            yield OrchestratorEvent(
                kind="response_final",
                payload={"final": _final_to_dict(draft2),
                          "replanned": True},
            )
            return

        # PASS path — or RETRY with allow_replan=False — ship the draft.
        yield OrchestratorEvent(
            kind="response_final",
            payload={"final": _final_to_dict(draft)},
        )

    # ---- Internal helpers ----

    async def _execute_with_events(self, plan: Plan) -> dict[str, Any]:
        """Wrap executor.run so callers can consume tool_call_started
        / tool_call_finished events. We can't intercept the inner loop
        without changing Executor, so we observe the result and emit
        synthetic events from it. This is fine because:
          - The scratchpad already records the LIVE per-step trace.
          - The events here are for FE animation, not durability.

        For the live-streaming path (Phase 1.1), Executor will grow a
        callback hook and this method will pass it through.
        """
        executor = Executor(
            registry=self.registry, budget=self.budget,
            ctx=self.ctx, scratchpad=self.scratchpad,
        )
        result = await executor.run(plan)
        events = self._synthesize_step_events(plan, result)
        return {"result": result, "events": _async_iter(events)}

    def _synthesize_step_events(
        self, plan: Plan, result: ExecutionResult,
    ) -> list[OrchestratorEvent]:
        out: list[OrchestratorEvent] = []
        for step in plan.steps:
            tool_result = result.tool_results.get(step.step_id)
            if tool_result is None:
                continue
            out.append(OrchestratorEvent(
                kind="tool_call_started",
                payload={
                    "step_id": str(step.step_id), "tool": step.tool,
                    "args": step.args,
                },
            ))
            out.append(OrchestratorEvent(
                kind="tool_call_finished",
                payload={
                    "step_id": str(step.step_id), "tool": step.tool,
                    "ok": tool_result.ok,
                    "error": tool_result.error,
                    "duration_ms": tool_result.duration_ms,
                    "cost_usd": tool_result.cost_usd,
                    "citation_count": len(tool_result.citations),
                },
            ))
        return out


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _async_iter(items: list[OrchestratorEvent]) -> AsyncIterator[OrchestratorEvent]:
    """Adapt a sync list to an async iterator so the run_stream loop
    can ``async for`` over either source uniformly."""
    for it in items:
        yield it


def _final_to_dict(f: FinalResponse) -> dict[str, Any]:
    """Compact dict — what the SSE wire format carries. Pydantic's
    model_dump returns nested objects; we hand-roll for tight control
    over what goes over the wire."""
    return {
        "plan_id": str(f.plan_id),
        "text": f.text,
        "citations": [c.model_dump() for c in f.citations],
        "suggested_actions": [a.model_dump() for a in f.suggested_actions],
        "charts": [ch.model_dump() for ch in f.charts],
        "degraded": f.degraded,
        "degradation_reason": f.degradation_reason,
    }


def _bundle_from_events(events: list[OrchestratorEvent]) -> ConversationResult:
    """Reconstruct a ConversationResult from the event stream the
    non-streaming run() collected. Used for tests / non-SSE callers.
    """
    final_payload: Optional[dict[str, Any]] = None
    aborted = False
    abort_reason: Optional[str] = None
    replanned = False

    for ev in events:
        if ev.kind == "response_final":
            final_payload = ev.payload.get("final")
            replanned = bool(ev.payload.get("replanned"))
            abort_reason = ev.payload.get("abort_reason")
            aborted = bool(abort_reason)
        elif ev.kind == "error" and final_payload is None:
            # A planning error never produces a draft; the next
            # response_final is the apology.
            pass

    # Reify FinalResponse so the typed callers don't have to re-parse.
    if final_payload is None:
        # Should not happen — every path emits a response_final or error.
        # Synthesize a defensive default rather than raising.
        final = FinalResponse(
            plan_id=uuid4(), text="(no response generated)",
            degraded=True, degradation_reason="orchestrator_no_final_event",
        )
    else:
        final = FinalResponse(
            plan_id=UUID(final_payload["plan_id"]),
            text=final_payload["text"],
            degraded=bool(final_payload.get("degraded")),
            degradation_reason=final_payload.get("degradation_reason"),
        )
    return ConversationResult(
        final=final, replanned=replanned,
        aborted=aborted, abort_reason=abort_reason,
    )
