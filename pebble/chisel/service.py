"""Service layer for the Chisel HTTP API + GUI.

Read surface (Phase C.1): inventory walk, detail view, YAML validation,
autoload reload, eval wrapper.

Write surface (Phase C.3): atomic manifest saves with path containment +
validate-first invariants. Handler code edits stay out of scope —
``handler.py`` / ``build_plan.py`` changes land through PR review.
"""

from __future__ import annotations

import os
import re
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml
from pydantic import ValidationError

from .autoload import autoload as _autoload_fn
from .eval import (
    EvalResult,
    LoadedQuery,
    format_results,
    load_canonical_queries,
    run_plan_eval,
)
from .manifest import ToolManifest, WorkflowManifest


# ---------------------------------------------------------------------------
# Inventory shapes
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ChiselUnit:
    """Inventory entry for one tool or workflow."""
    kind: str                # "tool" | "workflow"
    name: str
    version: str
    description: str
    tags: tuple[str, ...]
    cost_estimate_usd: float
    requires_human: bool
    manifest_path: str       # absolute path string (JSON-serializable)
    handler_path: Optional[str]    # tools have handler.py; workflows may not
    has_canonical_queries: bool
    # Workflow-only fields
    slash_command: Optional[str] = None
    dispatch_intent: Optional[str] = None
    has_custom_plan: bool = False
    # If autoload failed for this unit, the error message lives here.
    load_error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ChiselDetail:
    """Inventory entry + full manifest YAML + handler source."""
    unit: ChiselUnit
    manifest_yaml: str
    handler_source: Optional[str]
    build_plan_source: Optional[str] = None
    canonical_queries_yaml: Optional[str] = None
    input_schema: Optional[dict[str, Any]] = None  # only populated if successfully loaded

    def to_dict(self) -> dict[str, Any]:
        return {
            "unit": self.unit.to_dict(),
            "manifest_yaml": self.manifest_yaml,
            "handler_source": self.handler_source,
            "build_plan_source": self.build_plan_source,
            "canonical_queries_yaml": self.canonical_queries_yaml,
            "input_schema": self.input_schema,
        }


@dataclass(frozen=True)
class ValidationIssue:
    """One Pydantic validation problem, JSON-serializable for the GUI."""
    location: str            # dotted path like "cost_estimate_usd"
    message: str
    type: str                # pydantic error type, e.g. "value_error"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ServiceHealth:
    """Summary of the most recent autoload pass."""
    loaded_tools: tuple[str, ...]
    loaded_workflows: tuple[str, ...]
    errors: tuple[tuple[str, str], ...]
    lint_warnings: tuple[tuple[str, str], ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "loaded_tools": list(self.loaded_tools),
            "loaded_workflows": list(self.loaded_workflows),
            "errors": [list(e) for e in self.errors],
            "lint_warnings": [list(w) for w in self.lint_warnings],
            "ok": not self.errors,
        }


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------

def chisel_root() -> Path:
    return Path(__file__).parent


def _safe_read(path: Path) -> Optional[str]:
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8")


def _load_error_for(unit_kind: str, name: str) -> Optional[str]:
    """Look up the autoload error (if any) for a unit by name. The
    autoload report stores ``(dir_path, reason)``; we match on dir name."""
    report = _autoload_fn()
    for path, reason in report.errors:
        if Path(path).name == name and unit_kind in path:
            return reason
    return None


def _tool_inventory(tool_dir: Path) -> ChiselUnit:
    manifest_path = tool_dir / "manifest.yaml"
    handler_path = tool_dir / "handler.py"
    canonical_path = tool_dir / "canonical_queries.yaml"

    raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
    try:
        m = ToolManifest(**raw)
        load_error = None
        unit_name = m.name
        version = m.version
        description = m.description
        tags = m.tags
        cost = m.cost_estimate_usd
        requires_human = m.requires_human
    except ValidationError as e:
        load_error = f"manifest invalid: {e.errors()}"
        unit_name = tool_dir.name
        version = "?"
        description = raw.get("description", "")
        tags = tuple(raw.get("tags", []) or [])
        cost = float(raw.get("cost_estimate_usd", 0.0) or 0.0)
        requires_human = bool(raw.get("requires_human", False))

    return ChiselUnit(
        kind="tool",
        name=unit_name,
        version=version,
        description=description,
        tags=tags,
        cost_estimate_usd=cost,
        requires_human=requires_human,
        manifest_path=str(manifest_path),
        handler_path=str(handler_path) if handler_path.is_file() else None,
        has_canonical_queries=canonical_path.is_file(),
        load_error=load_error,
    )


def _workflow_inventory(wf_dir: Path) -> ChiselUnit:
    manifest_path = wf_dir / "workflow.yaml"
    handler_path = wf_dir / "build_plan.py"
    canonical_path = wf_dir / "canonical_queries.yaml"

    raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
    try:
        m = WorkflowManifest(**raw)
        load_error = None
        return ChiselUnit(
            kind="workflow",
            name=m.name,
            version=m.version,
            description=m.description,
            tags=(),
            cost_estimate_usd=m.cost_estimate_usd,
            requires_human=False,
            manifest_path=str(manifest_path),
            handler_path=str(handler_path) if handler_path.is_file() else None,
            has_canonical_queries=canonical_path.is_file(),
            slash_command=m.slash_command,
            dispatch_intent=m.dispatch_intent,
            has_custom_plan=m.has_custom_plan,
            load_error=load_error,
        )
    except ValidationError as e:
        return ChiselUnit(
            kind="workflow",
            name=wf_dir.name,
            version="?",
            description=raw.get("description", ""),
            tags=(),
            cost_estimate_usd=float(raw.get("cost_estimate_usd", 0.0) or 0.0),
            requires_human=False,
            manifest_path=str(manifest_path),
            handler_path=str(handler_path) if handler_path.is_file() else None,
            has_canonical_queries=canonical_path.is_file(),
            slash_command=raw.get("slash_command"),
            dispatch_intent=raw.get("dispatch_intent"),
            has_custom_plan=bool(raw.get("has_custom_plan", False)),
            load_error=f"workflow invalid: {e.errors()}",
        )


def list_units(root: Optional[Path] = None) -> list[ChiselUnit]:
    """Enumerate every chisel unit. Returns even units whose manifests
    fail validation — the GUI shows those with the load_error so an
    author can fix them in place."""
    root = root or chisel_root()
    out: list[ChiselUnit] = []

    tools_root = root / "tools"
    if tools_root.is_dir():
        for d in sorted(p for p in tools_root.iterdir() if p.is_dir()):
            if d.name.startswith(("_", ".")):
                continue
            if not (d / "manifest.yaml").is_file():
                continue
            out.append(_tool_inventory(d))

    wf_root = root / "workflows"
    if wf_root.is_dir():
        for d in sorted(p for p in wf_root.iterdir() if p.is_dir()):
            if d.name.startswith(("_", ".")):
                continue
            if not (d / "workflow.yaml").is_file():
                continue
            out.append(_workflow_inventory(d))

    return out


def _find_unit(kind: str, name: str, root: Optional[Path] = None) -> Optional[ChiselUnit]:
    for u in list_units(root):
        if u.kind == kind and u.name == name:
            return u
    return None


# ---------------------------------------------------------------------------
# Detail view
# ---------------------------------------------------------------------------

def get_tool_detail(name: str, root: Optional[Path] = None) -> Optional[ChiselDetail]:
    unit = _find_unit("tool", name, root)
    if unit is None:
        return None

    manifest_yaml = _safe_read(Path(unit.manifest_path)) or ""
    handler_source = _safe_read(Path(unit.handler_path)) if unit.handler_path else None
    canonical_queries_yaml = _safe_read(Path(unit.manifest_path).parent / "canonical_queries.yaml")

    # Pull the input_schema off DEFAULT_REGISTRY if it loaded successfully.
    input_schema = None
    if unit.load_error is None:
        from pebble.orchestrator.tools import DEFAULT_REGISTRY
        spec = DEFAULT_REGISTRY.get(name)
        if spec is not None:
            input_schema = spec.input_schema

    return ChiselDetail(
        unit=unit,
        manifest_yaml=manifest_yaml,
        handler_source=handler_source,
        canonical_queries_yaml=canonical_queries_yaml,
        input_schema=input_schema,
    )


def get_workflow_detail(name: str, root: Optional[Path] = None) -> Optional[ChiselDetail]:
    unit = _find_unit("workflow", name, root)
    if unit is None:
        return None

    manifest_yaml = _safe_read(Path(unit.manifest_path)) or ""
    build_plan_source = _safe_read(Path(unit.handler_path)) if unit.handler_path else None
    canonical_queries_yaml = _safe_read(Path(unit.manifest_path).parent / "canonical_queries.yaml")

    return ChiselDetail(
        unit=unit,
        manifest_yaml=manifest_yaml,
        handler_source=None,
        build_plan_source=build_plan_source,
        canonical_queries_yaml=canonical_queries_yaml,
    )


# ---------------------------------------------------------------------------
# Validation (GUI's pre-save check)
# ---------------------------------------------------------------------------

def _format_pydantic_errors(e: ValidationError) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    for err in e.errors():
        loc = ".".join(str(p) for p in err.get("loc", ()))
        issues.append(ValidationIssue(
            location=loc,
            message=err.get("msg", "invalid"),
            type=err.get("type", "value_error"),
        ))
    return issues


def validate_tool_manifest_yaml(yaml_text: str) -> list[ValidationIssue]:
    """Validate a tool manifest YAML string. Returns [] on success."""
    try:
        raw = yaml.safe_load(yaml_text) or {}
    except yaml.YAMLError as e:
        return [ValidationIssue(location="", message=f"yaml parse: {e}", type="yaml_error")]
    if not isinstance(raw, dict):
        return [ValidationIssue(location="", message="manifest must be a YAML mapping", type="shape_error")]
    try:
        ToolManifest(**raw)
        return []
    except ValidationError as e:
        return _format_pydantic_errors(e)


def validate_workflow_manifest_yaml(yaml_text: str) -> list[ValidationIssue]:
    """Validate a workflow manifest YAML string. Returns [] on success."""
    try:
        raw = yaml.safe_load(yaml_text) or {}
    except yaml.YAMLError as e:
        return [ValidationIssue(location="", message=f"yaml parse: {e}", type="yaml_error")]
    if not isinstance(raw, dict):
        return [ValidationIssue(location="", message="workflow.yaml must be a YAML mapping", type="shape_error")]
    try:
        WorkflowManifest(**raw)
        return []
    except ValidationError as e:
        return _format_pydantic_errors(e)


# ---------------------------------------------------------------------------
# Reload
# ---------------------------------------------------------------------------

def reload_chisel() -> ServiceHealth:
    """Re-run autoload and return the result as a JSON-serializable
    health summary."""
    report = _autoload_fn()
    return ServiceHealth(
        loaded_tools=tuple(report.loaded_tools),
        loaded_workflows=tuple(report.loaded_workflows),
        errors=tuple((str(p), r) for p, r in report.errors),
        lint_warnings=tuple((str(p), r) for p, r in report.lint_warnings),
    )


def current_health() -> ServiceHealth:
    """Idempotent read of the current registry state — does NOT reload."""
    # autoload() resets the maps, so to keep semantics 'current' we
    # re-run it. Cheap enough for a status endpoint; the GUI can hit
    # this on every page load.
    return reload_chisel()


# ---------------------------------------------------------------------------
# Eval runner — wraps eval.py for the API
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class EvalRunSummary:
    total: int
    passed: int
    failed: int
    skipped: int
    results: tuple[dict[str, Any], ...]
    text_report: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "passed": self.passed,
            "failed": self.failed,
            "skipped": self.skipped,
            "results": list(self.results),
            "text_report": self.text_report,
        }


def _result_to_dict(r: EvalResult) -> dict[str, Any]:
    return {
        "query_id": r.query_id,
        "unit": r.unit,
        "source": str(r.source),
        "passed": r.passed,
        "skipped": r.skipped,
        "skip_reason": r.skip_reason,
        "plan_failures": list(r.plan_failures),
        "prose_failures": list(r.prose_failures),
        "planner_error": r.planner_error,
        "duration_ms": r.duration_ms,
    }


# ---------------------------------------------------------------------------
# Save (Phase C.3) — atomic writes with validate-first + path containment
# ---------------------------------------------------------------------------

class ChiselSaveError(Exception):
    """Raised when a save is refused. Carries an HTTP-friendly status hint
    via ``status_code``."""

    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")


def _safe_unit_dir(kind: str, name: str, root: Optional[Path] = None) -> Path:
    """Resolve the on-disk directory for ``kind/name``, refusing path
    traversal. Used by every write helper."""
    if kind not in ("tools", "workflows"):
        raise ChiselSaveError(f"unknown kind: {kind!r}")
    if not _NAME_PATTERN.match(name):
        raise ChiselSaveError(
            f"name {name!r} must match {_NAME_PATTERN.pattern}",
        )
    root = (root or chisel_root()).resolve()
    target = (root / kind / name).resolve()
    try:
        target.relative_to(root / kind)
    except ValueError as e:
        raise ChiselSaveError(f"path traversal rejected: {target}") from e
    return target


def _atomic_write(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` via tempfile-in-same-dir + os.replace,
    so partial writes can't leave the manifest corrupted."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def _ensure_yaml_name_matches(yaml_text: str, expected_name: str) -> dict:
    """Parse + assert ``name:`` field equals the URL name. Prevents a
    rename smuggled inside the body from clobbering a sibling unit."""
    try:
        raw = yaml.safe_load(yaml_text) or {}
    except yaml.YAMLError as e:
        raise ChiselSaveError(f"yaml parse: {e}") from e
    if not isinstance(raw, dict):
        raise ChiselSaveError("manifest must be a YAML mapping")
    body_name = raw.get("name")
    if body_name != expected_name:
        raise ChiselSaveError(
            f"manifest name {body_name!r} does not match URL name "
            f"{expected_name!r} (rename via PR review, not the GUI)",
            status_code=409,
        )
    return raw


def save_tool_manifest(
    name: str,
    yaml_text: str,
    *,
    root: Optional[Path] = None,
) -> ChiselUnit:
    """Validate + atomically write ``pebble/chisel/tools/<name>/manifest.yaml``
    and trigger a registry reload. Refuses to create new tool dirs —
    handler.py changes go through PR per the v1 scoping decision."""
    unit_dir = _safe_unit_dir("tools", name, root)
    if not unit_dir.is_dir():
        raise ChiselSaveError(
            f"tool {name!r} does not exist; create the handler.py via PR first",
            status_code=404,
        )

    raw = _ensure_yaml_name_matches(yaml_text, name)
    try:
        ToolManifest(**raw)
    except ValidationError as e:
        raise ChiselSaveError(f"manifest invalid: {e.errors()}") from e

    _atomic_write(unit_dir / "manifest.yaml", yaml_text)
    _autoload_fn()  # refresh DEFAULT_REGISTRY so the next request sees the update

    found = _find_unit("tool", name, root)
    if found is None:
        raise ChiselSaveError("saved but inventory walk lost the unit", status_code=500)
    return found


def save_workflow_manifest(
    name: str,
    yaml_text: str,
    *,
    root: Optional[Path] = None,
) -> ChiselUnit:
    """Validate + atomically write ``pebble/chisel/workflows/<name>/workflow.yaml``.
    Refuses if the directory doesn't exist (use ``create_workflow`` for
    declarative-form new workflows)."""
    unit_dir = _safe_unit_dir("workflows", name, root)
    if not unit_dir.is_dir():
        raise ChiselSaveError(
            f"workflow {name!r} does not exist; use create_workflow to create one",
            status_code=404,
        )

    raw = _ensure_yaml_name_matches(yaml_text, name)
    try:
        manifest = WorkflowManifest(**raw)
    except ValidationError as e:
        raise ChiselSaveError(f"workflow invalid: {e.errors()}") from e

    if manifest.has_custom_plan and not (unit_dir / "build_plan.py").is_file():
        raise ChiselSaveError(
            "workflow sets has_custom_plan=true but build_plan.py is "
            "missing (add it via PR before flipping the manifest)",
        )

    _atomic_write(unit_dir / "workflow.yaml", yaml_text)
    _autoload_fn()

    found = _find_unit("workflow", name, root)
    if found is None:
        raise ChiselSaveError("saved but inventory walk lost the unit", status_code=500)
    return found


def create_workflow(
    name: str,
    yaml_text: str,
    *,
    root: Optional[Path] = None,
) -> ChiselUnit:
    """Create a brand-new declarative workflow from scratch. Refuses
    ``has_custom_plan=true`` (that requires a build_plan.py which only
    a PR can land)."""
    unit_dir = _safe_unit_dir("workflows", name, root)
    if unit_dir.exists():
        raise ChiselSaveError(
            f"workflow {name!r} already exists",
            status_code=409,
        )

    raw = _ensure_yaml_name_matches(yaml_text, name)
    try:
        manifest = WorkflowManifest(**raw)
    except ValidationError as e:
        raise ChiselSaveError(f"workflow invalid: {e.errors()}") from e

    if manifest.has_custom_plan:
        raise ChiselSaveError(
            "create_workflow only supports declarative workflows; "
            "for has_custom_plan=true, land the build_plan.py through PR first",
        )

    unit_dir.mkdir(parents=True, exist_ok=False)
    (unit_dir / "__init__.py").write_text("", encoding="utf-8")
    _atomic_write(unit_dir / "workflow.yaml", yaml_text)
    _autoload_fn()

    found = _find_unit("workflow", name, root)
    if found is None:
        raise ChiselSaveError("created but inventory walk lost the unit", status_code=500)
    return found


# ---------------------------------------------------------------------------
# Eval runner — wraps eval.py for the API
# ---------------------------------------------------------------------------

async def run_canonical_eval(
    *,
    unit: Optional[str] = None,
    tag: Optional[str] = None,
    planner: Any = None,
    ctx: Any = None,
) -> EvalRunSummary:
    """Run canonical queries through the planner. The caller supplies
    ``planner`` + ``ctx`` (so the API layer can inject test stubs);
    production wiring lives in ``api.py``."""
    queries: list[LoadedQuery] = load_canonical_queries()
    if unit:
        queries = [q for q in queries if q.unit == unit]
    if tag:
        queries = [q for q in queries if tag in q.query.tags]

    results: list[EvalResult] = []
    if planner is None or ctx is None:
        # Schema-only mode: every fixture is exercised through Pydantic
        # already (load_canonical_queries raises on malformed). Report
        # zero failures + zero passes so the GUI can show "validate-only".
        return EvalRunSummary(
            total=len(queries),
            passed=0,
            failed=0,
            skipped=len(queries),
            results=tuple(
                {
                    "query_id": q.query.id,
                    "unit": q.unit,
                    "source": str(q.source),
                    "passed": True,
                    "skipped": True,
                    "skip_reason": "no_planner_supplied",
                    "plan_failures": [],
                    "prose_failures": [],
                    "planner_error": None,
                    "duration_ms": 0,
                }
                for q in queries
            ),
            text_report=f"chisel eval — {len(queries)} queries discovered (no planner; schema validated)",
        )

    for lq in queries:
        results.append(await run_plan_eval(lq, planner=planner, ctx=ctx))

    return EvalRunSummary(
        total=len(results),
        passed=sum(1 for r in results if r.passed and not r.skipped),
        failed=sum(1 for r in results if not r.passed),
        skipped=sum(1 for r in results if r.skipped),
        results=tuple(_result_to_dict(r) for r in results),
        text_report=format_results(results),
    )
