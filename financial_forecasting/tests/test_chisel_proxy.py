"""Tests for ``/api/chisel/*`` proxy (Phase C.1 — Bedrock-side).

Verifies:
  * GET endpoints forward to Pebble with X-User-Email + X-Trace-Id propagated.
  * POST /validate/reload/eval forward request bodies.
  * Pebble error status codes pass through.
  * Pebble unreachable → 502 with a typed detail.
  * close() shuts the singleton client.
"""

from __future__ import annotations

import os
import sys
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from routes import chisel_proxy


# ---------------------------------------------------------------------------
# Test app
# ---------------------------------------------------------------------------

def _fake_response(status_code: int, json_body: dict | None = None, *, text: str = ""):
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.json = MagicMock(return_value=json_body if json_body is not None else {})
    resp.text = text
    if json_body is None and not text:
        # Make .json() raise so the proxy falls back to text passthrough
        resp.json = MagicMock(side_effect=ValueError("no body"))
    return resp


@pytest.fixture
def app_factory(monkeypatch):
    def _build(*, response: object, raise_exc: BaseException | None = None) -> tuple[FastAPI, AsyncMock]:
        chisel_proxy._client = None

        fake_client = MagicMock()
        fake_client.is_closed = False
        if raise_exc is not None:
            fake_client.request = AsyncMock(side_effect=raise_exc)
        else:
            fake_client.request = AsyncMock(return_value=response)
        fake_client.aclose = AsyncMock()

        monkeypatch.setattr(chisel_proxy, "_get_client", lambda: fake_client)

        app = FastAPI()
        app.include_router(chisel_proxy.router)

        # Bypass the permission dep — tests focus on proxy logic. The
        # router captured the original callable at import time; FastAPI's
        # dependency_overrides hook is the supported way to swap it.
        async def _allow():
            return None

        app.dependency_overrides[chisel_proxy._require_chisel_perm] = _allow
        return app, fake_client
    return _build


def _client_with(app: FastAPI) -> TestClient:
    return TestClient(app)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_get_tools_passes_through(app_factory):
    app, fake = app_factory(
        response=_fake_response(200, {"tools": [{"name": "search_crm"}]}),
    )
    resp = _client_with(app).get("/api/chisel/tools", headers={"X-User-Email": "rm@pursuit.org"})
    assert resp.status_code == 200
    assert resp.json() == {"tools": [{"name": "search_crm"}]}
    # Pebble call site received the user header
    call = fake.request.call_args
    assert call.kwargs["headers"].get("X-User-Email") == "rm@pursuit.org"
    assert call.args[0] == "GET"
    assert call.args[1] == "/api/chisel/tools"


def test_get_tool_detail_path_param(app_factory):
    app, fake = app_factory(
        response=_fake_response(200, {"unit": {"name": "search_crm"}}),
    )
    resp = _client_with(app).get("/api/chisel/tools/search_crm")
    assert resp.status_code == 200
    assert fake.request.call_args.args[1] == "/api/chisel/tools/search_crm"


def test_post_validate_forwards_body(app_factory):
    app, fake = app_factory(
        response=_fake_response(200, {"ok": True, "issues": []}),
    )
    body = {"kind": "tool", "manifest_yaml": "name: x\ndescription: y\n"}
    resp = _client_with(app).post("/api/chisel/validate", json=body)
    assert resp.status_code == 200
    assert fake.request.call_args.args[0] == "POST"
    assert fake.request.call_args.kwargs["json"] == body


def test_post_reload_no_body(app_factory):
    app, fake = app_factory(
        response=_fake_response(200, {"loaded_tools": ["x"]}),
    )
    resp = _client_with(app).post("/api/chisel/reload")
    assert resp.status_code == 200
    assert fake.request.call_args.kwargs["json"] is None


def test_post_eval_empty_body_treated_as_empty(app_factory):
    app, fake = app_factory(
        response=_fake_response(200, {"total": 0, "results": []}),
    )
    resp = _client_with(app).post("/api/chisel/eval")
    assert resp.status_code == 200
    assert fake.request.call_args.kwargs["json"] == {}


def test_pebble_error_status_passes_through(app_factory):
    app, _ = app_factory(
        response=_fake_response(404, {"detail": "tool not found"}),
    )
    resp = _client_with(app).get("/api/chisel/tools/nope")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "tool not found"}


def test_pebble_unreachable_returns_502(app_factory):
    app, _ = app_factory(
        response=None,
        raise_exc=httpx.ConnectError("connection refused"),
    )
    resp = _client_with(app).get("/api/chisel/health")
    assert resp.status_code == 502
    body = resp.json()
    assert "pebble unreachable" in body["detail"]
    assert "ConnectError" in body["detail"]


def test_trace_id_propagated_when_provided(app_factory):
    app, fake = app_factory(
        response=_fake_response(200, {"ok": True}),
    )
    _client_with(app).get(
        "/api/chisel/health",
        headers={"X-User-Email": "x@y", "X-Trace-Id": "abc-123"},
    )
    headers = fake.request.call_args.kwargs["headers"]
    assert headers.get("X-Trace-Id") == "abc-123"


@pytest.mark.asyncio
async def test_close_shuts_singleton():
    """close() awaits aclose() on the active client and clears the slot."""
    fake = MagicMock()
    fake.is_closed = False
    fake.aclose = AsyncMock()
    chisel_proxy._client = fake
    await chisel_proxy.close()
    fake.aclose.assert_awaited_once()
    assert chisel_proxy._client is None
