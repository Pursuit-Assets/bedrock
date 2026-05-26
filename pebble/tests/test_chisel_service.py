"""Unit tests for ``pebble.chisel.service``.

The service layer is read-mostly: filesystem inventory, manifest text
reads, YAML validation, autoload trigger, eval wrapper. These tests
exercise the service directly (no FastAPI) so they cover the real
``pebble/chisel/`` tree as well as tmp_path-based fixtures.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from textwrap import dedent

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from pebble.chisel import service


# ---------------------------------------------------------------------------
# inventory
# ---------------------------------------------------------------------------

def test_list_units_discovers_real_tree() -> None:
    units = service.list_units()
    by_kind: dict[str, set[str]] = {"tool": set(), "workflow": set()}
    for u in units:
        by_kind[u.kind].add(u.name)
    assert {"search_crm", "get_record", "generate_chart",
            "request_human_review", "aggregate_pipeline_views"} <= by_kind["tool"]
    assert "weekly_pipeline_review" in by_kind["workflow"]


def test_tool_inventory_carries_manifest_fields() -> None:
    units = {u.name: u for u in service.list_units() if u.kind == "tool"}
    rhr = units["request_human_review"]
    assert rhr.requires_human is True
    assert rhr.version == "1.0.0"
    assert rhr.manifest_path.endswith("manifest.yaml")
    assert rhr.handler_path.endswith("handler.py")
    assert rhr.load_error is None


def test_workflow_inventory_carries_slash_and_intent() -> None:
    units = {u.name: u for u in service.list_units() if u.kind == "workflow"}
    wf = units["weekly_pipeline_review"]
    assert wf.slash_command == "/pipeline"
    assert wf.dispatch_intent == "workflow_weekly_pipeline_review"
    assert wf.has_custom_plan is True
    assert wf.has_canonical_queries is True


def test_list_units_includes_units_with_load_errors(tmp_path: Path) -> None:
    """A tool with an invalid manifest still appears in inventory with
    load_error populated — the GUI shows it as broken so an author
    can fix it in place."""
    (tmp_path / "tools" / "borked").mkdir(parents=True)
    (tmp_path / "tools" / "borked" / "manifest.yaml").write_text(
        "name: BadName\ndescription: x\n", encoding="utf-8",
    )
    (tmp_path / "tools" / "borked" / "handler.py").write_text(
        "async def run(args, ctx): return {}\n", encoding="utf-8",
    )
    units = service.list_units(root=tmp_path)
    assert len(units) == 1
    assert units[0].name == "borked"
    assert units[0].load_error is not None
    assert "manifest invalid" in units[0].load_error


# ---------------------------------------------------------------------------
# detail view
# ---------------------------------------------------------------------------

def test_get_tool_detail_returns_manifest_handler_schema() -> None:
    detail = service.get_tool_detail("search_crm")
    assert detail is not None
    assert "name: search_crm" in detail.manifest_yaml
    assert detail.handler_source is not None
    assert "async def run" in detail.handler_source
    # input_schema is populated from DEFAULT_REGISTRY → must be strict.
    assert detail.input_schema is not None
    assert detail.input_schema["additionalProperties"] is False
    assert "query" in detail.input_schema["properties"]


def test_get_tool_detail_unknown_returns_none() -> None:
    assert service.get_tool_detail("does_not_exist") is None


def test_get_workflow_detail_returns_build_plan_source() -> None:
    detail = service.get_workflow_detail("weekly_pipeline_review")
    assert detail is not None
    assert detail.build_plan_source is not None
    assert "def build_plan" in detail.build_plan_source
    assert detail.canonical_queries_yaml is not None


# ---------------------------------------------------------------------------
# YAML validation
# ---------------------------------------------------------------------------

def test_validate_tool_manifest_ok() -> None:
    yaml_text = dedent(
        """
        name: my_tool
        description: x
        version: 1.0.0
        """
    ).strip()
    assert service.validate_tool_manifest_yaml(yaml_text) == []


def test_validate_tool_manifest_bad_name() -> None:
    issues = service.validate_tool_manifest_yaml("name: BadName\ndescription: x\n")
    assert any(i.location == "name" for i in issues)


def test_validate_tool_manifest_unknown_field() -> None:
    issues = service.validate_tool_manifest_yaml(
        "name: ok_name\ndescription: x\nbogus_field: 1\n",
    )
    assert any("extra" in i.type.lower() or "extra" in i.message.lower() for i in issues)


def test_validate_tool_manifest_yaml_parse_error() -> None:
    issues = service.validate_tool_manifest_yaml("name: [unterminated")
    assert any(i.type == "yaml_error" for i in issues)


def test_validate_tool_manifest_non_mapping() -> None:
    issues = service.validate_tool_manifest_yaml("- just a list\n")
    assert any(i.type == "shape_error" for i in issues)


def test_validate_workflow_manifest_requires_shape() -> None:
    issues = service.validate_workflow_manifest_yaml(
        "name: wf\ndescription: x\n",
    )
    # Neither steps[] nor has_custom_plan → validation fails
    assert issues


def test_validate_workflow_manifest_ok_with_custom_plan() -> None:
    yaml_text = dedent(
        """
        name: wf
        description: x
        has_custom_plan: true
        """
    ).strip()
    assert service.validate_workflow_manifest_yaml(yaml_text) == []


# ---------------------------------------------------------------------------
# reload + health
# ---------------------------------------------------------------------------

def test_reload_returns_serializable_health() -> None:
    health = service.reload_chisel()
    d = health.to_dict()
    assert "loaded_tools" in d
    assert "loaded_workflows" in d
    assert "errors" in d
    assert "lint_warnings" in d
    assert isinstance(d["ok"], bool)
    assert "search_crm" in d["loaded_tools"]


# ---------------------------------------------------------------------------
# eval wrapper
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_run_canonical_eval_without_planner_skips_all() -> None:
    """No planner supplied → every discovered query is marked skipped
    with skip_reason='no_planner_supplied' so the GUI can show a
    'configure ANTHROPIC_API_KEY' hint."""
    summary = await service.run_canonical_eval(planner=None, ctx=None)
    assert summary.total > 0
    assert summary.skipped == summary.total
    assert summary.passed == 0
    assert summary.failed == 0
    assert all(r["skipped"] for r in summary.results)
    assert all(r["skip_reason"] == "no_planner_supplied" for r in summary.results)


@pytest.mark.asyncio
async def test_run_canonical_eval_filter_by_unit() -> None:
    summary = await service.run_canonical_eval(unit="search_crm")
    units_seen = {r["unit"] for r in summary.results}
    assert units_seen == {"search_crm"}


@pytest.mark.asyncio
async def test_run_canonical_eval_filter_by_tag() -> None:
    summary = await service.run_canonical_eval(tag="smoke")
    assert summary.total > 0
    assert all(r["unit"] for r in summary.results)  # at least some loaded
