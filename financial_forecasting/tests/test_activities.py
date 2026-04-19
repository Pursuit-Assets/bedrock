"""Tests for Activities router — CRUD, search, sync, soft delete, auth enforcement."""

import sys
import os
import json
import uuid
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient
from main import app, get_current_user
from auth import require_auth
from db import get_db
from dependencies import get_mcp_client, get_data_sync_service
from conftest import make_activity

app.router.on_startup.clear()
app.router.on_shutdown.clear()

TEST_USER = {"user_id": "test_user", "email": "test@pursuit.org", "name": "Test"}
ACTIVITY_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"


class MockDBRow(dict):
    """Dict subclass that allows attribute access (mimics asyncpg Record)."""
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_db():
    """Mock DB with admin permissions for check_permission gates."""
    all_perms = json.dumps({
        "view_tasks": True, "create_tasks": True, "trigger_data_sync": True,
        "view_opportunities": True, "edit_own_opportunities": True,
        "manage_users_roles": True,
    })
    admin_row = {
        "id": "test-id", "sf_user_id": "005TESTOWNER00001", "email": "test@pursuit.org",
        "name": "Test", "is_active": True, "permissions": all_perms, "profile_name": "Admin",
    }

    async def smart_fetchrow(query, *args):
        if "app_user" in query or "permission" in query.lower():
            return admin_row
        if "bedrock.activity" in query:
            return MockDBRow(make_activity())
        return None

    db = AsyncMock()
    db.fetch = AsyncMock(return_value=[MockDBRow(make_activity())])
    db.fetchrow = AsyncMock(side_effect=smart_fetchrow)
    db.fetchval = AsyncMock(return_value=5)
    db.execute = AsyncMock(return_value="UPDATE 1")
    return db


@pytest.fixture
def mock_sync_service():
    svc = AsyncMock()
    svc.sync_activities = AsyncMock()
    svc.sync_all_data = AsyncMock()
    return svc


@pytest.fixture
def mock_mcp_client():
    client = MagicMock()
    sf = AsyncMock()
    sf.query = AsyncMock(return_value={"totalSize": 100, "records": []})
    sf.query_all = AsyncMock(return_value={"records": []})
    client.salesforce = sf
    client.services = {"salesforce": sf}
    client._connected_services = {"salesforce"}
    client.connected_services = {"salesforce"}  # public alias — see conftest.py:326-333
    return client


@pytest.fixture
def authed_client(mock_db, mock_sync_service, mock_mcp_client):
    """Authenticated client with all dependencies overridden."""
    app.dependency_overrides[get_current_user] = lambda: TEST_USER
    app.dependency_overrides[require_auth] = lambda: TEST_USER
    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_mcp_client] = lambda: mock_mcp_client
    app.dependency_overrides[get_data_sync_service] = lambda: mock_sync_service
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def unauthed_client(mock_db, mock_sync_service, mock_mcp_client):
    """No auth override — tests 401 enforcement.
    MCP/sync/db overrides still needed so endpoints don't 503 before auth check.
    """
    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_mcp_client] = lambda: mock_mcp_client
    app.dependency_overrides[get_data_sync_service] = lambda: mock_sync_service
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()


# ===========================================================================
# AUTH ENFORCEMENT — all 11 endpoints must return 401 without authentication
# ===========================================================================

class TestActivitiesAuthEnforcement:
    """Every activities endpoint must return 401 without authentication."""

    def test_sync_count_requires_auth(self, unauthed_client):
        assert unauthed_client.post("/api/activities/sync/count").status_code == 401

    def test_sync_trigger_requires_auth(self, unauthed_client):
        assert unauthed_client.post("/api/activities/sync/trigger").status_code == 401

    def test_sync_status_requires_auth(self, unauthed_client):
        assert unauthed_client.get("/api/activities/sync/status").status_code == 401

    def test_search_requires_auth(self, unauthed_client):
        assert unauthed_client.get("/api/activities/search?q=test").status_code == 401

    def test_match_context_requires_auth(self, unauthed_client):
        assert unauthed_client.get("/api/activities/match-context?email=a@b.com").status_code == 401

    def test_insights_requires_auth(self, unauthed_client):
        assert unauthed_client.post("/api/activities/insights?opportunity_id=006TEST").status_code == 401

    def test_list_requires_auth(self, unauthed_client):
        assert unauthed_client.get("/api/activities/").status_code == 401

    def test_create_requires_auth(self, unauthed_client):
        resp = unauthed_client.post("/api/activities/", json={
            "type": "note", "subject": "Test", "activity_date": "2026-03-15T10:00:00", "source": "manual",
        })
        assert resp.status_code == 401

    def test_get_by_id_requires_auth(self, unauthed_client):
        assert unauthed_client.get(f"/api/activities/{ACTIVITY_ID}").status_code == 401

    def test_update_requires_auth(self, unauthed_client):
        resp = unauthed_client.put(f"/api/activities/{ACTIVITY_ID}", json={"subject": "Updated"})
        assert resp.status_code == 401

    def test_delete_requires_auth(self, unauthed_client):
        assert unauthed_client.delete(f"/api/activities/{ACTIVITY_ID}").status_code == 401


# ===========================================================================
# CRUD — List, Get, Create, Update
# ===========================================================================

class TestActivityCRUD:
    """CRUD operations on activities."""

    def test_list_activities(self, authed_client, mock_db):
        resp = authed_client.get("/api/activities/")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert isinstance(body["data"], list)
        assert "total" in body["meta"]

    def test_list_with_filters(self, authed_client, mock_db):
        resp = authed_client.get("/api/activities/?opportunity_id=006TEST&type=call&limit=10")
        assert resp.status_code == 200
        # Verify the fetch was called (filter params get passed to SQL)
        assert mock_db.fetch.called

    def test_get_activity(self, authed_client, mock_db):
        resp = authed_client.get(f"/api/activities/{ACTIVITY_ID}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == ACTIVITY_ID

    def test_get_activity_not_found(self, authed_client, mock_db):
        # Override fetchrow to return None for activity queries
        original = mock_db.fetchrow.side_effect

        async def return_none_for_activity(query, *args):
            if "bedrock.activity" in query and "app_user" not in query:
                return None
            return await original(query, *args)

        mock_db.fetchrow = AsyncMock(side_effect=return_none_for_activity)
        resp = authed_client.get(f"/api/activities/{ACTIVITY_ID}")
        assert resp.status_code == 404

    def test_get_activity_invalid_uuid(self, authed_client):
        resp = authed_client.get("/api/activities/not-a-uuid")
        assert resp.status_code == 400

    def test_create_activity(self, authed_client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=MockDBRow(make_activity({
            "id": uuid.uuid4(),
            "type": "note",
            "subject": "New note",
            "source": "manual",
            "activity_date": datetime(2026, 3, 20),
        })))
        resp = authed_client.post("/api/activities/", json={
            "type": "note",
            "subject": "New note",
            "activity_date": "2026-03-20T10:00:00",
            "source": "manual",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True

    def test_create_activity_missing_required(self, authed_client):
        resp = authed_client.post("/api/activities/", json={"subject": "Missing type"})
        assert resp.status_code == 422

    def test_update_activity(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        resp = authed_client.put(f"/api/activities/{ACTIVITY_ID}", json={
            "subject": "Updated subject",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True

    def test_update_no_fields(self, authed_client):
        resp = authed_client.put(f"/api/activities/{ACTIVITY_ID}", json={})
        assert resp.status_code == 400

    def test_update_not_found(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 0")
        resp = authed_client.put(f"/api/activities/{ACTIVITY_ID}", json={"subject": "X"})
        assert resp.status_code == 404


# ===========================================================================
# SOFT DELETE — never hard deletes
# ===========================================================================

class TestActivitySoftDelete:
    """Soft delete sets deleted_at; GET returns 404 after delete."""

    def test_soft_delete(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        resp = authed_client.delete(f"/api/activities/{ACTIVITY_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        # Verify SQL used SET deleted_at, not DELETE FROM
        call_args = mock_db.execute.call_args
        assert "deleted_at" in call_args[0][0]
        assert "DELETE FROM" not in call_args[0][0].upper()

    def test_double_delete_returns_404(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 0")
        resp = authed_client.delete(f"/api/activities/{ACTIVITY_ID}")
        assert resp.status_code == 404

    def test_delete_invalid_uuid(self, authed_client):
        resp = authed_client.delete("/api/activities/not-a-uuid")
        assert resp.status_code == 400


# ===========================================================================
# SEARCH — full-text search
# ===========================================================================

class TestActivitySearch:
    """Full-text search on activities."""

    def test_search(self, authed_client, mock_db):
        mock_db.fetch = AsyncMock(return_value=[MockDBRow(make_activity())])
        resp = authed_client.get("/api/activities/search?q=grant+proposal")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)

    def test_search_empty_results(self, authed_client, mock_db):
        mock_db.fetch = AsyncMock(return_value=[])
        resp = authed_client.get("/api/activities/search?q=nonexistent")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_search_requires_query(self, authed_client):
        resp = authed_client.get("/api/activities/search")
        assert resp.status_code == 422

    def test_search_with_scope(self, authed_client, mock_db):
        mock_db.fetch = AsyncMock(return_value=[])
        resp = authed_client.get("/api/activities/search?q=test&opportunity_id=006TEST")
        assert resp.status_code == 200
        # Verify SQL included opportunity_id filter
        call_args = mock_db.fetch.call_args
        assert "opportunity_id" in call_args[0][0]


# ===========================================================================
# SYNC — trigger, status, lock
# ===========================================================================

class TestActivitySync:
    """Sync trigger, status, and lock conflict."""

    def test_sync_status(self, authed_client, mock_db):
        # fetchval is called 4 times: total (int), last_sync (datetime|None), pending (int), sf_count (int)
        mock_db.fetchval = AsyncMock(side_effect=[42, None, 0, 30])
        resp = authed_client.get("/api/activities/sync/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["data"]["total_activities"] == 42
        assert body["data"]["last_sync"] is None
        assert body["data"]["sf_synced"] == 30

    def test_sync_trigger(self, authed_client, mock_sync_service):
        resp = authed_client.post("/api/activities/sync/trigger")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert "triggered_by" in body["meta"]

    def test_sync_trigger_conflict(self, authed_client):
        with patch("routes.activities._sync_lock") as mock_lock:
            mock_lock.locked.return_value = True
            resp = authed_client.post("/api/activities/sync/trigger")
        assert resp.status_code == 409
        assert "already in progress" in resp.json()["detail"]

    def test_sync_count(self, authed_client, mock_mcp_client):
        resp = authed_client.post("/api/activities/sync/count")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert "task_count" in body["data"]
        assert "event_count" in body["data"]


# ===========================================================================
# INSIGHTS — AI analysis with graceful degradation
# ===========================================================================

class TestActivityInsights:
    """AI insights endpoint with structured output and fallback."""

    def test_insights_no_api_key(self, authed_client):
        with patch("routes.activities.ANTHROPIC_API_KEY", None):
            resp = authed_client.post("/api/activities/insights?opportunity_id=006TEST")
        assert resp.status_code == 503
        assert "ANTHROPIC_API_KEY" in resp.json()["detail"]

    def test_insights_no_activities(self, authed_client, mock_db):
        mock_db.fetch = AsyncMock(return_value=[])
        with patch("routes.activities.ANTHROPIC_API_KEY", "test-key"):
            resp = authed_client.post("/api/activities/insights?opportunity_id=006TEST")
        assert resp.status_code == 200
        body = resp.json()
        assert body["confidence"] == "none"
        assert "No activities found" in body["summary"]

    def test_insights_requires_entity(self, authed_client):
        with patch("routes.activities.ANTHROPIC_API_KEY", "test-key"):
            resp = authed_client.post("/api/activities/insights")
        assert resp.status_code == 400

    def test_insights_structured_response(self, authed_client, mock_db):
        mock_db.fetch = AsyncMock(return_value=[MockDBRow(make_activity())])
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text=json.dumps({
            "summary": "Strong engagement pattern",
            "key_findings": ["Weekly calls", "Proposal under review"],
            "action_items": ["Follow up on proposal"],
            "momentum": "increasing",
        }))]

        with patch("routes.activities.ANTHROPIC_API_KEY", "test-key"), \
             patch("anthropic.Anthropic") as MockAnthropic:
            MockAnthropic.return_value.messages.create.return_value = mock_response
            resp = authed_client.post("/api/activities/insights?opportunity_id=006TEST")

        assert resp.status_code == 200
        body = resp.json()
        assert body["confidence"] == "structured"
        assert body["momentum"] == "increasing"
        assert len(body["key_findings"]) == 2

    def test_insights_graceful_degradation(self, authed_client, mock_db):
        """When AI returns non-JSON, falls back to raw text."""
        mock_db.fetch = AsyncMock(return_value=[MockDBRow(make_activity())])
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text="Some non-JSON analysis text")]

        with patch("routes.activities.ANTHROPIC_API_KEY", "test-key"), \
             patch("anthropic.Anthropic") as MockAnthropic:
            MockAnthropic.return_value.messages.create.return_value = mock_response
            resp = authed_client.post("/api/activities/insights?opportunity_id=006TEST")

        assert resp.status_code == 200
        body = resp.json()
        assert body["confidence"] == "raw"
        assert "non-JSON" in body["summary"]
