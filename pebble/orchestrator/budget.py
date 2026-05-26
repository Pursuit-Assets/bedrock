"""Bounded-autonomy guard for the Pebble chat orchestrator.

Enforces three caps per conversation:
  1. tool calls (default 20)
  2. cost in USD (default $0.50)
  3. wall-clock seconds (default 60)

The executor calls ``Budget.check()`` BEFORE every tool invocation
and ``Budget.charge()`` AFTER. Exhaustion is a HARD STOP — the
orchestrator emits a final ``error`` step, returns a degraded
response noting how many of the planned steps completed, and the
user sees the partial answer.

The pattern is opposite to "best-effort budget tracking" where you
quietly drift past the cap. JP's Session-2 architecture pattern from
the Claude Certified Architect curriculum specifies HARD bounds; the
agent should never quietly exceed them.

Layered with the per-user-day cost cap in
``routes/pebble_proxy.py:_DAILY_COST_LIMIT_USD`` — the conversation
budget is the inner cap, the daily cap is the outer.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Optional


# Defaults are overridable per-instance + via env for ops tuning.
DEFAULT_MAX_TOOL_CALLS = int(os.getenv("PEBBLE_BUDGET_MAX_TOOL_CALLS", "20"))
DEFAULT_MAX_COST_USD = float(os.getenv("PEBBLE_BUDGET_MAX_COST_USD", "0.50"))
DEFAULT_MAX_WALL_SECONDS = float(os.getenv("PEBBLE_BUDGET_MAX_WALL_SECONDS", "60.0"))


@dataclass
class Budget:
    """Per-conversation autonomy cap. NOT thread-safe; one instance
    per active conversation. The orchestrator owns the lifetime and
    discards the instance once the conversation ends.
    """
    max_tool_calls: int = DEFAULT_MAX_TOOL_CALLS
    max_cost_usd: float = DEFAULT_MAX_COST_USD
    max_wall_seconds: float = DEFAULT_MAX_WALL_SECONDS

    spent_tool_calls: int = 0
    spent_cost_usd: float = 0.0
    started_at_monotonic: float = field(default_factory=time.monotonic)

    def remaining(self) -> dict[str, float | int]:
        """Snapshot of remaining headroom. Returned to the renderer
        so a degraded response can say 'I had room for X more calls'.
        """
        return {
            "tool_calls": max(0, self.max_tool_calls - self.spent_tool_calls),
            "cost_usd": max(0.0, self.max_cost_usd - self.spent_cost_usd),
            "wall_seconds": max(
                0.0, self.max_wall_seconds - self.elapsed_seconds(),
            ),
        }

    def elapsed_seconds(self) -> float:
        return time.monotonic() - self.started_at_monotonic

    def check(self) -> Optional[str]:
        """Pre-flight check. Returns None if the next tool call may
        proceed; returns a halt-reason string otherwise.

        Halt reason format mirrors the SSE event schema so the
        frontend's degraded-mode banner can render directly.
        """
        if self.spent_tool_calls >= self.max_tool_calls:
            return (
                f"tool_call_budget_exhausted: spent {self.spent_tool_calls} "
                f"of {self.max_tool_calls}"
            )
        if self.spent_cost_usd >= self.max_cost_usd:
            return (
                f"cost_budget_exhausted: spent ${self.spent_cost_usd:.4f} "
                f"of ${self.max_cost_usd:.4f}"
            )
        if self.elapsed_seconds() >= self.max_wall_seconds:
            return (
                f"wall_clock_budget_exhausted: elapsed "
                f"{self.elapsed_seconds():.1f}s of {self.max_wall_seconds:.1f}s"
            )
        return None

    def can_afford(self, *, calls: int = 1, cost_usd: float = 0.0) -> Optional[str]:
        """Pre-flight check for a step that we KNOW will charge a
        specific amount. Returns the halt-reason if the upcoming
        charge would exceed, else None.

        Use case: planner returns a Plan with estimated_tool_calls
        and estimated_cost_usd. Executor calls
        ``budget.can_afford(calls=plan.estimated_tool_calls,
        cost_usd=plan.estimated_cost_usd)`` before starting; if it
        won't fit, refuse before spending anything.
        """
        if self.spent_tool_calls + calls > self.max_tool_calls:
            return (
                f"plan_exceeds_tool_call_budget: would need "
                f"{self.spent_tool_calls + calls}, max {self.max_tool_calls}"
            )
        if self.spent_cost_usd + cost_usd > self.max_cost_usd:
            return (
                f"plan_exceeds_cost_budget: would need "
                f"${self.spent_cost_usd + cost_usd:.4f}, "
                f"max ${self.max_cost_usd:.4f}"
            )
        return None

    def charge(self, *, calls: int = 0, cost_usd: float = 0.0) -> None:
        """Record consumption after a step completes. Executor
        increments after successful + failed tool calls (failures
        still cost something).
        """
        if calls < 0 or cost_usd < 0:
            raise ValueError(
                "Budget.charge args must be non-negative — failed steps "
                "still cost; use 0 for free tools, never negative.",
            )
        self.spent_tool_calls += calls
        self.spent_cost_usd += cost_usd

    def to_dict(self) -> dict[str, float | int]:
        """Snapshot for the scratchpad payload column."""
        return {
            "max_tool_calls": self.max_tool_calls,
            "max_cost_usd": self.max_cost_usd,
            "max_wall_seconds": self.max_wall_seconds,
            "spent_tool_calls": self.spent_tool_calls,
            "spent_cost_usd": self.spent_cost_usd,
            "elapsed_seconds": round(self.elapsed_seconds(), 3),
            **self.remaining(),
        }
