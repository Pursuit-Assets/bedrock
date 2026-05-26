"""Integration tests for the ``/api/chisel/*`` FastAPI router.

Tests build a fresh FastAPI app with no auth dependencies, mount the
chisel router, and drive endpoints via TestClient. Production-mounted
router (with auth) lives in ``pebble/main.py``; this surface is
covered there indirectly.
"""

from __future__ import annotations

import os
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from pebble.chisel.api import build_router


def _make_client() -> TestClient:
    app = FastAPI()
    app.include_router(build_router(auth_dependencies=[]))
    return TestClient(app)


# ---------------------------------------------------------------------------
# read endpoints
# ---------------------------------------------------------------------------

def test_health_returns_shape() -> None:
    client = _make_client()
    resp = client.get("/api/chisel/health")
    assert resp.status_code == 200
    body = resp.json()
    assert "loaded_tools" in body
    assert "loaded_workflows" in body
    assert isinstance(body["ok"], bool)


def test_list_tools_returns_inventory() -> None:
    client = _make_client()
    resp = client.get("/api/chisel/tools")
    assert resp.status_code == 200
    names = {t["name"] for t in resp.json()["tools"]}
    assert {"search_crm", "get_record", "generate_chart",
            "request_human_review", "aggregate_pipeline_views"} <= names


def test_get_tool_returns_detail() -> None:
    client = _make_client()
    resp = client.get("/api/chisel/tools/search_crm")
    assert resp.status_code == 200
    body = resp.json()
    assert body["unit"]["name"] == "search_crm"
    assert "name: search_crm" in body["manifest_yaml"]
    assert body["handler_source"] is not None
    assert body["input_schema"]["additionalProperties"] is False


def test_get_tool_404_unknown() -> None:
    client = _make_client()
    resp = client.get("/api/chisel/tools/nope")
    assert resp.status_code == 404


def test_list_workflows_returns_inventory() -> None:
    client = _make_client()
    resp = client.get("/api/chisel/workflows")
    assert resp.status_code == 200
    names = {w["name"] for w in resp.json()["workflows"]}
    assert "weekly_pipeline_review" in names


def test_get_workflow_returns_build_plan_source() -> None:
    client = _make_client()
    resp = client.get("/api/chisel/workflows/weekly_pipeline_review")
    assert resp.status_code == 200
    body = resp.json()
    assert body["unit"]["slash_command"] == "/pipeline"
    assert body["unit"]["has_custom_plan"] is True
    assert "def build_plan" in body["build_plan_source"]


# ---------------------------------------------------------------------------
# validate
# ---------------------------------------------------------------------------

def test_validate_tool_manifest_ok() -> None:
    client = _make_client()
    resp = client.post("/api/chisel/validate", json={
        "kind": "tool",
        "manifest_yaml": "name: my_tool\ndescription: x\nversion: 1.0.0\n",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["issues"] == []


def test_validate_tool_manifest_bad_name() -> None:
    client = _make_client()
    resp = client.post("/api/chisel/validate", json={
        "kind": "tool",
        "manifest_yaml": "name: BadName\ndescription: x\n",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert any(i["location"] == "name" for i in body["issues"])


def test_validate_workflow_requires_custom_plan_or_steps() -> None:
    client = _make_client()
    resp = client.post("/api/chisel/validate", json={
        "kind": "workflow",
        "manifest_yaml": "name: wf\ndescription: x\n",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False


def test_validate_rejects_unknown_kind() -> None:
    client = _make_client()
    resp = client.post("/api/chisel/validate", json={
        "kind": "totem",
        "manifest_yaml": "name: x\n",
    })
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# reload + eval
# ---------------------------------------------------------------------------

def test_reload_re_runs_autoload() -> None:
    client = _make_client()
    resp = client.post("/api/chisel/reload")
    assert resp.status_code == 200
    body = resp.json()
    assert "search_crm" in body["loaded_tools"]


def test_eval_without_api_key_skips_planner_calls(monkeypatch) -> None:
    """No ANTHROPIC_API_KEY → eval discovers fixtures and skips them
    rather than burning tokens or erroring."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    client = _make_client()
    resp = client.post("/api/chisel/eval", json={})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] > 0
    assert body["skipped"] == body["total"]


def test_eval_filters_by_unit(monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    client = _make_client()
    resp = client.post("/api/chisel/eval", json={"unit": "search_crm"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] >= 1
    assert all(r["unit"] == "search_crm" for r in body["results"])
