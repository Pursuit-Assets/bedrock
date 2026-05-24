"""Walk ``pebble/chisel/{tools,workflows}/`` and register each unit on
a ``ToolRegistry``.

Failure policy: a malformed manifest or import error in one unit must
NOT block the others. ``autoload`` returns an ``AutoloadReport`` listing
what loaded and which dirs errored so the app surfaces failures at
``/api/chisel/health`` (Phase C) without crashing the process.

Public surface:
  * ``autoload(registry=None, root=None)`` — discover + register.
  * ``lookup_slash(slash)`` — slash → WorkflowEntry (router dispatch).
  * ``lookup_intent(intent)`` — intent → WorkflowEntry (orchestrator dispatch).
"""

from __future__ import annotations

import importlib
import importlib.util
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

import yaml
from pydantic import BaseModel, ValidationError

from pebble.orchestrator.tools import (
    DEFAULT_REGISTRY,
    ToolRegistry,
    ToolSpec,
)

from .handler_adapter import build_handler_wrapper
from .lints import lint_handler_module
from .manifest import ToolManifest, WorkflowManifest
from .schema import pydantic_to_strict_schema

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Workflow registry (single source of truth — no dual maps)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class WorkflowEntry:
    name: str
    dispatch_intent: str
    slash_command: Optional[str]
    build_plan: Callable[..., Any]


@dataclass
class AutoloadReport:
    loaded_tools: list[str] = field(default_factory=list)
    loaded_workflows: list[str] = field(default_factory=list)
    errors: list[tuple[str, str]] = field(default_factory=list)  # (path, reason)
    lint_warnings: list[tuple[str, str]] = field(default_factory=list)


_BY_SLASH: dict[str, WorkflowEntry] = {}
_BY_INTENT: dict[str, WorkflowEntry] = {}


def lookup_slash(slash: str) -> Optional[WorkflowEntry]:
    return _BY_SLASH.get(slash)


def lookup_intent(intent: str) -> Optional[WorkflowEntry]:
    return _BY_INTENT.get(intent)


# ---------------------------------------------------------------------------
# autoload
# ---------------------------------------------------------------------------

def autoload(
    *,
    registry: Optional[ToolRegistry] = None,
    root: Optional[Path] = None,
) -> AutoloadReport:
    """Discover Chisel units and register them. Resets the workflow
    lookup maps before populating; pass an isolated ``registry`` to
    avoid touching ``DEFAULT_REGISTRY`` from tests."""
    if registry is None:
        registry = DEFAULT_REGISTRY
    if root is None:
        root = Path(__file__).parent

    report = AutoloadReport()
    _BY_SLASH.clear()
    _BY_INTENT.clear()

    tools_root = root / "tools"
    if tools_root.is_dir():
        for tool_dir in sorted(p for p in tools_root.iterdir() if p.is_dir()):
            if tool_dir.name.startswith(("_", ".")):
                continue
            try:
                _load_tool(tool_dir, registry, report)
                report.loaded_tools.append(tool_dir.name)
            except Exception as e:  # noqa: BLE001 — surface, don't crash
                report.errors.append((str(tool_dir), f"{type(e).__name__}: {e}"))

    workflows_root = root / "workflows"
    if workflows_root.is_dir():
        for wf_dir in sorted(p for p in workflows_root.iterdir() if p.is_dir()):
            if wf_dir.name.startswith(("_", ".")):
                continue
            try:
                _load_workflow(wf_dir)
                report.loaded_workflows.append(wf_dir.name)
            except Exception as e:  # noqa: BLE001
                report.errors.append((str(wf_dir), f"{type(e).__name__}: {e}"))

    for path, reason in report.lint_warnings:
        logger.warning("chisel lint %s: %s", path, reason)

    return report


# ---------------------------------------------------------------------------
# Per-unit loaders
# ---------------------------------------------------------------------------

def _load_tool(
    tool_dir: Path,
    registry: ToolRegistry,
    report: AutoloadReport,
) -> None:
    manifest_path = tool_dir / "manifest.yaml"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"missing manifest.yaml in {tool_dir}")

    raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
    try:
        manifest = ToolManifest(**raw)
    except ValidationError as e:
        raise ValueError(f"manifest invalid: {e.errors()}") from e

    handler_path = tool_dir / "handler.py"
    if not handler_path.is_file():
        raise FileNotFoundError(f"missing handler.py in {tool_dir}")

    # Advisory lints — warnings only, don't block registration.
    for err in lint_handler_module(handler_path):
        report.lint_warnings.append(
            (str(handler_path), f"{err.rule}:{err.lineno}: {err.message}"),
        )

    module = _import_module(
        handler_path,
        package=f"pebble.chisel.tools.{tool_dir.name}.handler",
    )

    input_model = _resolve_attr(module, "Input", BaseModel)
    user_run = _resolve_callable(module, "run")

    wrapped = build_handler_wrapper(
        tool_name=manifest.name,
        tool_version=manifest.version,
        input_model=input_model,
        user_run=user_run,
    )

    # unregister-then-register so a second autoload() (e.g. ``chisel
    # reload``) replaces specs in place instead of raising on duplicate.
    registry.unregister(manifest.name)
    registry.register(ToolSpec(
        name=manifest.name,
        description=manifest.description,
        input_schema=pydantic_to_strict_schema(input_model),
        handler=wrapped,
        cost_estimate_usd=manifest.cost_estimate_usd,
        requires_human=manifest.requires_human,
        tags=manifest.tags,
    ))


def _load_workflow(wf_dir: Path) -> None:
    manifest_path = wf_dir / "workflow.yaml"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"missing workflow.yaml in {wf_dir}")

    raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
    try:
        manifest = WorkflowManifest(**raw)
    except ValidationError as e:
        raise ValueError(f"workflow invalid: {e.errors()}") from e

    if manifest.has_custom_plan:
        build_plan_path = wf_dir / "build_plan.py"
        if not build_plan_path.is_file():
            raise FileNotFoundError(
                f"workflow {manifest.name!r} sets has_custom_plan=true "
                f"but build_plan.py is missing",
            )
        module = _import_module(
            build_plan_path,
            package=f"pebble.chisel.workflows.{wf_dir.name}.build_plan",
        )
        builder = _resolve_callable(module, "build_plan")
    else:
        builder = _make_declarative_builder(manifest)

    entry = WorkflowEntry(
        name=manifest.name,
        dispatch_intent=manifest.dispatch_intent,  # type: ignore[arg-type]  # filled by validator
        slash_command=manifest.slash_command,
        build_plan=builder,
    )
    if entry.slash_command:
        _BY_SLASH[entry.slash_command] = entry
    _BY_INTENT[entry.dispatch_intent] = entry


def _make_declarative_builder(manifest: WorkflowManifest) -> Callable[..., Any]:
    """Synthesize a build_plan callable from declarative ``steps[]``."""
    from pebble.orchestrator.schemas import Plan, PlanStep

    def builder(*, user_query: str = manifest.description, **_unused: Any) -> Plan:
        return Plan(
            user_query=user_query,
            steps=tuple(
                PlanStep(tool=s.tool, args=dict(s.args), success_criteria=s.success_criteria)
                for s in manifest.steps
            ),
            rationale=f"Declarative workflow: {manifest.name}",
            estimated_tool_calls=len(manifest.steps),
        )

    return builder


# ---------------------------------------------------------------------------
# Module-loading helpers
# ---------------------------------------------------------------------------

def _import_module(path: Path, *, package: str) -> Any:
    """Load a chisel module. Uses the standard import system when the
    file lives under the real ``pebble.chisel.*`` tree (so relative
    imports resolve); falls back to spec_from_file_location for
    tmp_path-based tests."""
    try:
        path_resolved = path.resolve()
        chisel_root = Path(__file__).parent.resolve()
        path_resolved.relative_to(chisel_root)
        return importlib.import_module(package)
    except (ValueError, ImportError):
        pass

    spec = importlib.util.spec_from_file_location(package, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot build module spec for {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[package] = module
    spec.loader.exec_module(module)
    return module


def _resolve_attr(module: Any, name: str, base: type) -> type:
    attr = getattr(module, name, None)
    if attr is None:
        raise AttributeError(f"{module.__name__}: missing `{name}` class")
    if not isinstance(attr, type) or not issubclass(attr, base):
        raise TypeError(
            f"{module.__name__}.{name} must be a subclass of {base.__name__}",
        )
    return attr


def _resolve_callable(module: Any, name: str) -> Any:
    attr = getattr(module, name, None)
    if attr is None:
        raise AttributeError(f"{module.__name__}: missing `{name}` function")
    if not callable(attr):
        raise TypeError(f"{module.__name__}.{name} must be callable")
    return attr
