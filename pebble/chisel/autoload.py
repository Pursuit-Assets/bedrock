"""Walk ``pebble/chisel/{tools,workflows}/`` and register each unit
on a ``ToolRegistry``.

Failure policy (plan §9, Phase-A risks): a malformed manifest or an
import error in one handler must NOT block the others. ``autoload``
returns an ``AutoloadReport`` listing what loaded and which dirs errored
so the app surfaces failures at ``/api/chisel/health`` (Phase C) without
crashing the process.

Public entry points:
  * ``autoload(registry=None, root=None)`` — discover + register.
  * ``slash_command_map()`` — ``{slash: workflow_name}`` for the router.
  * ``dispatch_workflow(intent)`` — replaces the hard-coded
    ``_build_workflow_plan_for_intent`` dispatch in ``handlers/streaming.py``.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml
from pydantic import BaseModel, ValidationError

from pebble.orchestrator.tools import (
    DEFAULT_REGISTRY,
    ToolRegistry,
    ToolSpec,
)

from .handler_adapter import build_handler_wrapper
from .manifest import (
    ToolManifest,
    WorkflowManifest,
    cost_estimate_to_float,
)
from .schema import pydantic_to_strict_schema


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

@dataclass
class AutoloadReport:
    loaded_tools: list[str] = field(default_factory=list)
    loaded_workflows: list[str] = field(default_factory=list)
    errors: list[tuple[str, str]] = field(default_factory=list)  # (path, reason)

    def ok(self) -> bool:
        return not self.errors


# ---------------------------------------------------------------------------
# Slash + intent dispatch — populated by autoload.
# ---------------------------------------------------------------------------

_SLASH_COMMANDS: dict[str, str] = {}
_INTENT_DISPATCH: dict[str, str] = {}
_PLAN_BUILDERS: dict[str, Any] = {}  # workflow_name → callable(**kwargs) -> Plan


def slash_command_map() -> dict[str, str]:
    """Return a copy of the slash → workflow_name map. Used by
    ``pebble/router.py`` to replace its hard-coded ``_SLASH_COMMANDS``
    dict."""
    return dict(_SLASH_COMMANDS)


def slash_to_intent(slash: str) -> Optional[str]:
    """Return the dispatch_intent registered for a slash command, or
    None. Used by ``pebble/router.py`` to populate RouteResult.intent."""
    workflow_name = _SLASH_COMMANDS.get(slash)
    if workflow_name is None:
        return None
    for intent, name in _INTENT_DISPATCH.items():
        if name == workflow_name:
            return intent
    return None


def dispatch_workflow(intent: str) -> Optional[str]:
    """Return the workflow name registered for ``intent`` (planner
    output), or None. Replaces ``_build_workflow_plan_for_intent``."""
    return _INTENT_DISPATCH.get(intent)


def build_workflow_plan(intent_or_name: str, **kwargs: Any) -> Optional[Any]:
    """Look up the workflow by intent (preferred) or by name, then call
    its registered ``build_plan(**kwargs)``. Returns the Plan, or None
    if no workflow is registered for that intent/name."""
    name = _INTENT_DISPATCH.get(intent_or_name, intent_or_name)
    builder = _PLAN_BUILDERS.get(name)
    if builder is None:
        return None
    return builder(**kwargs)


# ---------------------------------------------------------------------------
# autoload
# ---------------------------------------------------------------------------

def autoload(
    *,
    registry: Optional[ToolRegistry] = None,
    root: Optional[Path] = None,
    reset: bool = True,
) -> AutoloadReport:
    """Discover Chisel units and register them.

    Args:
        registry: registry to register specs on; defaults to
            ``DEFAULT_REGISTRY`` so production paths Just Work. Tests pass a
            fresh ``ToolRegistry()`` for isolation (plan §P4).
        root: directory containing ``tools/`` and ``workflows/`` subdirs;
            defaults to ``pebble/chisel/`` next to this file.
        reset: clear the slash/intent maps before populating. Tests may
            pass False to accumulate registrations across autoload calls.
    """
    if registry is None:
        registry = DEFAULT_REGISTRY
    if root is None:
        root = Path(__file__).parent

    report = AutoloadReport()

    if reset:
        _SLASH_COMMANDS.clear()
        _INTENT_DISPATCH.clear()
        _PLAN_BUILDERS.clear()

    tools_root = root / "tools"
    if tools_root.is_dir():
        for tool_dir in sorted(p for p in tools_root.iterdir() if p.is_dir()):
            if tool_dir.name.startswith("_") or tool_dir.name.startswith("."):
                continue
            try:
                _load_tool(tool_dir, registry)
                report.loaded_tools.append(tool_dir.name)
            except Exception as e:  # noqa: BLE001 — surface, don't crash
                report.errors.append((str(tool_dir), f"{type(e).__name__}: {e}"))

    workflows_root = root / "workflows"
    if workflows_root.is_dir():
        for wf_dir in sorted(p for p in workflows_root.iterdir() if p.is_dir()):
            if wf_dir.name.startswith("_") or wf_dir.name.startswith("."):
                continue
            try:
                _load_workflow(wf_dir)
                report.loaded_workflows.append(wf_dir.name)
            except Exception as e:  # noqa: BLE001
                report.errors.append((str(wf_dir), f"{type(e).__name__}: {e}"))

    return report


# ---------------------------------------------------------------------------
# Per-unit loaders
# ---------------------------------------------------------------------------

def _load_tool(tool_dir: Path, registry: ToolRegistry) -> None:
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

    spec = ToolSpec(
        name=manifest.name,
        description=manifest.description,
        input_schema=pydantic_to_strict_schema(input_model),
        handler=wrapped,
        cost_estimate_usd=cost_estimate_to_float(manifest.cost_estimate),
        requires_human=manifest.requires_human,
        tags=manifest.tags,
    )
    registry.register(spec)


def _load_workflow(wf_dir: Path) -> None:
    manifest_path = wf_dir / "workflow.yaml"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"missing workflow.yaml in {wf_dir}")

    raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
    try:
        manifest = WorkflowManifest(**raw)
    except ValidationError as e:
        raise ValueError(f"workflow invalid: {e.errors()}") from e

    if manifest.slash_command:
        _SLASH_COMMANDS[manifest.slash_command] = manifest.name
    if manifest.dispatch_intent:
        _INTENT_DISPATCH[manifest.dispatch_intent] = manifest.name

    if manifest.has_custom_plan:
        build_plan_path = wf_dir / "build_plan.py"
        if not build_plan_path.is_file():
            raise FileNotFoundError(
                f"workflow {manifest.name!r} sets has_custom_plan=true "
                f"but {build_plan_path.name} is missing",
            )
        module = _import_module(
            build_plan_path,
            package=f"pebble.chisel.workflows.{wf_dir.name}.build_plan",
        )
        # The build_plan import also has to work for tmp_path-rooted
        # tests; spec_from_file_location path handles that branch.
        builder = _resolve_callable(module, "build_plan")
        _PLAN_BUILDERS[manifest.name] = builder
    else:
        # Declarative form — synthesize a build_plan from manifest.steps.
        _PLAN_BUILDERS[manifest.name] = _make_declarative_builder(manifest)


def _make_declarative_builder(manifest: WorkflowManifest) -> Any:
    """Compile a workflow's declarative ``steps[]`` into a build_plan
    callable so the orchestrator can run it through the same code path
    as a custom build_plan."""
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
# helpers
# ---------------------------------------------------------------------------

def _import_module(path: Path, *, package: str) -> Any:
    """Load a chisel-resident Python module. Prefers the standard import
    machinery when the module lives under the real ``pebble.chisel.*``
    package tree (so relative imports like ``from .compute import x``
    resolve). Falls back to spec_from_file_location for ad-hoc paths
    used in tests (``tmp_path`` outside the source tree)."""
    try:
        # Real source tree path → use the normal import system.
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
