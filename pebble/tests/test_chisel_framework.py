"""Phase A.1 unit tests for the Chisel framework.

Covers, per plan §8:

  * manifest schema validation
  * Pydantic→strict JSON Schema (P1 — additionalProperties:false at every object node)
  * handler adapter happy / validation-error / exception / wrong-return-type
  * autoload: empty dirs, malformed manifest doesn't poison siblings,
    registry= argument honored (P4), idempotent across calls
  * RBAC stub: bypass env, missing perm, no requirement
  * lints: bare httpx, sync run, os.environ in run, overrides
  * snapshot: survives in-flight mutation of source registry (P5)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from textwrap import dedent

import pytest
from pydantic import BaseModel, Field, ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from pebble.chisel.autoload import autoload
from pebble.chisel.handler_adapter import HandlerContext, build_handler_wrapper
from pebble.chisel.lints import lint_handler_module
from pebble.chisel.manifest import (
    FixedCost,
    ToolManifest,
    VariableCost,
    WorkflowManifest,
    cost_estimate_to_float,
)
from pebble.chisel.rbac import check_permission
from pebble.chisel.reload import snapshot
from pebble.chisel.schema import assert_strict, pydantic_to_strict_schema
from pebble.orchestrator.tools import ToolContext, ToolRegistry, ToolSpec


# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------

def test_tool_manifest_minimal_valid() -> None:
    m = ToolManifest(name="search_crm", description="x")
    assert m.version == "1.0.0"
    assert isinstance(m.cost_estimate, FixedCost)
    assert m.output_kind == "prose"
    assert m.scope == "global"


def test_tool_manifest_rejects_bad_name() -> None:
    with pytest.raises(ValidationError):
        ToolManifest(name="SearchCRM", description="x")
    with pytest.raises(ValidationError):
        ToolManifest(name="1bad", description="x")


def test_tool_manifest_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        ToolManifest(name="ok_name", description="x", typo_field=1)


def test_cost_variable_collapses_to_max() -> None:
    m = ToolManifest(
        name="llm_tool",
        description="x",
        cost_estimate=VariableCost(variable={"max": 0.5}),
    )
    assert cost_estimate_to_float(m.cost_estimate) == pytest.approx(0.5)


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


# ---------------------------------------------------------------------------
# schema strictness (P1)
# ---------------------------------------------------------------------------

class _Inner(BaseModel):
    a: int


class _NestedInput(BaseModel):
    name: str = Field(min_length=1)
    inner: _Inner
    tags: list[str] = []


def test_strict_schema_has_no_permissive_objects() -> None:
    schema = pydantic_to_strict_schema(_NestedInput)
    assert_strict(schema)


def test_strict_schema_inlines_refs() -> None:
    schema = pydantic_to_strict_schema(_NestedInput)
    assert "$defs" not in schema
    inner_prop = schema["properties"]["inner"]
    assert inner_prop["type"] == "object"
    assert inner_prop["additionalProperties"] is False


def test_assert_strict_flags_permissive_object() -> None:
    bad = {"type": "object", "properties": {"x": {"type": "integer"}}}
    with pytest.raises(AssertionError):
        assert_strict(bad)


# ---------------------------------------------------------------------------
# handler adapter (P2, P11)
# ---------------------------------------------------------------------------

class _AdapterInput(BaseModel):
    query: str = Field(min_length=1)
    limit: int = 8


def _make_ctx() -> ToolContext:
    return ToolContext(user_email="rm@pursuit.org", conversation_id="c1")


@pytest.mark.asyncio
async def test_adapter_happy_path_records_version_and_citations() -> None:
    async def run(args: _AdapterInput, ctx: HandlerContext) -> dict:
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
    async def run(args: _AdapterInput, ctx: HandlerContext) -> dict:
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
    async def run(args: _AdapterInput, ctx: HandlerContext) -> dict:
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
    async def run(args: _AdapterInput, ctx: HandlerContext) -> dict:
        return ["wrong shape"]  # type: ignore[return-value]

    wrapped = build_handler_wrapper(
        tool_name="t", tool_version="1.0.0",
        input_model=_AdapterInput, user_run=run,
    )
    res = await wrapped({"query": "x"}, _make_ctx())
    assert res.ok is False
    assert "handler_contract" in (res.error or "")


# ---------------------------------------------------------------------------
# autoload (P4 — isolation, robustness)
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
    assert "alpha" in reg
    spec = reg.get("alpha")
    assert isinstance(spec, ToolSpec)
    # input_schema must be strict
    assert_strict(spec.input_schema)


def test_autoload_isolates_malformed_from_siblings(tmp_path: Path) -> None:
    _write_tool(tmp_path, "good", manifest_yaml=_ok_manifest("good"), handler_py=_ok_handler("good"))
    # Malformed: invalid name
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


def test_autoload_workflow_declarative_populates_slash_intent_and_builder(tmp_path: Path) -> None:
    wf = tmp_path / "workflows" / "demo_wf"
    wf.mkdir(parents=True)
    (wf / "workflow.yaml").write_text(
        dedent(
            """
            name: demo_wf
            description: declarative demo
            slash_command: /demo
            dispatch_intent: workflow_demo
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
    from pebble.chisel.autoload import (
        build_workflow_plan,
        dispatch_workflow,
        slash_command_map,
    )

    assert "demo_wf" in report.loaded_workflows
    assert slash_command_map().get("/demo") == "demo_wf"
    assert dispatch_workflow("workflow_demo") == "demo_wf"

    plan = build_workflow_plan("workflow_demo", user_query="hi")
    assert plan is not None
    assert plan.user_query == "hi"
    assert len(plan.steps) == 1
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
            dispatch_intent: workflow_custom
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
    from pebble.chisel.autoload import build_workflow_plan

    assert "custom_wf" in report.loaded_workflows, report.errors
    plan = build_workflow_plan("workflow_custom", user_query="hi", multiplier=3)
    assert plan is not None
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


def test_autoload_isolation_does_not_touch_default_registry(tmp_path: Path) -> None:
    _write_tool(tmp_path, "iso_only", manifest_yaml=_ok_manifest("iso_only"), handler_py=_ok_handler("iso_only"))
    reg = ToolRegistry()
    autoload(registry=reg, root=tmp_path)
    from pebble.orchestrator.tools import DEFAULT_REGISTRY
    assert "iso_only" not in DEFAULT_REGISTRY


# ---------------------------------------------------------------------------
# RBAC stub (§11.9)
# ---------------------------------------------------------------------------

def test_rbac_no_requirement_always_ok() -> None:
    res = check_permission(user_email="anyone@x", required_permission=None)
    assert res.ok


def test_rbac_bypass_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PEBBLE_CHISEL_RBAC_BYPASS_USERS", "rm@pursuit.org , staff@pursuit.org")
    res = check_permission(user_email="RM@pursuit.org", required_permission="chisel_write")
    assert res.ok
    assert res.reason == "bypass_list"


def test_rbac_missing_permission(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PEBBLE_CHISEL_RBAC_BYPASS_USERS", raising=False)
    monkeypatch.delenv("PEBBLE_CHAT_ALLOWED_EMAILS", raising=False)
    res = check_permission(user_email="x@y", required_permission="chisel_write")
    assert not res.ok
    assert "chisel_write" in res.reason


def test_rbac_falls_back_to_chat_allowed_emails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PEBBLE_CHISEL_RBAC_BYPASS_USERS", raising=False)
    monkeypatch.setenv("PEBBLE_CHAT_ALLOWED_EMAILS", "fallback@pursuit.org")
    res = check_permission(user_email="fallback@pursuit.org", required_permission="chisel_write")
    assert res.ok


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


def test_lints_flag_env_in_run(tmp_path: Path) -> None:
    p = tmp_path / "handler.py"
    p.write_text(
        dedent(
            """
            import os
            async def run(args, ctx):
                return {"v": os.environ.get("X")}
            """
        ),
        encoding="utf-8",
    )
    rules = {e.rule for e in lint_handler_module(p)}
    assert "no_env_in_run" in rules


def test_lints_overrides_suppress(tmp_path: Path) -> None:
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
    rules = {e.rule for e in lint_handler_module(p, overrides=("no_bare_httpx",))}
    assert "no_bare_httpx" not in rules


# ---------------------------------------------------------------------------
# snapshot (P5)
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
    # Mutate source — simulate reload mid-request.
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
