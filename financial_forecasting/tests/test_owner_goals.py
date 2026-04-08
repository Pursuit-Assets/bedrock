"""Tests for the owner goals API (Wall of Progress).

Verifies CRUD endpoints, permission gating, and SF user ID validation.
"""

import sys
import os
import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from main import app, get_current_user, get_mcp_client, get_forecasting_engine, get_data_sync_service
from auth import require_auth
from db import get_db

# Disable startup/shutdown events that try to connect to real services
app.router.on_startup.clear()
app.router.on_shutdown.clear()


TEST_USER = {"user_id": "test_user", "name": "Test User", "email": "test@test.org"}
TEST_USER_NON_ADMIN = {"user_id": "rm_user", "name": "RM User", "email": "rm@test.org"}

VALID_SF_USER_ID = "005A0000001IJKLM34"  # 18 chars, valid SF ID format
ANOTHER_SF_USER_ID = "005A0000001NOPQR56"


def _admin_db():
    """Build a mock DB that returns an Admin user for permission checks
    AND can be configured per-test for owner_goal CRUD queries."""
    admin_row = {
        "id": "test-id",
        "sf_user_id": "005TESTOWNER00001",
        "email": "test@test.org",
        "name": "Test",
        "is_active": True,
        "permissions": json.dumps({}),  # Admin auto-grants all keys via permissions.py
        "profile_name": "Admin",
        "org_user_id": None,
    }

    db = AsyncMock()

    # The permissions resolver always uses fetchrow with the SELECT au.id, ... WHERE au.email pattern.
    # Owner goal queries also use fetchrow but with different SQL. The default returns admin_row;
    # tests can override fetchrow.side_effect to return owner-goal-specific rows.
    async def default_fetchrow(query, *args):
        # Permission lookup
        if "FROM bedrock.app_user" in query:
            return admin_row
        # Otherwise None (no row found by default)
        return None

    db.fetch = AsyncMock(return_value=[])
    db.fetchrow = AsyncMock(side_effect=default_fetchrow)
    db.fetchval = AsyncMock(return_value=1)
    db.execute = AsyncMock(return_value="DELETE 0")
    return db


def _non_admin_db():
    """Mock DB that returns a non-admin user with only view permissions."""
    rm_row = {
        "id": "rm-id",
        "sf_user_id": "005A0000001RMUSER",
        "email": "rm@test.org",
        "name": "RM",
        "is_active": True,
        "permissions": json.dumps({
            "view_opportunities": True,
            "view_revenue_dashboard": True,  # can view goals
            # NOT manage_owner_goals — should 403 on PUT/DELETE
        }),
        "profile_name": "Relationship Manager",
        "org_user_id": None,
    }

    db = AsyncMock()

    async def default_fetchrow(query, *args):
        if "FROM bedrock.app_user" in query:
            return rm_row
        return None

    db.fetch = AsyncMock(return_value=[])
    db.fetchrow = AsyncMock(side_effect=default_fetchrow)
    db.fetchval = AsyncMock(return_value=1)
    db.execute = AsyncMock(return_value="DELETE 0")
    return db


@pytest.fixture
def admin_db():
    return _admin_db()


@pytest.fixture
def admin_client(admin_db):
    """TestClient with an admin user override."""
    app.dependency_overrides[get_current_user] = lambda: TEST_USER
    app.dependency_overrides[require_auth] = lambda: TEST_USER
    app.dependency_overrides[get_db] = lambda: admin_db
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def rm_client():
    """TestClient with a non-admin (RM) user — has view perms but not manage."""
    app.dependency_overrides[get_current_user] = lambda: TEST_USER_NON_ADMIN
    app.dependency_overrides[require_auth] = lambda: TEST_USER_NON_ADMIN
    app.dependency_overrides[get_db] = lambda: _non_admin_db()
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()


def _make_goal_row(sf_user_id: str, fiscal_year: int, amount: float):
    return {
        "sf_user_id": sf_user_id,
        "fiscal_year": fiscal_year,
        "goal_amount": amount,
        "notes": "",
        "created_by": "test@test.org",
        "updated_by": "test@test.org",
        "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
    }


# ---------------------------------------------------------------------------
# Cache reset helper — owner_goals routes use a process-level cache. Reset
# between tests so a previous test's cached response doesn't leak.
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def reset_cache():
    from services.cache import cache
    cache.invalidate_prefix("owner_goals:")
    yield
    cache.invalidate_prefix("owner_goals:")


class TestListOwnerGoals:
    def test_returns_empty_when_no_rows(self, admin_client, admin_db):
        admin_db.fetch.return_value = []
        response = admin_client.get("/api/owner-goals", params={"fiscal_year": 2026})
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"] == {}

    def test_returns_goals_keyed_by_sf_user_id(self, admin_client, admin_db):
        admin_db.fetch.return_value = [
            _make_goal_row(VALID_SF_USER_ID, 2026, 2_500_000.0),
            _make_goal_row(ANOTHER_SF_USER_ID, 2026, 1_750_000.0),
        ]
        response = admin_client.get("/api/owner-goals", params={"fiscal_year": 2026})
        assert response.status_code == 200
        body = response.json()
        assert set(body["data"].keys()) == {VALID_SF_USER_ID, ANOTHER_SF_USER_ID}
        assert body["data"][VALID_SF_USER_ID]["goal_amount"] == 2_500_000.0

    def test_requires_fiscal_year_param(self, admin_client):
        response = admin_client.get("/api/owner-goals")
        assert response.status_code == 422  # Pydantic validation error


class TestGetOwnerGoal:
    def test_returns_404_when_missing(self, admin_client, admin_db):
        # Default fetchrow returns None for non-permission queries
        response = admin_client.get(
            f"/api/owner-goals/{VALID_SF_USER_ID}", params={"fiscal_year": 2026}
        )
        assert response.status_code == 404

    def test_returns_row_when_present(self, admin_client, admin_db):
        admin_row = _admin_db_admin_row()

        async def fetchrow_with_goal(query, *args):
            if "FROM bedrock.app_user" in query:
                return admin_row
            if "FROM bedrock.owner_goal" in query:
                return _make_goal_row(VALID_SF_USER_ID, 2026, 3_000_000.0)
            return None

        admin_db.fetchrow.side_effect = fetchrow_with_goal
        response = admin_client.get(
            f"/api/owner-goals/{VALID_SF_USER_ID}", params={"fiscal_year": 2026}
        )
        assert response.status_code == 200
        assert response.json()["data"]["goal_amount"] == 3_000_000.0

    def test_invalid_sf_user_id_returns_400(self, admin_client):
        response = admin_client.get(
            "/api/owner-goals/notavalidid", params={"fiscal_year": 2026}
        )
        assert response.status_code == 400


class TestUpsertOwnerGoal:
    def test_upsert_creates_new_row(self, admin_client, admin_db):
        admin_row = _admin_db_admin_row()

        async def fetchrow_returning_inserted(query, *args):
            if "FROM bedrock.app_user" in query:
                return admin_row
            # The INSERT ... ON CONFLICT ... RETURNING query
            return _make_goal_row(VALID_SF_USER_ID, 2026, 2_000_000.0)

        admin_db.fetchrow.side_effect = fetchrow_returning_inserted
        response = admin_client.put(
            f"/api/owner-goals/{VALID_SF_USER_ID}",
            json={"fiscal_year": 2026, "goal_amount": 2_000_000, "notes": ""},
        )
        assert response.status_code == 200
        assert response.json()["data"]["goal_amount"] == 2_000_000.0

    def test_upsert_rejects_negative_amount(self, admin_client):
        response = admin_client.put(
            f"/api/owner-goals/{VALID_SF_USER_ID}",
            json={"fiscal_year": 2026, "goal_amount": -100},
        )
        assert response.status_code == 422  # Pydantic validation

    def test_upsert_rejects_amount_over_cap(self, admin_client):
        response = admin_client.put(
            f"/api/owner-goals/{VALID_SF_USER_ID}",
            json={"fiscal_year": 2026, "goal_amount": 200_000_000},
        )
        assert response.status_code == 422

    def test_upsert_rejects_invalid_sf_id(self, admin_client):
        response = admin_client.put(
            "/api/owner-goals/notvalid",
            json={"fiscal_year": 2026, "goal_amount": 1_000_000},
        )
        assert response.status_code == 400

    def test_upsert_requires_manage_owner_goals_permission(self, rm_client):
        """RM with view_revenue_dashboard but not manage_owner_goals → 403."""
        response = rm_client.put(
            f"/api/owner-goals/{VALID_SF_USER_ID}",
            json={"fiscal_year": 2026, "goal_amount": 2_000_000},
        )
        assert response.status_code == 403


class TestDeleteOwnerGoal:
    def test_delete_returns_404_when_no_row(self, admin_client, admin_db):
        admin_db.execute.return_value = "DELETE 0"
        response = admin_client.delete(
            f"/api/owner-goals/{VALID_SF_USER_ID}", params={"fiscal_year": 2026}
        )
        assert response.status_code == 404

    def test_delete_succeeds_when_row_exists(self, admin_client, admin_db):
        admin_db.execute.return_value = "DELETE 1"
        response = admin_client.delete(
            f"/api/owner-goals/{VALID_SF_USER_ID}", params={"fiscal_year": 2026}
        )
        assert response.status_code == 200
        assert response.json()["success"] is True

    def test_delete_requires_manage_owner_goals_permission(self, rm_client):
        response = rm_client.delete(
            f"/api/owner-goals/{VALID_SF_USER_ID}", params={"fiscal_year": 2026}
        )
        assert response.status_code == 403


# ---------------------------------------------------------------------------
# Helpers — kept at module bottom for readability
# ---------------------------------------------------------------------------

def _admin_db_admin_row():
    return {
        "id": "test-id",
        "sf_user_id": "005TESTOWNER00001",
        "email": "test@test.org",
        "name": "Test",
        "is_active": True,
        "permissions": json.dumps({}),
        "profile_name": "Admin",
        "org_user_id": None,
    }
