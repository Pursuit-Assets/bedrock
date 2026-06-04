"""Pydantic models for ``manifest.yaml`` (tool) and ``workflow.yaml``
(workflow). One schema, one source of truth; load + validate happens in
``autoload``.

Trimmed to fields with live consumers. Phase-A speculation (eval_fixtures,
lint_overrides, scope, requires_permission, output_kind, VariableCost)
removed; add back when there's a real reader.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


# ---------------------------------------------------------------------------
# Tool manifest
# ---------------------------------------------------------------------------

class ToolManifest(BaseModel):
    """Declarative half of a Chisel tool. The Python half is
    ``handler.py``'s Pydantic input model + ``async def run``."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, pattern=r"^[a-z][a-z0-9_]*$")
    description: str = Field(min_length=1)
    version: str = Field(default="1.0.0", pattern=r"^\d+\.\d+\.\d+$")
    tags: tuple[str, ...] = ()

    requires_human: bool = False
    cost_estimate_usd: float = Field(default=0.0, ge=0.0)


# ---------------------------------------------------------------------------
# Workflow manifest
# ---------------------------------------------------------------------------

class WorkflowStep(BaseModel):
    """One step in a declarative workflow. Used only when
    ``has_custom_plan=False``."""
    model_config = ConfigDict(extra="forbid")
    tool: str = Field(min_length=1)
    args: dict = Field(default_factory=dict)
    success_criteria: str = ""


class WorkflowManifest(BaseModel):
    """``workflow.yaml``. ``dispatch_intent`` is auto-derived as
    ``workflow_<name>`` if omitted — convention every workflow has used."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, pattern=r"^[a-z][a-z0-9_]*$")
    description: str = Field(min_length=1)
    version: str = Field(default="1.0.0", pattern=r"^\d+\.\d+\.\d+$")

    slash_command: Optional[str] = Field(
        default=None,
        pattern=r"^/[a-z][a-z0-9_-]*$",
    )
    dispatch_intent: Optional[str] = None

    steps: tuple[WorkflowStep, ...] = ()
    has_custom_plan: bool = False

    cost_estimate_usd: float = Field(default=0.0, ge=0.0)

    @model_validator(mode="after")
    def _normalize(self) -> "WorkflowManifest":
        if not self.has_custom_plan and not self.steps:
            raise ValueError(
                "WorkflowManifest must declare steps[] or set has_custom_plan=true",
            )
        if not self.dispatch_intent:
            # Auto-fill: convention every workflow uses.
            object.__setattr__(self, "dispatch_intent", f"workflow_{self.name}")
        return self
