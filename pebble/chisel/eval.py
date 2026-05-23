"""Chisel eval harness — canonical queries → expected plans → expected prose.

Each tool / workflow may ship a ``canonical_queries.yaml`` next to its
manifest. The eval runner loads all of them, runs each query through
the planner (and optionally the full pipeline), and reports per-query
pass/fail against the expectations.

Plan-level assertions are cheap and deterministic-ish:
  * The planner is called with ``temperature=0`` (verified at
    ``planner.py``); plan-shape expectations are stable.
  * ``expected_plan[]`` is an ordered list of ``ExpectedStep`` entries
    matched against ``plan.steps`` in order.

Prose-level assertions need the full pipeline (executor + renderer)
and therefore live behind a gated CI job — ``chisel eval`` only runs
them when ``--with-prose`` is passed AND a real DB / HTTP client is
wired in. Substring includes/excludes per plan §11.6 (deliberately no
regex).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from pebble.orchestrator.planner import Planner, PlannerError
from pebble.orchestrator.schemas import Plan
from pebble.orchestrator.tools import ToolContext


# ---------------------------------------------------------------------------
# canonical_queries.yaml schema
# ---------------------------------------------------------------------------

class ExpectedStep(BaseModel):
    """One expected step in the planner's output. ``args_includes``
    asserts each (key, value) pair is present in the actual step's
    args (subset match). ``args_excludes`` asserts the listed keys are
    NOT in the actual args."""
    model_config = ConfigDict(extra="forbid")

    tool: str = Field(min_length=1)
    args_includes: dict[str, Any] = Field(default_factory=dict)
    args_excludes: tuple[str, ...] = ()


class ExpectedProse(BaseModel):
    """Substring assertions on the rendered final-response text."""
    model_config = ConfigDict(extra="forbid")

    includes: tuple[str, ...] = ()
    excludes: tuple[str, ...] = ()


class CanonicalQuery(BaseModel):
    """One canonical query — the user prompt + expectations."""
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, pattern=r"^[a-z][a-z0-9_]*$")
    user_query: str = Field(min_length=1)
    expected_plan: tuple[ExpectedStep, ...] = ()
    expected_prose: Optional[ExpectedProse] = None
    tags: tuple[str, ...] = ()
    skip_reason: Optional[str] = None


class CanonicalQueriesFile(BaseModel):
    """Top-level shape of ``canonical_queries.yaml``."""
    model_config = ConfigDict(extra="forbid")

    queries: tuple[CanonicalQuery, ...]


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class LoadedQuery:
    """A canonical query plus the path it was loaded from (for error
    messages and diff output)."""
    source: Path
    unit: str  # tool or workflow name
    query: CanonicalQuery


def load_canonical_queries(chisel_root: Optional[Path] = None) -> list[LoadedQuery]:
    """Walk ``pebble/chisel/{tools,workflows}/*/canonical_queries.yaml``
    and return every query with its source path."""
    if chisel_root is None:
        chisel_root = Path(__file__).parent

    out: list[LoadedQuery] = []
    for sub in ("tools", "workflows"):
        root = chisel_root / sub
        if not root.is_dir():
            continue
        for unit_dir in sorted(p for p in root.iterdir() if p.is_dir()):
            f = unit_dir / "canonical_queries.yaml"
            if not f.is_file():
                continue
            raw = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
            try:
                parsed = CanonicalQueriesFile(**raw)
            except ValidationError as e:
                raise ValueError(
                    f"{f}: invalid canonical_queries.yaml: {e.errors()}",
                ) from e
            for q in parsed.queries:
                out.append(LoadedQuery(source=f, unit=unit_dir.name, query=q))
    return out


# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------

def assert_plan(actual: Plan, expected: tuple[ExpectedStep, ...]) -> list[str]:
    """Compare ``actual.steps`` against ``expected``. Returns a list
    of mismatch messages; empty list = pass.

    Step ordering is checked positionally. Extra steps after the
    expected suffix are tolerated only if the expected list is empty
    (no expectations = no plan-shape checks)."""
    if not expected:
        return []

    failures: list[str] = []
    if len(actual.steps) < len(expected):
        failures.append(
            f"step_count: expected at least {len(expected)} steps, "
            f"got {len(actual.steps)} ({[s.tool for s in actual.steps]})",
        )
        return failures

    for idx, exp in enumerate(expected):
        act = actual.steps[idx]
        if act.tool != exp.tool:
            failures.append(
                f"step[{idx}].tool: expected {exp.tool!r}, got {act.tool!r}",
            )
            continue
        for k, v in exp.args_includes.items():
            if k not in act.args:
                failures.append(
                    f"step[{idx}].args: missing key {k!r}",
                )
            elif act.args[k] != v:
                failures.append(
                    f"step[{idx}].args[{k!r}]: expected {v!r}, got {act.args[k]!r}",
                )
        for k in exp.args_excludes:
            if k in act.args:
                failures.append(
                    f"step[{idx}].args: forbidden key {k!r} present "
                    f"(value={act.args[k]!r})",
                )
    return failures


def assert_prose(text: str, expected: ExpectedProse) -> list[str]:
    """Substring checks (case-sensitive). Plan §11.6: deliberately NOT
    regex — too easy to write fragile assertions."""
    failures: list[str] = []
    for needle in expected.includes:
        if needle not in text:
            failures.append(f"prose.includes: missing substring {needle!r}")
    for needle in expected.excludes:
        if needle in text:
            failures.append(f"prose.excludes: forbidden substring {needle!r} present")
    return failures


# ---------------------------------------------------------------------------
# Eval runner
# ---------------------------------------------------------------------------

@dataclass
class EvalResult:
    query_id: str
    unit: str
    source: Path
    passed: bool
    plan_failures: list[str] = field(default_factory=list)
    prose_failures: list[str] = field(default_factory=list)
    planner_error: Optional[str] = None
    duration_ms: int = 0
    skipped: bool = False
    skip_reason: Optional[str] = None


async def run_plan_eval(
    loaded: LoadedQuery,
    *,
    planner: Planner,
    ctx: ToolContext,
) -> EvalResult:
    """Run one canonical query through the planner only. Cheap path —
    no executor / renderer. Verifies the plan shape matches expectation.
    """
    q = loaded.query
    started = time.perf_counter()

    if q.skip_reason:
        return EvalResult(
            query_id=q.id, unit=loaded.unit, source=loaded.source,
            passed=True, skipped=True, skip_reason=q.skip_reason,
        )

    plan_or_err = await planner.plan(user_query=q.user_query, ctx=ctx)
    duration_ms = int((time.perf_counter() - started) * 1000)

    if isinstance(plan_or_err, PlannerError):
        return EvalResult(
            query_id=q.id, unit=loaded.unit, source=loaded.source,
            passed=False, planner_error=f"{plan_or_err.reason}: {plan_or_err.detail}",
            duration_ms=duration_ms,
        )

    failures = assert_plan(plan_or_err, q.expected_plan)
    return EvalResult(
        query_id=q.id, unit=loaded.unit, source=loaded.source,
        passed=not failures, plan_failures=failures, duration_ms=duration_ms,
    )


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def format_results(results: list[EvalResult]) -> str:
    """Human-readable summary for the CLI / CI log."""
    passed = sum(1 for r in results if r.passed and not r.skipped)
    failed = sum(1 for r in results if not r.passed)
    skipped = sum(1 for r in results if r.skipped)
    total = len(results)
    lines = [f"chisel eval — {passed}/{total} passed ({failed} failed, {skipped} skipped)"]
    for r in results:
        if r.skipped:
            lines.append(f"  SKIP {r.unit}/{r.query_id} — {r.skip_reason}")
        elif r.passed:
            lines.append(f"  PASS {r.unit}/{r.query_id} ({r.duration_ms}ms)")
        else:
            lines.append(f"  FAIL {r.unit}/{r.query_id} ({r.duration_ms}ms)")
            if r.planner_error:
                lines.append(f"       planner_error: {r.planner_error}")
            for f in r.plan_failures:
                lines.append(f"       plan: {f}")
            for f in r.prose_failures:
                lines.append(f"       prose: {f}")
    return "\n".join(lines)
