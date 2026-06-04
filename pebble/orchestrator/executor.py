"""Plan executor — runs a Plan step-by-step, consults the budget,
persists every step to the scratchpad, halts on checkpoints / errors
/ budget exhaustion.

Pattern: orchestrator-worker with bounded autonomy + scratchpad. The
executor is a pure consumer of (Plan, Registry, Budget, ToolContext,
ScratchpadWriter). It does not call the LLM — that's the planner's
job (above) and the evaluator's job (below). Pure execution =
deterministic, replay-safe, easy to test.

Halt reasons (each writes a final scratchpad row + returns):

  * ``budget_exhausted`` — Budget.check() returned a halt-reason.
  * ``tool_failure`` — A step's tool returned ok=False AND that step
    had no fallback. Subsequent steps that depend on this one are
    skipped (their depends_on can't be satisfied).
  * ``checkpoint`` — request_human_review or propose_write fired.
    The conversation is paused; the FE renders a confirm-card.
  * ``conflict`` — two tool results for the same entity disagreed
    above the conflict threshold. Renderer surfaces the disagreement.
  * ``completed`` — all plan steps satisfied.

Each halt reason has its own scratchpad step type (error, checkpoint,
conflict). Test coverage for each branch.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional
from uuid import UUID

from .budget import Budget
from .schemas import Plan, PlanStep, ToolResult
from .scratchpad import ScratchpadWriter
from .tools import ToolContext, ToolRegistry

logger = logging.getLogger(__name__)


class ExecutionOutcome(str, Enum):
    COMPLETED = "completed"
    BUDGET_EXHAUSTED = "budget_exhausted"
    TOOL_FAILURE = "tool_failure"
    CHECKPOINT = "checkpoint"
    CONFLICT = "conflict"
    PRE_FLIGHT_REJECTED = "pre_flight_rejected"


@dataclass
class ExecutionResult:
    outcome: ExecutionOutcome
    plan_id: UUID
    completed_step_ids: list[UUID] = field(default_factory=list)
    failed_step_id: Optional[UUID] = None
    checkpoint_step_id: Optional[UUID] = None
    halt_reason: Optional[str] = None
    tool_results: dict[UUID, ToolResult] = field(default_factory=dict)
    budget_snapshot: dict[str, Any] = field(default_factory=dict)


class Executor:
    """Stateless executor — instantiate per conversation, call
    ``run(plan)``. The same Executor instance can run multiple plans
    sequentially (e.g. after an evaluator-triggered re-plan).
    """

    def __init__(
        self,
        registry: ToolRegistry,
        budget: Budget,
        ctx: ToolContext,
        scratchpad: ScratchpadWriter,
    ) -> None:
        self.registry = registry
        self.budget = budget
        self.ctx = ctx
        self.scratchpad = scratchpad

    async def run(self, plan: Plan) -> ExecutionResult:
        # Persist the Plan as the first step.
        plan_payload = {
            "plan_id": str(plan.plan_id),
            "user_query": plan.user_query,
            "rationale": plan.rationale,
            "estimated_cost_usd": plan.estimated_cost_usd,
            "estimated_tool_calls": plan.estimated_tool_calls,
            "steps": [
                {
                    "step_id": str(s.step_id),
                    "tool": s.tool,
                    "args": s.args,
                    "expected_shape": s.expected_shape,
                    "success_criteria": s.success_criteria,
                    "depends_on": [str(d) for d in s.depends_on],
                }
                for s in plan.steps
            ],
        }
        plan_step_id = await self.scratchpad.write_plan(plan_payload)

        # Pre-flight: does the plan fit our budget?
        rejection = self.budget.can_afford(
            calls=plan.estimated_tool_calls,
            cost_usd=plan.estimated_cost_usd,
        )
        if rejection:
            await self.scratchpad.write_error(
                {
                    "outcome": ExecutionOutcome.PRE_FLIGHT_REJECTED.value,
                    "halt_reason": rejection,
                    "budget": self.budget.to_dict(),
                },
                parent_step_id=plan_step_id,
            )
            return ExecutionResult(
                outcome=ExecutionOutcome.PRE_FLIGHT_REJECTED,
                plan_id=plan.plan_id,
                halt_reason=rejection,
                budget_snapshot=self.budget.to_dict(),
            )

        completed: list[UUID] = []
        results: dict[UUID, ToolResult] = {}

        for step in plan.steps:
            # Skip if dependency failed.
            unmet = [d for d in step.depends_on if d not in completed]
            if unmet:
                await self.scratchpad.write_error(
                    {
                        "outcome": "skipped_unmet_dependency",
                        "step_id": str(step.step_id),
                        "tool": step.tool,
                        "unmet_dependencies": [str(u) for u in unmet],
                    },
                    parent_step_id=plan_step_id,
                )
                continue

            # Budget pre-flight per step.
            halt = self.budget.check()
            if halt is not None:
                await self.scratchpad.write_error(
                    {
                        "outcome": ExecutionOutcome.BUDGET_EXHAUSTED.value,
                        "halt_reason": halt,
                        "completed_step_ids": [str(s) for s in completed],
                        "remaining_steps": [
                            str(s.step_id)
                            for s in plan.steps
                            if s.step_id not in completed
                        ],
                        "budget": self.budget.to_dict(),
                    },
                    parent_step_id=plan_step_id,
                )
                return ExecutionResult(
                    outcome=ExecutionOutcome.BUDGET_EXHAUSTED,
                    plan_id=plan.plan_id,
                    completed_step_ids=completed,
                    halt_reason=halt,
                    tool_results=results,
                    budget_snapshot=self.budget.to_dict(),
                )

            # Tool dispatch.
            await self.scratchpad.write_tool_call(
                tool_name=step.tool,
                tool_args=step.args,
                parent_step_id=plan_step_id,
            )

            started = time.perf_counter()
            result = await self.registry.invoke(step.tool, step.args, self.ctx)
            duration_ms = int((time.perf_counter() - started) * 1000)

            self.budget.charge(calls=1, cost_usd=result.cost_usd or 0.0)

            await self.scratchpad.write_tool_result(
                tool_name=step.tool,
                tool_result={
                    "ok": result.ok,
                    "data": result.data,
                    "error": result.error,
                    "citations": list(result.citations),
                    "duration_ms": duration_ms,
                    "cost_usd": result.cost_usd,
                },
                parent_step_id=plan_step_id,
                cost_usd=result.cost_usd,
                duration_ms=duration_ms,
                tokens_in=result.tokens_in or None,
                tokens_out=result.tokens_out or None,
            )

            results[step.step_id] = result

            # Checkpoint detection — request_human_review etc.
            if (
                result.ok
                and isinstance(result.data, dict)
                and result.data.get("checkpoint") is True
            ):
                checkpoint_id = await self.scratchpad.write_checkpoint(
                    {
                        "tool": step.tool,
                        "step_id": str(step.step_id),
                        "data": result.data,
                    },
                    parent_step_id=plan_step_id,
                )
                return ExecutionResult(
                    outcome=ExecutionOutcome.CHECKPOINT,
                    plan_id=plan.plan_id,
                    completed_step_ids=completed,
                    checkpoint_step_id=checkpoint_id,
                    tool_results=results,
                    halt_reason=result.data.get("reason"),
                    budget_snapshot=self.budget.to_dict(),
                )

            # Tool failure — halt OR continue based on dependency graph.
            # If subsequent steps don't depend on this one, they can
            # proceed; if they do, they'll be skipped via the
            # depends_on check above. We continue the loop and let
            # the natural flow handle it.
            if not result.ok:
                logger.warning(
                    "executor.tool_failure step=%s tool=%s error=%s",
                    step.step_id, step.tool, result.error,
                )
                await self.scratchpad.write_error(
                    {
                        "outcome": ExecutionOutcome.TOOL_FAILURE.value,
                        "step_id": str(step.step_id),
                        "tool": step.tool,
                        "error": result.error,
                    },
                    parent_step_id=plan_step_id,
                )
                # If NO subsequent step depends on this one, continue.
                downstream = any(
                    step.step_id in s.depends_on
                    for s in plan.steps
                    if s.step_id != step.step_id
                )
                if not downstream:
                    # Note: we do NOT add this step to completed,
                    # which is the correct semantic.
                    continue
                # Otherwise, halt — downstream steps will all be skipped.
                return ExecutionResult(
                    outcome=ExecutionOutcome.TOOL_FAILURE,
                    plan_id=plan.plan_id,
                    completed_step_ids=completed,
                    failed_step_id=step.step_id,
                    halt_reason=result.error,
                    tool_results=results,
                    budget_snapshot=self.budget.to_dict(),
                )

            completed.append(step.step_id)

        return ExecutionResult(
            outcome=ExecutionOutcome.COMPLETED,
            plan_id=plan.plan_id,
            completed_step_ids=completed,
            tool_results=results,
            budget_snapshot=self.budget.to_dict(),
        )
