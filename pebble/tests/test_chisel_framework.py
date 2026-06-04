"""Unit tests for the Chisel framework.

Covers:
  * manifest schema validation (ToolManifest + WorkflowManifest)
  * Pydantic→strict JSON Schema (additionalProperties:false everywhere)
  * handler adapter happy / validation-error / exception / wrong-return-type
  * autoload: empty dirs, malformed manifest doesn't poison siblings,
    registry= argument honored, lint warnings surface in the report
  * workflow dispatch: slash + intent lookup, declarative + custom builders
  * lints: bare httpx, sync/missing run
  * snapshot: survives in-flight mutation of source registry
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from textwrap import dedent

import pytest
from pydantic import BaseModel, Field, ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from pebble.chisel.autoload import autoload, lookup_intent, lookup_slash
from pebble.chisel.handler_adapter import HandlerContext, build_handler_wrapper
from pebble.chisel.lints import lint_handler_module
from pebble.chisel.manifest import ToolManifest, WorkflowManifest
from pebble.chisel.reload import snapshot
from pebble.chisel.schema import pydantic_to_strict_schema
from pebble.orchestrator.tools import ToolContext, ToolRegistry, ToolSpec


# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------

def test_tool_manifest_minimal_valid() -> None:
    m = ToolManifest(name="search_crm", description="x")
    assert m.version == "1.0.0"
    assert m.cost_estimate_usd == 0.0
    assert m.requires_human is False


def test_tool_manifest_rejects_bad_name() -> None:
    with pytest.raises(ValidationError):
        ToolManifest(name="SearchCRM", description="x")
    with pytest.raises(ValidationError):
        ToolManifest(name="1bad", description="x")


def test_tool_manifest_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        ToolManifest(name="ok_name", description="x", typo_field=1)


def test_workflow_requires_steps_or_custom_plan() -> None:
    with pytest.raises(ValidationError):
        WorkflowManifest(name="wf", description="x")
    WorkflowManifest(name="wf", description="x", has_custom_plan=True)
    WorkflowManifest(
        name="wf",
        description="x",
        steps=({"tool": "search_crm", "args": {"query": "y"}},),
    )


def test_workflow_slash_command_format() -> None:
    with pytest.raises(ValidationError):
        WorkflowManifest(name="wf", description="x", has_custom_plan=True, slash_command="bad")
    WorkflowManifest(name="wf", description="x", has_custom_plan=True, slash_command="/pipeline")


def test_workflow_dispatch_intent_auto_filled() -> None:
    """Convention: dispatch_intent defaults to workflow_<name>."""
    wf = WorkflowManifest(name="foo", description="x", has_custom_plan=True)
    assert wf.dispatch_intent == "workflow_foo"

    explicit = WorkflowManifest(
        name="bar", description="x", has_custom_plan=True,
        dispatch_intent="custom_intent",
    )
    assert explicit.dispatch_intent == "custom_intent"


# ---------------------------------------------------------------------------
# schema strictness
# ---------------------------------------------------------------------------

class _Inner(BaseModel):
    a: int


class _NestedInput(BaseModel):
    name: str = Field(min_length=1)
    inner: _Inner
    tags: list[str] = []


def _walk_object_nodes(schema):
    out = []
    def visit(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                out.append(node)
            for v in node.values():
                visit(v)
        elif isinstance(node, list):
            for v in node:
                visit(v)
    visit(schema)
    return out


def test_strict_schema_has_no_permissive_objects() -> None:
    schema = pydantic_to_strict_schema(_NestedInput)
    for node in _walk_object_nodes(schema):
        assert node["additionalProperties"] is False


def test_strict_schema_inlines_refs() -> None:
    schema = pydantic_to_strict_schema(_NestedInput)
    assert "$defs" not in schema
    inner_prop = schema["properties"]["inner"]
    assert inner_prop["type"] == "object"
    assert inner_prop["additionalProperties"] is False


# ---------------------------------------------------------------------------
# handler adapter
# ---------------------------------------------------------------------------

class _AdapterInput(BaseModel):
    query: str = Field(min_length=1)
    limit: int = 8


def _make_ctx() -> ToolContext:
    return ToolContext(user_email="rm@pursuit.org", conversation_id="c1")


@pytest.mark.asyncio
async def test_adapter_happy_path_records_version_and_citations() -> None:
    async def run(args, ctx):
        ctx.cite("sf_account", "001ABC")
        return {"hits": 1, "query": args.query}

    wrapped = build_handler_wrapper(
        tool_name="t", tool_version="2.3.4",
        input_model=_AdapterInput, user_run=run,
    )
    res = await wrapped({"query": "acme"}, _make_ctx())
    assert res.ok is True
    assert res.tool_version == "2.3.4"
    assert res.data == {"hits": 1, "query": "acme"}
    assert res.citations == ("sf_account:001ABC",)
    assert res.duration_ms >= 0


@pytest.mark.asyncio
async def test_adapter_input_validation_returns_ok_false() -> None:
    async def run(args, ctx):
        return {}

    wrapped = build_handler_wrapper(
        tool_name="t", tool_version="1.0.0",
        input_model=_AdapterInput, user_run=run,
    )
    res = await wrapped({"query": ""}, _make_ctx())
    assert res.ok is False
    assert "input_validation" in (res.error or "")
    assert res.tool_version == "1.0.0"


@pytest.mark.asyncio
async def test_adapter_handler_exception_wrapped() -> None:
    async def run(args, ctx):
        raise RuntimeError("boom")

    wrapped = build_handler_wrapper(
        tool_name="t", tool_version="1.0.0",
        input_model=_AdapterInput, user_run=run,
    )
    res = await wrapped({"query": "x"}, _make_ctx())
    assert res.ok is False
    assert "RuntimeError: boom" in (res.error or "")


@pytest.mark.asyncio
async def test_adapter_non_dict_return_rejected() -> None:
    async def run(args, ctx):
        return ["wrong shape"]

    wrapped = build_handler_wrapper(
        tool_name="t", tool_version="1.0.0",
        input_model=_AdapterInput, user_run=run,
    )
    res = await wrapped({"query": "x"}, _make_ctx())
    assert res.ok is False
    assert "handler_contract" in (res.error or "")


@pytest.mark.asyncio
async def test_handler_context_forwards_to_toolcontext() -> None:
    """HandlerContext exposes ToolContext attributes via __getattr__."""
    ctx = ToolContext(user_email="rm@pursuit.org", conversation_id="c1", org_id="acme")
    hctx = HandlerContext(ctx)
    assert hctx.user_email == "rm@pursuit.org"
    assert hctx.conversation_id == "c1"
    assert hctx.org_id == "acme"
    assert hctx.http_client is None


# ---------------------------------------------------------------------------
# autoload
# ---------------------------------------------------------------------------

def _write_tool(root: Path, name: str, *, manifest_yaml: str, handler_py: str) -> None:
    d = root / "tools" / name
    d.mkdir(parents=True)
    (d / "manifest.yaml").write_text(manifest_yaml, encoding="utf-8")
    (d / "handler.py").write_text(handler_py, encoding="utf-8")
    (d / "__init__.py").write_text("", encoding="utf-8")


def _ok_handler(name: str) -> str:
    return dedent(
        f"""
        from pydantic import BaseModel
        class Input(BaseModel):
            q: str = "default"
        async def run(args, ctx):
            return {{"name": "{name}", "q": args.q}}
        """
    ).strip()


def _ok_manifest(name: str) -> str:
    return dedent(
        f"""
        name: {name}
        description: test tool {name}
        version: 1.0.0
        """
    ).strip()


def test_autoload_empty_root_is_noop(tmp_path: Path) -> None:
    (tmp_path / "tools").mkdir()
    (tmp_path / "workflows").mkdir()
    reg = ToolRegistry()
    report = autoload(registry=reg, root=tmp_path)
    assert report.loaded_tools == []
    assert report.loaded_workflows == []
    assert report.errors == []
    assert len(reg) == 0


def test_autoload_loads_tool_into_isolated_registry(tmp_path: Path) -> None:
    _write_tool(tmp_path, "alpha", manifest_yaml=_ok_manifest("alpha"), handler_py=_ok_handler("alpha"))
    reg = ToolRegistry()
    report = autoload(registry=reg, root=tmp_path)
    assert report.loaded_tools == ["alpha"]
    spec = reg.get("alpha")
    assert isinstance(spec, ToolSpec)
    for node in _walk_object_nodes(spec.input_schema):
        assert node["additionalProperties"] is False


def test_autoload_isolates_malformed_from_siblings(tmp_path: Path) -> None:
    _write_tool(tmp_path, "good", manifest_yaml=_ok_manifest("good"), handler_py=_ok_handler("good"))
    _write_tool(
        tmp_path, "bad",
        manifest_yaml="name: BadName\ndescription: x",
        handler_py=_ok_handler("bad"),
    )
    reg = ToolRegistry()
    report = autoload(registry=reg, root=tmp_path)
    assert "good" in report.loaded_tools
    assert "bad" not in report.loaded_tools
    assert any("bad" in path for path, _ in report.errors)
    assert "good" in reg
    assert "bad" not in reg


def test_autoload_workflow_declarative_populates_lookup_and_builder(tmp_path: Path) -> None:
    wf = tmp_path / "workflows" / "demo_wf"
    wf.mkdir(parents=True)
    (wf / "workflow.yaml").write_text(
        dedent(
            """
            name: demo_wf
            description: declarative demo
            slash_command: /demo
            steps:
              - tool: aggregate_pipeline_views
                args: {days_to_close: 30}
                success_criteria: open_count reported
            """
        ).strip(),
        encoding="utf-8",
    )
    reg = ToolRegistry()
    report = autoload(registry=reg, root=tmp_path)
    assert "demo_wf" in report.loaded_workflows

    entry = lookup_slash("/demo")
    assert entry is not None
    assert entry.name == "demo_wf"
    assert entry.dispatch_intent == "workflow_demo_wf"  # auto-filled

    via_intent = lookup_intent("workflow_demo_wf")
    assert via_intent is entry

    plan = entry.build_plan(user_query="hi")
    assert plan.user_query == "hi"
    assert plan.steps[0].tool == "aggregate_pipeline_views"


def test_autoload_workflow_custom_build_plan(tmp_path: Path) -> None:
    wf = tmp_path / "workflows" / "custom_wf"
    wf.mkdir(parents=True)
    (wf / "__init__.py").write_text("", encoding="utf-8")
    (wf / "workflow.yaml").write_text(
        dedent(
            """
            name: custom_wf
            description: custom-plan demo
            slash_command: /custom
            has_custom_plan: true
            """
        ).strip(),
        encoding="utf-8",
    )
    (wf / "build_plan.py").write_text(
        dedent(
            """
            from pebble.orchestrator.schemas import Plan, PlanStep
            def build_plan(*, user_query="custom", multiplier=1, **_):
                return Plan(
                    user_query=user_query,
                    steps=(PlanStep(tool="search_crm", args={"q": "x" * multiplier}),),
                    rationale="custom",
                )
            """
        ),
        encoding="utf-8",
    )
    reg = ToolRegistry()
    report = autoload(registry=reg, root=tmp_path)
    assert "custom_wf" in report.loaded_workflows, report.errors

    entry = lookup_intent("workflow_custom_wf")
    assert entry is not None
    plan = entry.build_plan(user_query="hi", multiplier=3)
    assert plan.steps[0].args == {"q": "xxx"}


def test_autoload_workflow_missing_build_plan_reports_error(tmp_path: Path) -> None:
    wf = tmp_path / "workflows" / "broken_wf"
    wf.mkdir(parents=True)
    (wf / "workflow.yaml").write_text(
        dedent(
            """
            name: broken_wf
            description: broken
            has_custom_plan: true
            """
        ).strip(),
        encoding="utf-8",
    )
    reg = ToolRegistry()
    report = autoload(registry=reg, root=tmp_path)
    assert "broken_wf" not in report.loaded_workflows
    assert any("build_plan" in reason for _, reason in report.errors)


def test_autoload_lint_warnings_surface_in_report(tmp_path: Path) -> None:
    """A handler with a bare httpx import still registers, but the
    lint warning shows up in the report so CI/log readers see it."""
    handler_with_lint = dedent(
        """
        import httpx
        from pydantic import BaseModel
        class Input(BaseModel):
            q: str = "default"
        async def run(args, ctx):
            return {"q": args.q}
        """
    ).strip()
    _write_tool(tmp_path, "lintme", manifest_yaml=_ok_manifest("lintme"), handler_py=handler_with_lint)
    reg = ToolRegistry()
    report = autoload(registry=reg, root=tmp_path)
    assert "lintme" in report.loaded_tools  # registered despite lint hit
    assert any("no_bare_httpx" in msg for _, msg in report.lint_warnings)


def test_autoload_isolation_does_not_touch_default_registry(tmp_path: Path) -> None:
    _write_tool(tmp_path, "iso_only", manifest_yaml=_ok_manifest("iso_only"), handler_py=_ok_handler("iso_only"))
    reg = ToolRegistry()
    autoload(registry=reg, root=tmp_path)
    from pebble.orchestrator.tools import DEFAULT_REGISTRY
    assert "iso_only" not in DEFAULT_REGISTRY


# ---------------------------------------------------------------------------
# lints
# ---------------------------------------------------------------------------

def test_lints_flag_bare_httpx(tmp_path: Path) -> None:
    p = tmp_path / "handler.py"
    p.write_text(
        dedent(
            """
            import httpx
            async def run(args, ctx):
                return {}
            """
        ),
        encoding="utf-8",
    )
    rules = {e.rule for e in lint_handler_module(p)}
    assert "no_bare_httpx" in rules


def test_lints_flag_sync_run(tmp_path: Path) -> None:
    p = tmp_path / "handler.py"
    p.write_text(
        dedent(
            """
            def run(args, ctx):
                return {}
            """
        ),
        encoding="utf-8",
    )
    rules = {e.rule for e in lint_handler_module(p)}
    assert "async_run_required" in rules


def test_lints_flag_missing_run(tmp_path: Path) -> None:
    p = tmp_path / "handler.py"
    p.write_text("x = 1\n", encoding="utf-8")
    rules = {e.rule for e in lint_handler_module(p)}
    assert "async_run_required" in rules


# ---------------------------------------------------------------------------
# snapshot
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_snapshot_survives_source_mutation() -> None:
    from uuid import uuid4
    from pebble.orchestrator.schemas import ToolResult

    async def handler(args, ctx):
        return ToolResult(step_id=uuid4(), tool="x", ok=True)

    source = ToolRegistry()
    source.register(
        ToolSpec(
            name="x",
            description="d",
            input_schema={"type": "object", "additionalProperties": False, "properties": {}},
            handler=handler,
        )
    )

    snap = snapshot(source)
    source.unregister("x")
    source.register(
        ToolSpec(
            name="x_v2",
            description="d2",
            input_schema={"type": "object", "additionalProperties": False, "properties": {}},
            handler=handler,
        )
    )

    assert "x" in snap and "x_v2" not in snap
    assert "x" not in source and "x_v2" in source
