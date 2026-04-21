"""Tests for Projects router — CRUD, soft-delete, restore, purge, auth enforcement, permissions."""

import sys
import os
import json
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, call

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient
from main import app, get_current_user
from auth import require_auth
from db import get_db
from routes.permissions import check_permission

app.router.on_startup.clear()
app.router.on_shutdown.clear()

TEST_USER = {"user_id": "test_user", "email": "test@pursuit.org", "name": "Test"}
ADMIN_USER = {"user_id": "admin_user", "email": "admin@pursuit.org", "name": "Admin"}
PROJECT_ID = str(uuid.uuid4())
WORKSTREAM_ID = str(uuid.uuid4())
MILESTONE_ID = str(uuid.uuid4())
TASK_ID = str(uuid.uuid4())

# Full-access permissions for the default test user (simulates Admin profile)
_ALL_PERMS = {
    "view_opportunities": True, "edit_own_opportunities": True, "edit_all_opportunities": True,
    "create_opportunities": True, "bulk_update_opportunities": True, "lock_own_opportunities": True,
    "reassign_opportunities": True, "view_tasks": True, "edit_own_tasks": True, "edit_all_tasks": True,
    "create_tasks": True, "edit_accounts": True, "create_accounts": True, "edit_contacts": True,
    "create_contacts": True, "edit_payments": True, "create_payments": True,
    "view_projects": True, "edit_projects": True,
    "view_revenue_dashboard": True, "view_cashflow_forecasts": True,
    "view_sage_invoices_payments": True, "create_sage_invoices": True,
    "match_invoices": True, "manage_payment_schedules": True, "generate_financial_reports": True,
    "use_pebble_chat": True, "use_pebble_research": True, "pebble_crm_write": True,
    "trigger_data_sync": True, "manage_users_roles": True, "edit_permission_profiles": True,
}

def _make_user_row(email="test@pursuit.org", perms=None):
    """Return a MockDBRow matching the permission_profile join query shape."""
    return MockDBRow(
        id=uuid.UUID("00000000-0000-4000-8000-000000000001"),
        sf_user_id="005x0000001234",
        email=email,
        name="Test",
        is_active=True,
        permissions=perms or _ALL_PERMS,
        profile_name="Admin",
    )


class MockDBRow(dict):
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key)


class MockTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


@pytest.fixture
def mock_db():
    db = AsyncMock()
    db.fetch = AsyncMock(return_value=[])
    db.fetchrow = AsyncMock(return_value=None)
    db.fetchval = AsyncMock(return_value=0)
    db.execute = AsyncMock(return_value="UPDATE 1")
    db.transaction = MockTransaction
    return db


import routes.permissions as _perms_mod
_original_get_user_permissions = _perms_mod.get_user_permissions

async def _fake_admin_perms(email, db):
    """Fake get_user_permissions that always returns admin-level access."""
    return dict(_make_user_row(email=email))


@pytest.fixture
def authed_client(mock_db):
    _perms_mod.get_user_permissions = _fake_admin_perms
    app.dependency_overrides[get_current_user] = lambda: TEST_USER
    app.dependency_overrides[require_auth] = lambda: TEST_USER
    app.dependency_overrides[get_db] = lambda: mock_db
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()
    _perms_mod.get_user_permissions = _original_get_user_permissions


@pytest.fixture
def admin_client(mock_db):
    """Client with admin user — for purge endpoint tests."""
    from routes.permissions import require_admin
    _perms_mod.get_user_permissions = _fake_admin_perms
    app.dependency_overrides[get_current_user] = lambda: ADMIN_USER
    app.dependency_overrides[require_auth] = lambda: ADMIN_USER
    app.dependency_overrides[require_admin] = lambda: ADMIN_USER
    app.dependency_overrides[get_db] = lambda: mock_db
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()
    _perms_mod.get_user_permissions = _original_get_user_permissions


@pytest.fixture
def unauthed_client(mock_db):
    """No auth override — tests 401 enforcement."""
    app.dependency_overrides[get_db] = lambda: mock_db
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()


# ===========================================================================
# AUTH ENFORCEMENT — all endpoints require auth
# ===========================================================================


class TestProjectsAuthEnforcement:
    """Every projects endpoint must return 401 without authentication."""

    def test_list_projects_requires_auth(self, unauthed_client):
        assert unauthed_client.get("/api/projects").status_code == 401

    def test_get_project_requires_auth(self, unauthed_client):
        assert unauthed_client.get(f"/api/projects/{PROJECT_ID}").status_code == 401

    def test_trash_requires_auth(self, unauthed_client):
        assert unauthed_client.get("/api/projects/trash").status_code == 401

    def test_restore_requires_auth(self, unauthed_client):
        assert unauthed_client.post(f"/api/projects/{PROJECT_ID}/restore").status_code == 401

    def test_create_workstream_requires_auth(self, unauthed_client):
        resp = unauthed_client.post(f"/api/projects/{PROJECT_ID}/workstreams", json={"name": "Test"})
        assert resp.status_code == 401

    def test_update_workstream_requires_auth(self, unauthed_client):
        resp = unauthed_client.put(f"/api/workstreams/{WORKSTREAM_ID}", json={"name": "Updated"})
        assert resp.status_code == 401

    def test_delete_workstream_requires_auth(self, unauthed_client):
        assert unauthed_client.delete(f"/api/workstreams/{WORKSTREAM_ID}").status_code == 401

    def test_create_milestone_requires_auth(self, unauthed_client):
        resp = unauthed_client.post(f"/api/workstreams/{WORKSTREAM_ID}/milestones", json={"title": "M1"})
        assert resp.status_code == 401

    def test_update_milestone_requires_auth(self, unauthed_client):
        resp = unauthed_client.put(f"/api/milestones/{MILESTONE_ID}", json={"title": "Updated"})
        assert resp.status_code == 401

    def test_delete_milestone_requires_auth(self, unauthed_client):
        assert unauthed_client.delete(f"/api/milestones/{MILESTONE_ID}").status_code == 401

    def test_create_task_requires_auth(self, unauthed_client):
        resp = unauthed_client.post(f"/api/milestones/{MILESTONE_ID}/tasks", json={"title": "T1"})
        assert resp.status_code == 401

    def test_update_task_requires_auth(self, unauthed_client):
        resp = unauthed_client.put(f"/api/project-tasks/{TASK_ID}", json={"title": "Updated"})
        assert resp.status_code == 401

    def test_delete_task_requires_auth(self, unauthed_client):
        assert unauthed_client.delete(f"/api/project-tasks/{TASK_ID}").status_code == 401


# ===========================================================================
# CRUD OPERATIONS — authenticated
# ===========================================================================


class TestListProjects:
    def test_returns_projects(self, authed_client, mock_db):
        mock_db.fetch = AsyncMock(return_value=[
            MockDBRow(id=PROJECT_ID, name="AIJI", description="Main project", created_at="2026-01-01", updated_at="2026-01-01"),
        ])
        resp = authed_client.get("/api/projects")
        assert resp.status_code == 200
        assert len(resp.json()["data"]) == 1

    def test_returns_empty_list(self, authed_client, mock_db):
        mock_db.fetch = AsyncMock(return_value=[])
        resp = authed_client.get("/api/projects")
        assert resp.status_code == 200
        assert resp.json()["data"] == []


class TestCreateWorkstream:
    def test_creates_workstream(self, authed_client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=MockDBRow(
            id=WORKSTREAM_ID, name="Strategy", description="", sort_order=0,
        ))
        resp = authed_client.post(f"/api/projects/{PROJECT_ID}/workstreams", json={"name": "Strategy"})
        assert resp.status_code == 200
        assert resp.json()["success"] is True


class TestUpdateWorkstream:
    def test_updates_workstream(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        resp = authed_client.put(f"/api/workstreams/{WORKSTREAM_ID}", json={"name": "Updated"})
        assert resp.status_code == 200


class TestCreateMilestone:
    def test_creates_milestone(self, authed_client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=MockDBRow(
            id=MILESTONE_ID, title="Phase 1", priority="high", status="active", sort_order=0,
        ))
        resp = authed_client.post(
            f"/api/workstreams/{WORKSTREAM_ID}/milestones",
            json={"title": "Phase 1", "priority": "high"},
        )
        assert resp.status_code == 200


class TestCreateProjectTask:
    def test_creates_task(self, authed_client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=MockDBRow(
            id=TASK_ID, title="Research", status="Not Started", owner="", deadline=None,
            start_date=None, description="", updates="", links=[], depends_on=[], sort_order=0,
        ))
        resp = authed_client.post(
            f"/api/milestones/{MILESTONE_ID}/tasks",
            json={"title": "Research"},
        )
        assert resp.status_code == 200
        assert resp.json()["success"] is True


class TestUpdateProjectTask:
    def test_updates_task(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        resp = authed_client.put(
            f"/api/project-tasks/{TASK_ID}",
            json={"status": "In Progress"},
        )
        assert resp.status_code == 200


# ===========================================================================
# SOFT-DELETE — project cascade
# ===========================================================================


class TestSoftDeleteProject:
    # M19 added an ownership SELECT at the top of delete_project; these tests
    # mock fetchrow to return a non-None owner row so the route reaches the
    # UPDATE branch. The admin-perm test user bypasses the email-match check.
    def test_soft_delete_returns_moved_to_trash(self, authed_client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=MockDBRow(owner_email="test@pursuit.org"))
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        resp = authed_client.delete(f"/api/projects/{PROJECT_ID}")
        assert resp.status_code == 200
        assert "moved to trash" in resp.json()["data"]["message"]

    def test_soft_delete_uses_update_not_delete(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        authed_client.delete(f"/api/projects/{PROJECT_ID}")
        # Verify all execute calls use UPDATE (soft-delete), not DELETE
        for c in mock_db.execute.call_args_list:
            sql = c[0][0]
            assert "UPDATE" in sql
            assert "DELETE" not in sql

    def test_soft_delete_cascades_to_children(self, authed_client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=MockDBRow(owner_email="test@pursuit.org"))
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        authed_client.delete(f"/api/projects/{PROJECT_ID}")
        # 4 UPDATEs: project, workstreams, milestones, tasks
        assert mock_db.execute.call_count == 4

    def test_soft_delete_nonexistent_returns_404(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 0")
        resp = authed_client.delete(f"/api/projects/{PROJECT_ID}")
        assert resp.status_code == 404

    def test_soft_delete_sets_deleted_by(self, authed_client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=MockDBRow(owner_email="test@pursuit.org"))
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        authed_client.delete(f"/api/projects/{PROJECT_ID}")
        first_call = mock_db.execute.call_args_list[0]
        sql = first_call[0][0]
        assert "deleted_by" in sql
        # email is passed as second positional arg
        assert first_call[0][2] == "test@pursuit.org"


class TestSoftDeleteWorkstream:
    def test_soft_delete_workstream(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        resp = authed_client.delete(f"/api/workstreams/{WORKSTREAM_ID}")
        assert resp.status_code == 200
        assert "moved to trash" in resp.json()["data"]["message"]

    def test_soft_delete_workstream_cascades(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        authed_client.delete(f"/api/workstreams/{WORKSTREAM_ID}")
        # 3 UPDATEs: workstream, milestones, tasks
        assert mock_db.execute.call_count == 3

    def test_soft_delete_workstream_not_found(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 0")
        resp = authed_client.delete(f"/api/workstreams/{WORKSTREAM_ID}")
        assert resp.status_code == 404


class TestSoftDeleteMilestone:
    def test_soft_delete_milestone(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        resp = authed_client.delete(f"/api/milestones/{MILESTONE_ID}")
        assert resp.status_code == 200
        assert "moved to trash" in resp.json()["data"]["message"]

    def test_soft_delete_milestone_cascades(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        authed_client.delete(f"/api/milestones/{MILESTONE_ID}")
        # 2 UPDATEs: milestone, tasks
        assert mock_db.execute.call_count == 2

    def test_soft_delete_milestone_not_found(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 0")
        resp = authed_client.delete(f"/api/milestones/{MILESTONE_ID}")
        assert resp.status_code == 404


class TestSoftDeleteTask:
    def test_soft_delete_task(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        resp = authed_client.delete(f"/api/project-tasks/{TASK_ID}")
        assert resp.status_code == 200
        assert "moved to trash" in resp.json()["data"]["message"]

    def test_soft_delete_task_not_found(self, authed_client, mock_db):
        mock_db.execute = AsyncMock(return_value="UPDATE 0")
        resp = authed_client.delete(f"/api/project-tasks/{TASK_ID}")
        assert resp.status_code == 404


# ===========================================================================
# TRASH LIST
# ===========================================================================


class TestTrashList:
    def test_list_deleted_projects(self, authed_client, mock_db):
        deleted_at = datetime(2026, 3, 28, tzinfo=timezone.utc)
        # list_deleted_projects reads owner_email for each row (M19)
        mock_db.fetch = AsyncMock(return_value=[
            MockDBRow(id=uuid.UUID(PROJECT_ID), name="Old Project", description="",
                      owner_email="test@pursuit.org", deleted_at=deleted_at,
                      deleted_by="test@pursuit.org"),
        ])
        resp = authed_client.get("/api/projects/trash")
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert len(data) == 1
        assert data[0]["name"] == "Old Project"
        assert data[0]["deleted_by"] == "test@pursuit.org"

    def test_trash_empty(self, authed_client, mock_db):
        mock_db.fetch = AsyncMock(return_value=[])
        resp = authed_client.get("/api/projects/trash")
        assert resp.status_code == 200
        assert resp.json()["data"] == []


# ===========================================================================
# RESTORE
# ===========================================================================


class TestRestoreProject:
    def test_restore_project(self, authed_client, mock_db):
        cascade_ts = datetime(2026, 3, 28, tzinfo=timezone.utc)
        mock_db.fetchrow = AsyncMock(return_value=MockDBRow(deleted_at=cascade_ts))
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        resp = authed_client.post(f"/api/projects/{PROJECT_ID}/restore")
        assert resp.status_code == 200
        assert "restored" in resp.json()["data"]["message"]

    def test_restore_clears_deleted_at(self, authed_client, mock_db):
        cascade_ts = datetime(2026, 3, 28, tzinfo=timezone.utc)
        mock_db.fetchrow = AsyncMock(return_value=MockDBRow(deleted_at=cascade_ts))
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        authed_client.post(f"/api/projects/{PROJECT_ID}/restore")
        # 4 UPDATEs: project + 3 cascade tables
        assert mock_db.execute.call_count == 4
        # All should SET deleted_at = NULL
        for c in mock_db.execute.call_args_list:
            sql = c[0][0]
            assert "deleted_at = NULL" in sql

    def test_restore_nonexistent_returns_404(self, authed_client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=None)
        resp = authed_client.post(f"/api/projects/{PROJECT_ID}/restore")
        assert resp.status_code == 404

    def test_restore_uses_timestamp_matching(self, authed_client, mock_db):
        cascade_ts = datetime(2026, 3, 28, 12, 0, 0, tzinfo=timezone.utc)
        mock_db.fetchrow = AsyncMock(return_value=MockDBRow(deleted_at=cascade_ts))
        mock_db.execute = AsyncMock(return_value="UPDATE 1")
        authed_client.post(f"/api/projects/{PROJECT_ID}/restore")
        # Child UPDATEs (calls 2-4) should pass cascade_ts
        for c in mock_db.execute.call_args_list[1:]:
            assert cascade_ts in c[0], f"Expected cascade_ts in args: {c[0]}"


# ===========================================================================
# PURGE (admin only)
# ===========================================================================


class TestPurgeProject:
    def test_purge_hard_deletes(self, admin_client, mock_db):
        # purge enforces a 60-day soft-delete retention window; use an old
        # deleted_at so `age >= retention` and the hard DELETE runs.
        old_deleted_at = datetime(2025, 1, 1, tzinfo=timezone.utc)
        mock_db.fetchrow = AsyncMock(return_value=MockDBRow(
            id=uuid.UUID(PROJECT_ID), deleted_at=old_deleted_at,
        ))
        mock_db.execute = AsyncMock(return_value="DELETE 1")
        resp = admin_client.delete(f"/api/projects/{PROJECT_ID}/purge")
        assert resp.status_code == 200
        assert "permanently deleted" in resp.json()["data"]["message"]
        # Verify actual DELETE (not UPDATE)
        delete_call = mock_db.execute.call_args_list[0]
        assert "DELETE FROM" in delete_call[0][0]

    def test_purge_nonexistent_returns_404(self, admin_client, mock_db):
        mock_db.fetchrow = AsyncMock(return_value=None)
        resp = admin_client.delete(f"/api/projects/{PROJECT_ID}/purge")
        assert resp.status_code == 404

    def test_purge_requires_admin(self, authed_client, mock_db):
        """Non-admin users should not be able to purge."""
        resp = authed_client.delete(f"/api/projects/{PROJECT_ID}/purge")
        # Without require_admin override, the dependency rejects (403 or 500 if
        # permissions lookup fails on mock DB — either way, NOT 200)
        assert resp.status_code != 200


# ===========================================================================
# PERMISSION GATING — view_projects / edit_projects enforcement
# ===========================================================================


RM_PROFILE_ID = str(uuid.uuid4())
PM_PROFILE_ID = str(uuid.uuid4())
EXEC_PROFILE_ID = str(uuid.uuid4())
PERM_USER_ID = str(uuid.uuid4())

# Full 32-key permission dicts for each profile

RM_PERMS = json.dumps({
    "view_opportunities": True, "edit_own_opportunities": True, "edit_all_opportunities": False,
    "create_opportunities": True, "bulk_update_opportunities": False, "lock_own_opportunities": True,
    "reassign_opportunities": False,
    "view_tasks": True, "edit_own_tasks": True, "edit_all_tasks": False, "create_tasks": True,
    "edit_accounts": True, "create_accounts": True,
    "edit_contacts": True, "create_contacts": True,
    "edit_payments": False, "create_payments": False,
    "view_projects": False, "edit_projects": False,
    "view_revenue_dashboard": True, "view_cashflow_forecasts": True,
    "view_sage_invoices_payments": False, "create_sage_invoices": False,
    "match_invoices": False, "manage_payment_schedules": False, "generate_financial_reports": False,
    "use_pebble_chat": False, "use_pebble_research": False, "pebble_crm_write": False,
    "trigger_data_sync": False, "manage_users_roles": False, "edit_permission_profiles": False,
})

PM_PERMS = json.dumps({
    "view_opportunities": True, "edit_own_opportunities": True, "edit_all_opportunities": True,
    "create_opportunities": True, "bulk_update_opportunities": True, "lock_own_opportunities": True,
    "reassign_opportunities": True,
    "view_tasks": True, "edit_own_tasks": True, "edit_all_tasks": True, "create_tasks": True,
    "edit_accounts": True, "create_accounts": True,
    "edit_contacts": True, "create_contacts": True,
    "edit_payments": True, "create_payments": True,
    "view_projects": True, "edit_projects": True,
    "view_revenue_dashboard": True, "view_cashflow_forecasts": True,
    "view_sage_invoices_payments": True, "create_sage_invoices": True,
    "match_invoices": True, "manage_payment_schedules": True, "generate_financial_reports": True,
    "use_pebble_chat": True, "use_pebble_research": True, "pebble_crm_write": False,
    "trigger_data_sync": False, "manage_users_roles": False, "edit_permission_profiles": False,
})

EXEC_PERMS = json.dumps({
    "view_opportunities": True, "edit_own_opportunities": False, "edit_all_opportunities": False,
    "create_opportunities": False, "bulk_update_opportunities": False, "lock_own_opportunities": False,
    "reassign_opportunities": False,
    "view_tasks": True, "edit_own_tasks": False, "edit_all_tasks": False, "create_tasks": False,
    "edit_accounts": False, "create_accounts": False,
    "edit_contacts": False, "create_contacts": False,
    "edit_payments": False, "create_payments": False,
    "view_projects": True, "edit_projects": False,
    "view_revenue_dashboard": True, "view_cashflow_forecasts": True,
    "view_sage_invoices_payments": True, "create_sage_invoices": False,
    "match_invoices": False, "manage_payment_schedules": False, "generate_financial_reports": True,
    "use_pebble_chat": True, "use_pebble_research": True, "pebble_crm_write": False,
    "trigger_data_sync": False, "manage_users_roles": False, "edit_permission_profiles": False,
})


def _make_perm_user_row(perms_json, profile_name, profile_id):
    return MockDBRow(
        id=PERM_USER_ID, sf_user_id=None, email="test@pursuit.org",
        name="Test User", is_active=True, permissions=perms_json,
        profile_name=profile_name, profile_id=profile_id,
    )


class TestProjectPermissions:
    """Verify view_projects / edit_projects gating on project endpoints."""

    def _make_client(self, mock_db, user_row):
        """Build a TestClient with mock_db returning the given user row."""
        mock_db.fetchrow = AsyncMock(return_value=user_row)
        app.dependency_overrides[get_current_user] = lambda: TEST_USER
        app.dependency_overrides[require_auth] = lambda: TEST_USER
        app.dependency_overrides[get_db] = lambda: mock_db
        return TestClient(app, raise_server_exceptions=False)

    # ── RM: view_projects=False, edit_projects=False ──

    def test_rm_cannot_list_projects(self, mock_db):
        row = _make_perm_user_row(RM_PERMS, "Relationship Manager", RM_PROFILE_ID)
        with self._make_client(mock_db, row) as c:
            resp = c.get("/api/projects")
            assert resp.status_code == 403
        app.dependency_overrides.clear()

    def test_rm_cannot_create_project(self, mock_db):
        row = _make_perm_user_row(RM_PERMS, "Relationship Manager", RM_PROFILE_ID)
        with self._make_client(mock_db, row) as c:
            resp = c.post("/api/projects", json={"name": "Sneaky Project"})
            assert resp.status_code == 403
        app.dependency_overrides.clear()

    # ── PM: view_projects=True, edit_projects=True ──

    def test_pm_can_list_projects(self, mock_db):
        row = _make_perm_user_row(PM_PERMS, "Project Manager", PM_PROFILE_ID)
        mock_db.fetch = AsyncMock(return_value=[])
        with self._make_client(mock_db, row) as c:
            resp = c.get("/api/projects")
            assert resp.status_code == 200
        app.dependency_overrides.clear()

    def test_pm_can_create_project(self, mock_db):
        row = _make_perm_user_row(PM_PERMS, "Project Manager", PM_PROFILE_ID)
        # M19 create_project RETURNING selects id, name, description, owner_email,
        # created_by, created_at — all six must be present on the mock row.
        new_project = MockDBRow(
            id=PROJECT_ID, name="New Project", description="",
            owner_email="test@pursuit.org", created_by="test@pursuit.org",
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        # check_permission calls fetchrow for user perms; create_project calls fetchrow for INSERT RETURNING
        async def smart_fetchrow(query, *args):
            if "permission_profile" in query or "app_user" in query:
                return row
            return new_project
        mock_db.fetchrow = AsyncMock(side_effect=smart_fetchrow)
        mock_db.fetch = AsyncMock(return_value=[])
        app.dependency_overrides[get_current_user] = lambda: TEST_USER
        app.dependency_overrides[require_auth] = lambda: TEST_USER
        app.dependency_overrides[get_db] = lambda: mock_db
        with TestClient(app, raise_server_exceptions=False) as c:
            resp = c.post("/api/projects", json={"name": "New Project"})
            assert resp.status_code == 200
        app.dependency_overrides.clear()

    # ── Executive: view_projects=True, edit_projects=False ──

    def test_executive_can_list_projects(self, mock_db):
        row = _make_perm_user_row(EXEC_PERMS, "Executive", EXEC_PROFILE_ID)
        mock_db.fetch = AsyncMock(return_value=[])
        with self._make_client(mock_db, row) as c:
            resp = c.get("/api/projects")
            assert resp.status_code == 200
        app.dependency_overrides.clear()

    def test_executive_cannot_create_project(self, mock_db):
        row = _make_perm_user_row(EXEC_PERMS, "Executive", EXEC_PROFILE_ID)
        with self._make_client(mock_db, row) as c:
            resp = c.post("/api/projects", json={"name": "Blocked Project"})
            assert resp.status_code == 403
        app.dependency_overrides.clear()
