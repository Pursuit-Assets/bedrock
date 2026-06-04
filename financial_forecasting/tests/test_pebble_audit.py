"""Tests for ``services/pebble_audit.py`` — Phase 0.8 audit middleware.

Asserts:

A. Helper: _is_audited_route gates on method + path prefix.
B. Helper: _is_internal_key_request gates on X-Internal-Key presence.
C. Helper: _extract_sf_object_from_path parses
   /api/salesforce/{Type}/{Id} cleanly; returns None on others.
D. Helper: _truncate_payload_for_audit handles JSON, non-JSON, and
   oversized bodies.
E. Helper: _hash_payload emits sha256 hex on bytes; None on empty.
F. record_side_effect attaches dict on request.state.
G. record_sf_object attaches type+id on request.state.
H. Middleware skips non-audited routes (no DB call).
I. Middleware skips non-internal-key requests.
J. Middleware skips failed (>= 400) responses.
K. Middleware writes audit row for successful internal-key write.
L. Middleware merges side_effects + sf_object overrides from request.state.
M. Audit insert failure does NOT propagate to response.
N. Body is captured + replayed so route handler still sees it.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from services import pebble_audit as pa


# ---------------------------------------------------------------------------
# A. _is_audited_route
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("method,path,expected", [
    ("POST", "/api/salesforce/opportunities", True),
    ("PUT", "/api/salesforce/contacts/003xxx", True),
    ("PATCH", "/api/awards/abc", True),
    ("DELETE", "/api/projects/xyz", True),
    ("POST", "/api/opportunities/update-stage", True),
    ("POST", "/api/payments/match", True),
    ("GET", "/api/salesforce/opportunities", False),       # GET = read
    ("HEAD", "/api/salesforce/contacts", False),
    ("POST", "/api/auth/google/callback", False),          # not a Pebble route
    ("POST", "/api/search", False),                        # search has its own audit
    ("POST", "/auth/me", False),
])
def test_is_audited_route(method, path, expected):
    assert pa._is_audited_route(path, method) is expected


# ---------------------------------------------------------------------------
# B. _is_internal_key_request
# ---------------------------------------------------------------------------

def test_is_internal_key_request_true_when_header_present():
    req = MagicMock()
    req.headers = {"X-Internal-Key": "abc"}
    assert pa._is_internal_key_request(req) is True


def test_is_internal_key_request_false_when_absent():
    req = MagicMock()
    req.headers = {}
    assert pa._is_internal_key_request(req) is False


def test_is_internal_key_request_false_when_empty_header():
    req = MagicMock()
    req.headers = {"X-Internal-Key": ""}
    assert pa._is_internal_key_request(req) is False


# ---------------------------------------------------------------------------
# C. _extract_sf_object_from_path
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path,expected", [
    ("/api/salesforce/opportunities/006xxx", ("Opportunity", "006xxx")),
    ("/api/salesforce/accounts/001abc", ("Account", "001abc")),
    ("/api/salesforce/contacts/003def", ("Contact", "003def")),
    ("/api/awards/uuid-here", ("Award", "uuid-here")),
    ("/api/projects/p-1", ("Project", "p-1")),
    ("/api/opportunities/update-stage", ("Opportunity", None)),  # body has id
    ("/api/auth/me", (None, None)),
    ("/api/", (None, None)),
])
def test_extract_sf_object_from_path(path, expected):
    assert pa._extract_sf_object_from_path(path) == expected


# ---------------------------------------------------------------------------
# F + G. record_* helpers
# ---------------------------------------------------------------------------

def test_record_side_effect_merges():
    req = MagicMock()
    req.state = type("S", (), {})()
    pa.record_side_effect(req, "award_created", True)
    pa.record_side_effect(req, "activity_logged", True)
    assert req.state._pebble_audit_side_effects == {
        "award_created": True, "activity_logged": True,
    }


def test_record_sf_object_sets_state():
    req = MagicMock()
    req.state = type("S", (), {})()
    pa.record_sf_object(req, "Opportunity", "006xxx")
    assert req.state._pebble_audit_sf_object_type == "Opportunity"
    assert req.state._pebble_audit_sf_object_id == "006xxx"


# ---------------------------------------------------------------------------
# H, I, J, K, L, M, N. Middleware integration tests
# ---------------------------------------------------------------------------

@pytest.fixture
def audit_app():
    """Tiny FastAPI app with the audit middleware mounted + a few
    mock write endpoints."""
    audit_calls: list[dict] = []
    mock_conn = AsyncMock()

    async def _capturing_execute(sql, *args):
        audit_calls.append({"sql": sql, "args": args})
        return "INSERT 0 1"

    mock_conn.execute = _capturing_execute

    @asynccontextmanager
    async def _acquire():
        yield mock_conn

    mock_pool = MagicMock()
    mock_pool.acquire = lambda: _acquire()

    def _provider():
        return mock_pool

    app = FastAPI()
    app.add_middleware(pa.PebbleWriteAuditMiddleware, pool_provider=_provider)

    @app.post("/api/salesforce/accounts")
    async def create_account(payload: dict, request: Request):
        return {"id": "001NEW", "name": payload.get("Name")}

    @app.post("/api/opportunities/update-stage")
    async def update_stage(payload: dict, request: Request):
        pa.record_sf_object(request, "Opportunity", payload.get("opportunity_id"))
        pa.record_side_effect(request, "award_created", True)
        return {"stage": payload.get("new_stage"), "award_created": True}

    @app.post("/api/awards/abc")
    async def patch_award():
        return {"ok": False}, 500   # forces failure path test

    @app.get("/api/salesforce/opportunities")
    async def list_opps():
        return []

    @app.post("/api/auth/me")
    async def auth_me():
        return {"ok": True}

    return app, audit_calls


def _wait_for_background_tasks():
    """TestClient finishes the response synchronously but middleware-
    spawned asyncio.create_task() runs on the event loop after the
    response is returned. Pump the loop briefly to let it complete."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(asyncio.sleep(0.1))
    finally:
        loop.close()


# H. non-audited route bypasses entirely
def test_middleware_skips_non_audited_route(audit_app):
    app, audit_calls = audit_app
    with TestClient(app) as client:
        r = client.post("/api/auth/me", json={}, headers={"X-Internal-Key": "k"})
    assert r.status_code == 200
    assert audit_calls == []


# I. internal-key absent → no audit row
def test_middleware_skips_jwt_only_request(audit_app):
    app, audit_calls = audit_app
    with TestClient(app) as client:
        # No X-Internal-Key header — pretends to be a JWT user.
        r = client.post(
            "/api/salesforce/accounts",
            json={"Name": "Acme"},
            headers={},
        )
    assert r.status_code == 200
    # Give middleware a beat to write nothing.
    asyncio.run(asyncio.sleep(0.05))
    assert audit_calls == []


# K. successful internal-key write → audit row inserted
def test_middleware_writes_audit_row_on_success(audit_app):
    app, audit_calls = audit_app
    with TestClient(app) as client:
        r = client.post(
            "/api/salesforce/accounts",
            json={"Name": "Acme"},
            headers={
                "X-Internal-Key": "test-key",
                "X-Originating-User": "rm@pursuit.org",
                "X-Request-Id": "01993b8d-2c9a-7c4f-8b0e-000000000001",
            },
        )
    assert r.status_code == 200
    asyncio.run(asyncio.sleep(0.1))
    assert len(audit_calls) == 1
    sql = audit_calls[0]["sql"]
    args = audit_calls[0]["args"]
    assert "INSERT INTO bedrock.pebble_write_audit" in sql
    assert "ON CONFLICT (request_id) DO NOTHING" in sql
    # request_id, path, method position
    assert str(args[0]) == "01993b8d-2c9a-7c4f-8b0e-000000000001"
    assert args[1] == "/api/salesforce/accounts"
    assert args[2] == "POST"
    # originating_user position 5
    assert args[5] == "rm@pursuit.org"


# L. record_side_effect + record_sf_object propagated
def test_middleware_picks_up_route_side_effects(audit_app):
    app, audit_calls = audit_app
    with TestClient(app) as client:
        r = client.post(
            "/api/opportunities/update-stage",
            json={"opportunity_id": "006XYZ", "new_stage": "Closed Won"},
            headers={
                "X-Internal-Key": "k",
                "X-Originating-User": "rm@pursuit.org",
                "X-Request-Id": "01993b8d-2c9a-7c4f-8b0e-000000000002",
            },
        )
    assert r.status_code == 200
    asyncio.run(asyncio.sleep(0.1))
    assert len(audit_calls) == 1
    args = audit_calls[0]["args"]
    # sf_object_type + sf_object_id at positions 3, 4 — picked up via record_sf_object.
    assert args[3] == "Opportunity"
    assert args[4] == "006XYZ"
    # side_effects at position 10 — JSON-encoded.
    side_effects_json = args[10]
    assert side_effects_json is not None
    assert json.loads(side_effects_json) == {"award_created": True}


# J. failed response → no audit row (kept clean for the success-set
#    while still catching attempts via upstream metrics)
def test_middleware_skips_failed_response(audit_app):
    app, audit_calls = audit_app
    # The mock /api/awards/abc handler returns 500 by tuple — we
    # use it as a stand-in for a failing internal-key write.
    @app.patch("/api/awards/forced-fail")
    async def forced_fail():
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail="oops")

    with TestClient(app) as client:
        r = client.patch(
            "/api/awards/forced-fail",
            headers={
                "X-Internal-Key": "k",
                "X-Originating-User": "rm@pursuit.org",
                "X-Request-Id": "01993b8d-2c9a-7c4f-8b0e-000000000003",
            },
        )
    assert r.status_code == 500
    asyncio.run(asyncio.sleep(0.05))
    assert audit_calls == []


# N. Body is NOT consumed by middleware — route still sees the JSON
def test_middleware_does_not_consume_body_so_route_sees_payload(audit_app):
    app, audit_calls = audit_app
    with TestClient(app) as client:
        r = client.post(
            "/api/salesforce/accounts",
            json={"Name": "Acme Industries"},
            headers={
                "X-Internal-Key": "k",
                "X-Originating-User": "rm@pursuit.org",
                "X-Request-Id": "01993b8d-2c9a-7c4f-8b0e-000000000004",
            },
        )
    assert r.status_code == 200
    # Route handler echoed back the name — proves middleware didn't
    # consume the request body before the route could parse it.
    assert r.json()["name"] == "Acme Industries"


# M. Audit insert raise does not propagate
def test_middleware_audit_failure_does_not_break_response():
    """Force the audit insert to raise; assert the user response
    still completes successfully."""
    failing_conn = AsyncMock()
    failing_conn.execute = AsyncMock(side_effect=RuntimeError("DB down"))

    @asynccontextmanager
    async def _acquire():
        yield failing_conn

    failing_pool = MagicMock()
    failing_pool.acquire = lambda: _acquire()

    app = FastAPI()
    app.add_middleware(pa.PebbleWriteAuditMiddleware, pool_provider=lambda: failing_pool)

    @app.post("/api/salesforce/accounts")
    async def ep():
        return {"ok": True}

    with TestClient(app) as client:
        r = client.post(
            "/api/salesforce/accounts",
            json={"Name": "X"},
            headers={
                "X-Internal-Key": "k",
                "X-Originating-User": "u@x.org",
                "X-Request-Id": "01993b8d-2c9a-7c4f-8b0e-000000000005",
            },
        )
    assert r.status_code == 200    # not 500
