"""Tests for Progress-page visibility override.

Covers:
- GET /api/progress-tracking/users — auth-gated enrichment of SF users with
  the Bedrock override flag (absence of a row = is_tracked=true)
- PUT /api/progress-tracking/overrides/{sf_user_id} — admin-gated upsert
  with actor audit in the updated_by_email column
"""

import sys
import os
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient

from main import app, get_current_user
from main import get_mcp_client as main_get_mcp_client
from dependencies import get_mcp_client as deps_get_mcp_client
from auth import require_auth
from db import get_db

# Reuse the permission fixtures' shape so we stay consistent with other suites.
from test_permissions import (
    TEST_USER, MockDBRow, make_admin_user, make_rm_user,
)

# Disable startup/shutdown
app.router.on_startup.clear()
app.router.on_shutdown.clear()


# ---------------------------------------------------------------------------
# SF User fixtures — two real people, one service account ("bot").
# ---------------------------------------------------------------------------

# 18-char Salesforce IDs (3-char object prefix + 15-char body) — the format
# security.validate_salesforce_id enforces on every PUT.
SF_USER_A = {"Id": "005AAAAAAAAAAAAAAA", "Name": "Alice Example", "Email": "alice@pursuit.org", "IsActive": True}
SF_USER_B = {"Id": "005BBBBBBBBBBBBBBB", "Name": "Bob Example",   "Email": "bob@pursuit.org",   "IsActive": True}
SF_BOT    = {"Id": "005CCCCCCCCCCCCCCC", "Name": "Slackbot",      "Email": None,                "IsActive": True}


# ---------------------------------------------------------------------------
# Shared fixtures (mirror test_permissions.py)
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_db():
    db = AsyncMock()
    db.fetch = AsyncMock(return_value=[])
    db.fetchrow = AsyncMock(return_value=make_admin_user())
    db.fetchval = AsyncMock(return_value=0)
    db.execute = AsyncMock(return_value="INSERT 0 1")
    return db


@pytest.fixture
def mock_client():
    """MCP client with Salesforce present and a mockable .query()."""
    client = MagicMock()
    client.connected_services = ["salesforce"]
    client.salesforce = MagicMock()
    client.salesforce.query = AsyncMock(return_value={
        "records": [SF_USER_A, SF_USER_B, SF_BOT],
    })
    client.disconnect_all = AsyncMock()
    return client


def _override_deps(mock_db, mock_client):
    app.dependency_overrides[get_current_user] = lambda: TEST_USER
    app.dependency_overrides[require_auth] = lambda: TEST_USER
    app.dependency_overrides[get_db] = lambda: mock_db
    # Routes import from `dependencies` directly (the 503-raising version);
    # main.py also exposes a shim. Override both so either import path
    # resolves to the mock.
    app.dependency_overrides[deps_get_mcp_client] = lambda: mock_client
    app.dependency_overrides[main_get_mcp_client] = lambda: mock_client


@pytest.fixture
def admin_client(mock_db, mock_client):
    """Authenticated as an Admin — require_admin resolves via mock_db.fetchrow."""
    _override_deps(mock_db, mock_client)
    # The users-list cache is process-global — clear it before each test so
    # PUT-then-GET assertions see the fresh state instead of a stale return
    # from a previous test. The cache is owned by the endpoint module, not
    # the test, so we import and invalidate.
    from routes.progress_tracking import _CACHE_KEY_USERS
    from services.cache import cache
    cache.invalidate(_CACHE_KEY_USERS)
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def rm_client(mock_db, mock_client):
    """Authenticated as a Relationship Manager (non-admin, lacks manage_users_roles)."""
    mock_db.fetchrow = AsyncMock(return_value=make_rm_user())
    _override_deps(mock_db, mock_client)
    from routes.progress_tracking import _CACHE_KEY_USERS
    from services.cache import cache
    cache.invalidate(_CACHE_KEY_USERS)
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()


# ===========================================================================
# GET /api/progress-tracking/users
# ===========================================================================


class TestGetProgressTrackedUsers:
    def test_returns_is_tracked_true_when_no_override(self, admin_client, mock_db):
        """Every SF user appears with is_tracked=true when no overrides exist."""
        mock_db.fetch = AsyncMock(return_value=[])  # no overrides
        resp = admin_client.get("/api/progress-tracking/users")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 3
        for row in data:
            assert row["is_tracked"] is True
        # Shape check
        assert data[0]["sf_user_id"] == SF_USER_A["Id"]
        assert data[0]["name"] == SF_USER_A["Name"]
        assert data[0]["email"] == SF_USER_A["Email"]
        assert data[0]["is_active"] is True

    def test_returns_is_tracked_false_for_overridden_user(self, admin_client, mock_db):
        """When an override row says is_tracked=false, that user's payload reflects it."""
        mock_db.fetch = AsyncMock(return_value=[
            MockDBRow(sf_user_id=SF_BOT["Id"], is_tracked=False),
        ])
        resp = admin_client.get("/api/progress-tracking/users")
        assert resp.status_code == 200
        by_id = {r["sf_user_id"]: r for r in resp.json()}
        assert by_id[SF_USER_A["Id"]]["is_tracked"] is True
        assert by_id[SF_USER_B["Id"]]["is_tracked"] is True
        assert by_id[SF_BOT["Id"]]["is_tracked"] is False

    def test_includes_sf_users_without_bedrock_state(self, admin_client, mock_db):
        """SF service accounts (bots) that have no org_users row still appear on the list."""
        mock_db.fetch = AsyncMock(return_value=[])
        resp = admin_client.get("/api/progress-tracking/users")
        data = resp.json()
        sf_ids = {r["sf_user_id"] for r in data}
        assert SF_BOT["Id"] in sf_ids

    def test_returns_empty_when_salesforce_disconnected(self, admin_client, mock_client):
        """Graceful empty list when SF isn't in connected_services — avoids 500."""
        mock_client.connected_services = []
        resp = admin_client.get("/api/progress-tracking/users")
        assert resp.status_code == 200
        assert resp.json() == []


# ===========================================================================
# PUT /api/progress-tracking/overrides/{sf_user_id}
# ===========================================================================


class TestPutOverride:
    def test_admin_can_upsert_override(self, admin_client, mock_db):
        """Admin can set is_tracked=false on a valid SF user ID."""
        resp = admin_client.put(
            f"/api/progress-tracking/overrides/{SF_BOT['Id']}",
            json={"is_tracked": False},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["sf_user_id"] == SF_BOT["Id"]
        assert body["is_tracked"] is False
        assert body["updated_by_email"] == TEST_USER["email"]
        # Single INSERT ... ON CONFLICT statement should fire
        assert mock_db.execute.await_count == 1
        # Verify the statement starts with INSERT and binds the expected args
        call_args = mock_db.execute.await_args
        assert "INSERT INTO bedrock.progress_tracked_override" in call_args.args[0]
        assert call_args.args[1] == SF_BOT["Id"]       # $1 sf_user_id
        assert call_args.args[2] is False              # $2 is_tracked
        assert call_args.args[3] == TEST_USER["email"] # $3 updated_by_email

    def test_admin_can_toggle_back_to_tracked(self, admin_client, mock_db):
        """Second PUT updates the existing row via the ON CONFLICT branch."""
        # First: hide
        r1 = admin_client.put(
            f"/api/progress-tracking/overrides/{SF_BOT['Id']}",
            json={"is_tracked": False},
        )
        assert r1.status_code == 200
        # Second: unhide
        r2 = admin_client.put(
            f"/api/progress-tracking/overrides/{SF_BOT['Id']}",
            json={"is_tracked": True},
        )
        assert r2.status_code == 200
        assert r2.json()["is_tracked"] is True
        assert mock_db.execute.await_count == 2

    def test_non_admin_is_blocked(self, rm_client, mock_db):
        """Non-admin (Relationship Manager) receives 403 from require_admin."""
        resp = rm_client.put(
            f"/api/progress-tracking/overrides/{SF_BOT['Id']}",
            json={"is_tracked": False},
        )
        assert resp.status_code == 403
        # No DB write should have been attempted
        assert mock_db.execute.await_count == 0

    def test_invalid_sf_user_id_rejected(self, admin_client, mock_db):
        """Malformed SF IDs are rejected before hitting the DB (400)."""
        resp = admin_client.put(
            "/api/progress-tracking/overrides/not-a-real-sf-id",
            json={"is_tracked": False},
        )
        assert resp.status_code == 400
        assert mock_db.execute.await_count == 0

    def test_missing_body_field_rejected(self, admin_client, mock_db):
        """FastAPI/Pydantic rejects the request when `is_tracked` is missing."""
        resp = admin_client.put(
            f"/api/progress-tracking/overrides/{SF_BOT['Id']}",
            json={},
        )
        assert resp.status_code == 422
        assert mock_db.execute.await_count == 0
