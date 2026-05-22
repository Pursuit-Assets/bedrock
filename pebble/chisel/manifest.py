"""Pydantic models for ``manifest.yaml`` (tool) and ``workflow.yaml``
(workflow). One schema, one source of truth; load + validate happens in
``autoload``.

Shape locked by ``tasks/pebble-chisel-plan.md §3``. Highlights:

  * ``cost_estimate`` is either fixed (``{fixed: 0.001}``) or variable
    (``{variable: {max: 0.50}}``); v1 collapses to a single float internally
    but the YAML shape leaves room (P8).
  * ``output_kind`` discriminates renderer behaviour so tools without a
    per-tool renderer (``generate_chart``, ``request_human_review``) don't
    need to ship a render template (P7).
  * ``scope`` defaults to ``global``; org-scoped manifests are reserved for
    v1.1 but the field is in the schema today (P9).
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


# ---------------------------------------------------------------------------
# Cost — fixed | variable
# ---------------------------------------------------------------------------

class FixedCost(BaseModel):
    """``cost_estimate: {fixed: 0.001}`` — single per-call number."""
    model_config = ConfigDict(extra="forbid")
    fixed: float = Field(ge=0.0)


class VariableCost(BaseModel):
    """``cost_estimate: {variable: {max: 0.50}}`` — LLM-driven tools."""
    model_config = ConfigDict(extra="forbid")

    class _Variable(BaseModel):
        model_config = ConfigDict(extra="forbid")
        max: float = Field(ge=0.0)

    variable: _Variable


CostEstimate = FixedCost | VariableCost


def cost_estimate_to_float(cost: CostEstimate) -> float:
    """Collapse to the single-float shape the planner's budget pre-flight
    consumes. v1 uses the cap for the variable case."""
    if isinstance(cost, FixedCost):
        return cost.fixed
    return cost.variable.max


# ---------------------------------------------------------------------------
# Tool manifest
# ---------------------------------------------------------------------------

OutputKind = Literal["prose", "chart", "checkpoint", "none"]
Scope = Literal["global", "org"]


class ToolManifest(BaseModel):
    """The declarative half of a Chisel tool. The Python half is
    ``handler.py``'s Pydantic input model + ``async def run``."""

    model_config = ConfigDict(extra="forbid")

    # Identity
    name: str = Field(min_length=1, pattern=r"^[a-z][a-z0-9_]*$")
    description: str = Field(min_length=1)
    version: str = Field(default="1.0.0", pattern=r"^\d+\.\d+\.\d+$")
    tags: tuple[str, ...] = ()

    # Behaviour
    requires_human: bool = False
    requires_permission: Optional[str] = Field(
        default=None,
        description="Sprint-12 RBAC permission name (snake_case, e.g. 'chisel_write').",
    )
    cost_estimate: CostEstimate = FixedCost(fixed=0.0)
    output_kind: OutputKind = "prose"
    scope: Scope = "global"

    # Phase-B forward-compat: path inside the tool dir to canonical queries.
    eval_fixtures: Optional[str] = None

    # Lint overrides — per-tool escape hatches if a check fires false-positive.
    lint_overrides: tuple[str, ...] = ()


# ---------------------------------------------------------------------------
# Workflow manifest
# ---------------------------------------------------------------------------

class WorkflowStep(BaseModel):
    """One step in a declaratively-authored workflow."""
    model_config = ConfigDict(extra="forbid")
    tool: str = Field(min_length=1)
    args: dict = Field(default_factory=dict)
    success_criteria: str = ""


class WorkflowManifest(BaseModel):
    """``workflow.yaml`` — declarative form. Engineers can drop a
    ``build_plan.py`` alongside for advanced cases that don't fit the
    declarative shape; ``has_custom_plan`` flags those for the GUI."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, pattern=r"^[a-z][a-z0-9_]*$")
    description: str = Field(min_length=1)
    version: str = Field(default="1.0.0", pattern=r"^\d+\.\d+\.\d+$")

    # Slash command + planner intent the dispatcher matches on.
    slash_command: Optional[str] = Field(
        default=None,
        pattern=r"^/[a-z][a-z0-9_-]*$",
    )
    dispatch_intent: Optional[str] = None

    # Declarative form (used if has_custom_plan is False).
    steps: tuple[WorkflowStep, ...] = ()

    # Engineer escape hatch: build_plan.py beside workflow.yaml.
    has_custom_plan: bool = False

    requires_permission: Optional[str] = None
    cost_estimate: CostEstimate = FixedCost(fixed=0.0)
    scope: Scope = "global"

    @model_validator(mode="after")
    def _shape_required(self) -> "WorkflowManifest":
        if not self.has_custom_plan and not self.steps:
            raise ValueError(
                "WorkflowManifest must declare steps[] or set has_custom_plan=true",
            )
        return self
