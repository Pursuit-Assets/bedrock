"""Pydantic models for the Pebble chat orchestrator.

The shapes here are the agent's DURABLE contract — what gets persisted
to ``bedrock.pebble_chat_scratchpad``, what the planner emits, what
the executor consumes. Tests assert against these. Frontend types
mirror the Plan / PlanStep shapes 1:1 so the agent's plan view
renders without translation.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StepType(str, Enum):
    PLAN = "plan"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    EVALUATION = "evaluation"
    RENDER = "render"
    CONFLICT = "conflict"
    CHECKPOINT = "checkpoint"
    ERROR = "error"


class EvalVerdict(str, Enum):
    PASS = "pass"
    RETRY = "retry"
    ABORT = "abort"


# ---------------------------------------------------------------------------
# Plan + PlanStep
# ---------------------------------------------------------------------------

class PlanStep(BaseModel):
    """A single step in an agent plan. The planner emits these; the
    executor invokes them in order, respecting depends_on.
    """
    model_config = ConfigDict(frozen=True)

    step_id: UUID = Field(default_factory=uuid4)
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)
    expected_shape: str = ""           # human-readable description
    success_criteria: str = ""         # what makes this step's result useful
    depends_on: tuple[UUID, ...] = ()  # IDs of prior steps that must complete first

    @field_validator("tool")
    @classmethod
    def _tool_not_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("PlanStep.tool must be non-empty")
        return v.strip()


class Plan(BaseModel):
    """The full plan emitted by the planner before any tool executes.

    ``rationale`` is the planner's brief reasoning summary — for
    transparency in the FE plan view. Not load-bearing for execution.

    ``estimated_cost_usd`` and ``estimated_tool_calls`` feed the budget
    pre-flight: if a plan's estimate already exceeds the conversation
    budget, the executor refuses to start and asks the user to narrow.
    """
    model_config = ConfigDict(frozen=True)

    plan_id: UUID = Field(default_factory=uuid4)
    user_query: str
    steps: tuple[PlanStep, ...]
    rationale: str = ""
    estimated_cost_usd: float = 0.0
    estimated_tool_calls: int = 0
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(tz=timezone.utc),
    )

    @field_validator("user_query")
    @classmethod
    def _query_not_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Plan.user_query must be non-empty")
        return v.strip()

    @field_validator("steps")
    @classmethod
    def _steps_consistent(cls, v: tuple[PlanStep, ...]) -> tuple[PlanStep, ...]:
        # depends_on must reference earlier step_ids only.
        seen: set[UUID] = set()
        for step in v:
            for dep in step.depends_on:
                if dep not in seen:
                    raise ValueError(
                        f"PlanStep {step.step_id} depends_on {dep} which is "
                        "not a prior step",
                    )
            seen.add(step.step_id)
        return v


# ---------------------------------------------------------------------------
# Tool calls + results
# ---------------------------------------------------------------------------

class ToolCall(BaseModel):
    """Persisted record of an executor tool invocation."""
    model_config = ConfigDict(frozen=True)

    step_id: UUID
    tool: str
    args: dict[str, Any]
    plan_step_id: Optional[UUID] = None     # which plan step authorized this
    invoked_at: datetime = Field(
        default_factory=lambda: datetime.now(tz=timezone.utc),
    )


class ToolResult(BaseModel):
    """Persisted record of a tool's output. Failure-by-default;
    successful results carry data."""
    model_config = ConfigDict(frozen=True)

    step_id: UUID
    tool: str
    ok: bool
    data: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    duration_ms: int = 0
    cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    citations: tuple[str, ...] = ()         # IDs the renderer can render as <cite>


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

class Evaluation(BaseModel):
    """Output of the evaluator (Haiku-as-judge).

    ``cost_usd`` / ``tokens_in`` / ``tokens_out`` carry the LLM-call
    accounting for the eval pass itself — same shape as
    ``ToolResult``'s cost fields. The chat orchestrator surfaces these
    in the ``eval_emitted`` SSE event so the frontend can render a
    running cost / token tally per conversation.
    """
    model_config = ConfigDict(frozen=True)

    plan_id: UUID
    factuality: float = Field(ge=0.0, le=1.0)
    completeness: float = Field(ge=0.0, le=1.0)
    harm: str = Field(default="none", pattern=r"^(none|mild|severe)$")
    verdict: EvalVerdict
    rationale: str = ""
    rejected_claims: tuple[str, ...] = ()
    cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0


# ---------------------------------------------------------------------------
# Final response shape (what the renderer emits, what the FE consumes)
# ---------------------------------------------------------------------------

class Citation(BaseModel):
    """A citation reference attached to a span of text."""
    model_config = ConfigDict(frozen=True)

    cite_id: str
    entity_type: str        # 'sf_account', 'pebble_profile', 'metric:stale_pipeline', ...
    entity_id: str
    title: str = ""
    href: str = ""


class SuggestedAction(BaseModel):
    """A write the agent proposes; the FE renders as a confirm card.
    User confirmation re-issues the call with their JWT, NOT the
    internal key. Until then the agent has not written anything.
    """
    model_config = ConfigDict(frozen=True)

    action_id: UUID = Field(default_factory=uuid4)
    kind: str               # 'update_stage', 'create_task', 'send_email', ...
    payload: dict[str, Any]
    diff_preview: str       # human-readable "Stage: A → B"
    record_label: str       # "Acme Corp · 006XYZ" for anti-mistake guard
    rationale: str = ""


class ChartSpec(BaseModel):
    """Recharts-shape JSON. The FE uses ``kind`` to pick a component."""
    model_config = ConfigDict(frozen=True)

    chart_id: UUID = Field(default_factory=uuid4)
    kind: str = Field(pattern=r"^(line|bar|pie|area|scatter|funnel)$")
    title: str = ""
    data: list[dict[str, Any]] = Field(default_factory=list)
    x_key: Optional[str] = None
    y_keys: tuple[str, ...] = ()


class FinalResponse(BaseModel):
    """Stitched from the renderer; persisted as the conversation's
    last scratchpad row of step_type=render."""
    model_config = ConfigDict(frozen=True)

    plan_id: UUID
    text: str
    citations: tuple[Citation, ...] = ()
    suggested_actions: tuple[SuggestedAction, ...] = ()
    charts: tuple[ChartSpec, ...] = ()
    degraded: bool = False
    degradation_reason: Optional[str] = None
