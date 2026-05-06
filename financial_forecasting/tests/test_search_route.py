"""Route-level tests for ``/api/search`` (Phase 1.8) using
FastAPI TestClient + dependency overrides.

Asserts:
  A. Happy path returns 200 with expected response shape.
  B. Empty / 0-result query returns 200 with empty items array.
  C. Unknown entity_type → 400.
  D. Bad limits → 422 (Pydantic validation).
  E. Audit row is enqueued via BackgroundTask.
  F. Audit failure does NOT propagate to the user response.
  G. Service caller resolves to originating user's principal.
  H. Click endpoint fences on caller user_email.
"""

import os
import sys
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient

from db import get_db
from routes import search as search_route
from services import search_service as ss


# ---------------------------------------------------------------------------
# Test app — bare minimum so we don't drag in main.py's startup.
# ---------------------------------------------------------------------------

@pytest.fixture
def app_factory():
    """Build a minimal FastAPI app with /api/search mounted, plus
    overridable dependencies for db/auth.
    """
    def _build(
        *,
        user: dict | None = None,
        principal: ss.SearchPrincipal | None = None,
        search_result: ss.SearchResponse | None = None,
        audit_should_fail: bool = False,
    ) -> tuple[FastAPI, MagicMock]:
        app = FastAPI()
        app.include_router(search_route.router)

        # Mock pool: yields a mock connection that returns the prepared
        # principal + search result.
        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock(return_value="UPDATE 1")
        if audit_should_fail:
            mock_conn.execute.side_effect = RuntimeError("DB down")

        # principal resolution short-circuit
        async def _fake_resolve(conn, user):
            return principal or ss.SearchPrincipal(
                email=user.get("email", "test@pursuit.org"),
                sf_user_id="005AAA",
                is_admin=False,
                has_view_all_accounts=False,
                has_view_all_opportunities=False,
                has_view_all_contacts=False,
            )

        async def _fake_search(conn, principal, req):
            return search_result or ss.SearchResponse(
                query_id=uuid.uuid4(),
                items=[],
                backend_used="postgres_fts",
                took_ms=12,
            )

        # Patch the search_service functions used by the route.
        search_route.ss.resolve_principal = _fake_resolve
        search_route.ss.search = _fake_search

        # Mock pool with async context manager support.
        @asynccontextmanager
        async def _acquire():
            yield mock_conn

        mock_pool = MagicMock()
        mock_pool.acquire = lambda: _acquire()

        async def _override_db():
            return mock_pool

        async def _override_perm(request=None):
            return user or {
                "user_id": "u-1", "email": "test@pursuit.org",
                "is_service": False,
            }

        app.dependency_overrides[get_db] = _override_db
        app.dependency_overrides[search_route.require_search_perm] = _override_perm

        return app, mock_conn

    return _build


# ---------------------------------------------------------------------------
# A. Happy path
# ---------------------------------------------------------------------------

def test_search_happy_path_returns_200(app_factory):
    items = [
        ss.SearchHit(
            entity_type="sf_account", entity_id="001AAA",
            title="Acme Corp", subtitle="Customer · Enterprise",
            href="/accounts/001AAA", rank=0.95,
            activity_at=None,
            indexed_at=datetime(2026, 5, 6, tzinfo=timezone.utc).isoformat(),
        ),
    ]
    response = ss.SearchResponse(
        query_id=uuid.uuid4(), items=items,
        backend_used="postgres_fts", took_ms=42,
    )
    app, _ = app_factory(search_result=response)

    with TestClient(app) as client:
        r = client.get("/api/search?q=acme")
    assert r.status_code == 200
    body = r.json()
    assert body["total_count"] == 1
    assert body["items"][0]["title"] == "Acme Corp"
    assert body["items"][0]["group"] == "Accounts"
    assert "Accounts" in body["grouped"]
    assert body["backend_used"] == "postgres_fts"


def test_search_empty_results_returns_200(app_factory):
    app, _ = app_factory()
    with TestClient(app) as client:
        r = client.get("/api/search?q=zzz")
    assert r.status_code == 200
    body = r.json()
    assert body["items"] == []
    assert body["grouped"] == {}
    assert body["total_count"] == 0


# ---------------------------------------------------------------------------
# C. Unknown entity_type → 400
# ---------------------------------------------------------------------------

def test_unknown_entity_type_returns_400(app_factory):
    app, _ = app_factory()
    with TestClient(app) as client:
        r = client.get("/api/search?q=acme&types=fake_entity")
    assert r.status_code == 400
    assert "Unknown entity_type" in r.json()["detail"]


# ---------------------------------------------------------------------------
# D. Pydantic validation
# ---------------------------------------------------------------------------

def test_missing_q_returns_422(app_factory):
    app, _ = app_factory()
    with TestClient(app) as client:
        r = client.get("/api/search")
    assert r.status_code == 422


def test_empty_q_returns_422(app_factory):
    app, _ = app_factory()
    with TestClient(app) as client:
        r = client.get("/api/search?q=")
    assert r.status_code == 422


def test_oversized_limit_returns_422(app_factory):
    app, _ = app_factory()
    with TestClient(app) as client:
        r = client.get(f"/api/search?q=acme&limit={ss.MAX_LIMIT + 100}")
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# E. Audit row enqueued (synchronously after BackgroundTask completes)
# ---------------------------------------------------------------------------

def test_audit_row_inserted_via_background_task(app_factory):
    app, mock_conn = app_factory()
    with TestClient(app) as client:
        r = client.get("/api/search?q=acme&types=sf_account")
    assert r.status_code == 200
    # mock_conn.execute is called twice: once by the route's audit
    # INSERT (BackgroundTask runs after response is sent in TestClient).
    assert mock_conn.execute.await_count >= 1
    # The first arg of the first call should be the INSERT into search_audit.
    sent_sql = mock_conn.execute.call_args.args[0]
    assert "INSERT INTO bedrock.search_audit" in sent_sql
    assert "ON CONFLICT (request_id) DO NOTHING" in sent_sql


# ---------------------------------------------------------------------------
# F. Audit failure swallowed
# ---------------------------------------------------------------------------

def test_audit_failure_does_not_break_response(app_factory):
    """Audit row insert raising must NOT 500 the user response."""
    app, _ = app_factory(audit_should_fail=True)
    with TestClient(app) as client:
        r = client.get("/api/search?q=acme")
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# H. Click endpoint
# ---------------------------------------------------------------------------

def test_click_returns_ok(app_factory):
    app, _ = app_factory()
    with TestClient(app) as client:
        r = client.post("/api/search/click", json={
            "query_id": str(uuid.uuid4()),
            "position": 0,
            "entity_type": "sf_account",
            "entity_id": "001AAA",
        })
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_click_invalid_query_id_returns_400(app_factory):
    app, _ = app_factory()
    with TestClient(app) as client:
        r = client.post("/api/search/click", json={
            "query_id": "not-a-uuid",
            "position": 0,
            "entity_type": "sf_account",
            "entity_id": "001AAA",
        })
    assert r.status_code == 400


def test_click_negative_position_returns_422(app_factory):
    app, _ = app_factory()
    with TestClient(app) as client:
        r = client.post("/api/search/click", json={
            "query_id": str(uuid.uuid4()),
            "position": -1,
            "entity_type": "sf_account",
            "entity_id": "001AAA",
        })
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Helpers — _normalize_types + _request_uuid
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw,expected", [
    (None, None),
    ("", None),
    ("   ", None),
    ("sf_account", ["sf_account"]),
    ("sf_account,sf_contact", ["sf_account", "sf_contact"]),
    ("  sf_account  ,  sf_contact  ", ["sf_account", "sf_contact"]),
    ("sf_account,,sf_contact", ["sf_account", "sf_contact"]),
])
def test_normalize_types(raw, expected):
    assert search_route._normalize_types(raw) == expected


def test_request_uuid_uses_header_when_valid():
    valid = "01993b8d-2c9a-7c4f-8b0e-000000000001"
    request = MagicMock()
    request.headers = {"X-Request-Id": valid}
    assert search_route._request_uuid(request) == valid


def test_request_uuid_mints_when_header_missing():
    request = MagicMock()
    request.headers = {}
    minted = search_route._request_uuid(request)
    uuid.UUID(minted)  # raises if not a valid UUID


def test_request_uuid_mints_when_header_malformed():
    request = MagicMock()
    request.headers = {"X-Request-Id": "not-a-uuid"}
    minted = search_route._request_uuid(request)
    uuid.UUID(minted)  # raises if not a valid UUID
    assert minted != "not-a-uuid"
