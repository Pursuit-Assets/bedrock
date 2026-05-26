"""Smoke tests for Phase C.3 manifest save logic.

Exercises the service-layer save functions against tmp_path roots so
the real chisel tree stays untouched. End-to-end API + GUI coverage
deferred to C.3 follow-up (priority shifted to research-pipeline work).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from textwrap import dedent

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from pebble.chisel import service


def _seed_tool(tmp_path: Path, name: str) -> Path:
    d = tmp_path / "tools" / name
    d.mkdir(parents=True)
    (d / "__init__.py").write_text("", encoding="utf-8")
    (d / "manifest.yaml").write_text(
        f"name: {name}\ndescription: x\nversion: 1.0.0\n", encoding="utf-8",
    )
    (d / "handler.py").write_text(
        dedent(
            """
            from pydantic import BaseModel
            class Input(BaseModel):
                q: str = ""
            async def run(args, ctx):
                return {}
            """
        ).strip(),
        encoding="utf-8",
    )
    return d


def test_save_tool_manifest_rejects_path_traversal(tmp_path: Path) -> None:
    with pytest.raises(service.ChiselSaveError, match="must match"):
        service.save_tool_manifest("../escape", "name: x\n", root=tmp_path)


def test_save_tool_manifest_rejects_name_mismatch(tmp_path: Path) -> None:
    _seed_tool(tmp_path, "alpha")
    yaml_text = "name: beta\ndescription: x\nversion: 1.0.0\n"
    with pytest.raises(service.ChiselSaveError, match="does not match URL"):
        service.save_tool_manifest("alpha", yaml_text, root=tmp_path)


def test_save_tool_manifest_atomic_overwrite(tmp_path: Path) -> None:
    """Happy path: existing tool dir, new manifest validates, gets written."""
    d = _seed_tool(tmp_path, "alpha")
    new_yaml = dedent(
        """
        name: alpha
        description: updated description
        version: 1.1.0
        tags:
          - updated
        """
    ).strip()
    # save_tool_manifest also calls autoload() which re-walks the real
    # chisel tree; that's fine for the side-effect smoke but the unit
    # we get back is from the tmp_path root we passed in.
    unit = service.save_tool_manifest("alpha", new_yaml, root=tmp_path)
    assert unit.version == "1.1.0"
    assert (d / "manifest.yaml").read_text(encoding="utf-8") == new_yaml


def test_create_workflow_writes_dir_and_manifest(tmp_path: Path) -> None:
    yaml_text = dedent(
        """
        name: declarative_wf
        description: a brand new workflow
        slash_command: /demo
        steps:
          - tool: search_crm
            args: {query: "x"}
        """
    ).strip()
    unit = service.create_workflow("declarative_wf", yaml_text, root=tmp_path)
    assert unit.slash_command == "/demo"
    assert (tmp_path / "workflows" / "declarative_wf" / "workflow.yaml").is_file()
    assert (tmp_path / "workflows" / "declarative_wf" / "__init__.py").is_file()


def test_create_workflow_refuses_has_custom_plan(tmp_path: Path) -> None:
    yaml_text = dedent(
        """
        name: needs_pr
        description: x
        has_custom_plan: true
        """
    ).strip()
    with pytest.raises(service.ChiselSaveError, match="declarative"):
        service.create_workflow("needs_pr", yaml_text, root=tmp_path)


def test_save_workflow_manifest_rejects_missing_dir(tmp_path: Path) -> None:
    yaml_text = "name: ghost\ndescription: x\nhas_custom_plan: true\n"
    with pytest.raises(service.ChiselSaveError, match="does not exist"):
        service.save_workflow_manifest("ghost", yaml_text, root=tmp_path)


def test_save_tool_manifest_rejects_invalid_yaml(tmp_path: Path) -> None:
    _seed_tool(tmp_path, "alpha")
    with pytest.raises(service.ChiselSaveError, match="yaml parse"):
        service.save_tool_manifest("alpha", "name: [unterminated\n", root=tmp_path)


def test_save_tool_manifest_rejects_invalid_pydantic(tmp_path: Path) -> None:
    _seed_tool(tmp_path, "alpha")
    with pytest.raises(service.ChiselSaveError, match="invalid"):
        service.save_tool_manifest(
            "alpha",
            "name: alpha\ndescription:\nversion: 1.0.0\n",  # description empty fails min_length
            root=tmp_path,
        )
