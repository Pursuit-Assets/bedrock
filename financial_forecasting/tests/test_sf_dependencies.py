"""Tests for Salesforce Task Dependencies and Bridge Table API endpoints."""

import sys
import os
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient

from main import app, get_current_user, get_mcp_client
from auth import require_auth
from db import get_db
import routes.permissions as _perms_mod

# Disable startup/shutdown events
app.router.on_startup.clear()
app.router.on_shutdown.clear()

# Bypass the real get_user_permissions so individual tests can override
# mock_db.fetchrow freely without breaking the permission check. The
# endpoints under test here require view_projects and edit_projects, which
# are local-only permissions — they gate reads/writes of bedrock rows that
# *reference* Salesforce IDs, never writes to Salesforce itself.
_original_get_user_permissions = _perms_mod.get_user_permissions


async def _fake_admin_perms(email, db):
    return {
        "id": str(uuid.uuid4()),
        "org_user_id": str(uuid.uuid4()),
        "sf_user_id": "005TESTSFUSER0001",
        "email": email,
        "name": "Test User",
        "is_active": True,
        "profile_id": str(uuid.uuid4()),
        "profile_name": "Admin",
        "permissions": {k: True for k in _perms_mod.PERMISSION_KEYS},
    }

# ---------------------------------------------------------------------------
# Auth override
# ---------------------------------------------------------------------------

TEST_USER = {"user_id": "test_user", "name": "Test User", "role": "admin"}


def override_get_current_user():
    return TEST_USER


# ---------------------------------------------------------------------------
# Mock DB
# ---------------------------------------------------------------------------

DEP_UUID = str(uuid.uuid4())
LINK_UUID = str(uuid.uuid4())
PROJECT_UUID = str(uuid.uuid4())
MILESTONE_UUID = str(uuid.uuid4())

SF_TASK_ID_1 = "00T000000000001AAA"
SF_TASK_ID_2 = "00T000000000002AAA"
SF_OPP_ID = "006000000000001AAA"

# Admin permissions JSON for check_permission to pass
ALL_PERMS = json.dumps({
    "view_opportunities": True, "edit_own_opportunities": True, "edit_all_opportunities": True,
    "create_opportunities": True, "bulk_update_opportunities": True, "lock_own_opportunities": True,
    "reassign_opportunities": True,
    "view_tasks": True, "edit_own_tasks": True, "edit_all_tasks": True, "create_tasks": True,
    "view_revenue_dashboard": True, "view_cashflow_forecasts": True,
    "view_sage_invoices_payments": True, "create_sage_invoices": True,
    "match_invoices": True, "manage_payment_schedules": True, "generate_financial_reports": True,
    "trigger_data_sync": True, "manage_users_roles": True,
})


class MockDBRow(dict):
    """Dict subclass that also supports attribute access (like asyncpg.Record)."""
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key)


def make_dep_row(task_id=SF_TASK_ID_1, depends_on_id=SF_TASK_ID_2):
    return MockDBRow(id=DEP_UUID, task_id=task_id, depends_on_id=depends_on_id, created_at="2026-03-20T00:00:00Z")


def make_link_row():
    return MockDBRow(
        id=LINK_UUID, sf_task_id=SF_TASK_ID_1, project_id=PROJECT_UUID,
        milestone_id=MILESTONE_UUID, sort_order=0, created_at="2026-03-20T00:00:00Z",
    )


def _admin_user_row():
    """Mock row returned by get_user_permissions for check_permission to pass."""
    return MockDBRow(
        id=str(uuid.uuid4()), sf_user_id="005TESTSFUSER0001", email="test@test.org",
        name="Test User", is_active=True, permissions=ALL_PERMS, profile_name="Admin",
    )


@pytest.fixture
def mock_db():
    admin_row = _admin_user_row()
    async def smart_fetchrow(query, *args):
        """Return admin user for permission queries, None for lock queries."""
        if "opportunity_lock" in query:
            return None  # No lock by default
        return admin_row
    db = AsyncMock()
    db.fetch = AsyncMock(return_value=[])
    db.fetchrow = AsyncMock(side_effect=smart_fetchrow)
    db.fetchval = AsyncMock(return_value=1)
    db.execute = AsyncMock(return_value="DELETE 1")
    return db


@pytest.fixture
def mock_salesforce():
    service = AsyncMock()
    service.query = AsyncMock(return_value={"records": []})
    service.create_record = AsyncMock(return_value={"id": "00T000000000003AAA"})
    service.update_record = AsyncMock(return_value=True)
    service.delete_record = AsyncMock(return_value=True)
    return service


@pytest.fixture
def mock_client(mock_salesforce):
    client = MagicMock()
    client.salesforce = mock_salesforce
    client.disconnect_all = AsyncMock()
    return client


@pytest.fixture
def client(mock_db, mock_client):
    _perms_mod.get_user_permissions = _fake_admin_perms
    app.dependency_overrides[get_current_user] = override_get_current_user
    app.dependency_overrides[require_auth] = override_get_current_user
    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_mcp_client] = lambda: mock_client

    with TestClient(app, raise_server_exceptions=False) as c:
        yield c

    app.dependency_overrides.clear()
    _perms_mod.get_user_permissions = _original_get_user_permissions


# ===========================================================================
# sf_dependencies.py — Task Dependency CRUD
# ===========================================================================


class TestGetOpportunityTaskDependencies:
    def test_returns_empty_without_task_ids(self, client):
        resp = client.get("/api/salesforce/task-dependencies")
        assert resp.status_code == 200
        assert resp.json()["data"] == []

    def test_returns_deps_filtered_by_task_ids(self, client, mock_db):
        mock_db.fetch = AsyncMock(return_value=[make_dep_row()])
        resp = client.get(
            "/api/salesforce/task-dependencies",
            params={"task_ids": f"{SF_TASK_ID_1},{SF_TASK_ID_2}"},
        )
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert len(data) == 1
        assert data[0]["task_id"] == SF_TASK_ID_1


class TestGetTaskDependencies:
    def test_returns_deps_for_task(self, client, mock_db):
        mock_db.fetch = AsyncMock(return_value=[make_dep_row()])
        resp = client.get(f"/api/salesforce/tasks/{SF_TASK_ID_1}/dependencies")
        assert resp.status_code == 200
        assert len(resp.json()["data"]) == 1

    def test_rejects_invalid_sf_id(self, client):
        resp = client.get("/api/salesforce/tasks/not-a-valid-id/dependencies")
        assert resp.status_code == 400


class TestAddTaskDependency:
    def test_creates_dependency(self, client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=make_dep_row())
        resp = client.post(
            f"/api/salesforce/tasks/{SF_TASK_ID_1}/dependencies",
            json={"depends_on_id": SF_TASK_ID_2},
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["task_id"] == SF_TASK_ID_1

    def test_rejects_self_dependency(self, client):
        resp = client.post(
            f"/api/salesforce/tasks/{SF_TASK_ID_1}/dependencies",
            json={"depends_on_id": SF_TASK_ID_1},
        )
        assert resp.status_code == 400
        assert "itself" in resp.json()["detail"]

    def test_validates_depends_on_id(self, client):
        resp = client.post(
            f"/api/salesforce/tasks/{SF_TASK_ID_1}/dependencies",
            json={"depends_on_id": "bad-id"},
        )
        assert resp.status_code == 400

    def test_handles_duplicate_gracefully(self, client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=None)  # ON CONFLICT DO NOTHING
        resp = client.post(
            f"/api/salesforce/tasks/{SF_TASK_ID_1}/dependencies",
            json={"depends_on_id": SF_TASK_ID_2},
        )
        assert resp.status_code == 200
        assert resp.json()["data"] is None
        assert "already exists" in resp.json()["message"]


class TestRemoveTaskDependency:
    def test_removes_dependency(self, client, mock_db):
        mock_db.execute = AsyncMock(return_value="DELETE 1")
        resp = client.delete(f"/api/salesforce/task-dependencies/{DEP_UUID}")
        assert resp.status_code == 200

    def test_returns_404_for_missing(self, client, mock_db):
        mock_db.execute = AsyncMock(return_value="DELETE 0")
        resp = client.delete(f"/api/salesforce/task-dependencies/{DEP_UUID}")
        assert resp.status_code == 404

    def test_rejects_invalid_uuid(self, client):
        resp = client.delete("/api/salesforce/task-dependencies/not-a-uuid")
        assert resp.status_code == 400


# ===========================================================================
# main.py — Duplicate Task endpoint
# ===========================================================================


class TestDuplicateTask:
    def test_duplicates_task(self, client, mock_salesforce):
        mock_salesforce.query = AsyncMock(return_value={"records": [{
            "Subject": "Follow up", "Status": "Not Started", "Priority": "Normal",
            "ActivityDate": "2026-04-01", "Description": "Test", "OwnerId": "005OWNER",
            "WhatId": SF_OPP_ID,
        }]})
        mock_salesforce.create_record = AsyncMock(return_value={"id": "00TNEWID"})

        resp = client.post(
            f"/api/salesforce/tasks/{SF_TASK_ID_1}/duplicate",
            json={"WhatId": None},
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["id"] == "00TNEWID"

    def test_duplicates_with_new_opportunity(self, client, mock_salesforce):
        mock_salesforce.query = AsyncMock(return_value={"records": [{
            "Subject": "Follow up", "Status": "In Progress", "Priority": "High",
            "ActivityDate": None, "Description": None, "OwnerId": None, "WhatId": None,
        }]})
        mock_salesforce.create_record = AsyncMock(return_value={"id": "00TNEWID2"})

        resp = client.post(
            f"/api/salesforce/tasks/{SF_TASK_ID_1}/duplicate",
            json={"WhatId": SF_OPP_ID},
        )
        assert resp.status_code == 200
        # Verify WhatId was passed to create_record
        create_call = mock_salesforce.create_record.call_args
        assert create_call[0][1]["WhatId"] == SF_OPP_ID

    def test_returns_404_for_missing_task(self, client, mock_salesforce):
        mock_salesforce.query = AsyncMock(return_value={"records": []})
        resp = client.post(
            f"/api/salesforce/tasks/{SF_TASK_ID_1}/duplicate",
            json={},
        )
        assert resp.status_code == 404

    def test_validates_task_id(self, client):
        resp = client.post(
            "/api/salesforce/tasks/bad-id/duplicate",
            json={},
        )
        assert resp.status_code == 400

    def test_validates_what_id(self, client):
        resp = client.post(
            f"/api/salesforce/tasks/{SF_TASK_ID_1}/duplicate",
            json={"WhatId": "bad-opp-id"},
        )
        assert resp.status_code == 400


# ===========================================================================
# projects.py — Bridge Table endpoints
# ===========================================================================


class TestLinkSfTaskToProject:
    def test_links_task(self, client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=make_link_row())
        resp = client.post(
            f"/api/projects/{PROJECT_UUID}/sf-tasks",
            json={"sf_task_id": SF_TASK_ID_1, "milestone_id": MILESTONE_UUID},
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["sf_task_id"] == SF_TASK_ID_1

    def test_validates_sf_task_id(self, client):
        resp = client.post(
            f"/api/projects/{PROJECT_UUID}/sf-tasks",
            json={"sf_task_id": "bad-id"},
        )
        assert resp.status_code == 400

    def test_rejects_invalid_project_uuid(self, client):
        resp = client.post(
            "/api/projects/not-a-uuid/sf-tasks",
            json={"sf_task_id": SF_TASK_ID_1},
        )
        assert resp.status_code in (400, 422, 500)


class TestUnlinkSfTaskFromProject:
    def test_unlinks_task(self, client, mock_db):
        mock_db.execute = AsyncMock(return_value="DELETE 1")
        resp = client.delete(f"/api/sf-task-project/{LINK_UUID}")
        assert resp.status_code == 200

    def test_returns_404_for_missing(self, client, mock_db):
        mock_db.execute = AsyncMock(return_value="DELETE 0")
        resp = client.delete(f"/api/sf-task-project/{LINK_UUID}")
        assert resp.status_code == 404


class TestGetProjectSfTasks:
    def test_returns_linked_tasks(self, client, mock_db):
        mock_db.fetch = AsyncMock(return_value=[make_link_row()])
        resp = client.get(f"/api/projects/{PROJECT_UUID}/sf-tasks")
        assert resp.status_code == 200
        assert len(resp.json()["data"]) == 1


class TestGetProjectByOpportunity:
    def test_returns_project(self, client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=MockDBRow(
            id=PROJECT_UUID, name="Test Project", description="", opportunity_id=SF_OPP_ID,
        ))
        resp = client.get(f"/api/projects/by-opportunity/{SF_OPP_ID}")
        assert resp.status_code == 200
        assert resp.json()["data"]["name"] == "Test Project"

    def test_returns_null_when_not_found(self, client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=None)
        resp = client.get(f"/api/projects/by-opportunity/{SF_OPP_ID}")
        assert resp.status_code == 200
        assert resp.json()["data"] is None

    def test_validates_opportunity_id(self, client):
        resp = client.get("/api/projects/by-opportunity/bad-id")
        assert resp.status_code == 400


class TestGetSfTaskProjectLink:
    def test_returns_link(self, client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=MockDBRow(
            id=LINK_UUID, sf_task_id=SF_TASK_ID_1, project_id=PROJECT_UUID,
            milestone_id=MILESTONE_UUID, project_name="Test Project",
        ))
        resp = client.get(f"/api/sf-task-project/by-task/{SF_TASK_ID_1}")
        assert resp.status_code == 200
        assert resp.json()["data"]["project_name"] == "Test Project"

    def test_returns_null_when_not_linked(self, client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=None)
        resp = client.get(f"/api/sf-task-project/by-task/{SF_TASK_ID_1}")
        assert resp.status_code == 200
        assert resp.json()["data"] is None

    def test_validates_sf_task_id(self, client):
        resp = client.get("/api/sf-task-project/by-task/bad-id")
        assert resp.status_code == 400
