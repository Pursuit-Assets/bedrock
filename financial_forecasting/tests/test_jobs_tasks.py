"""Evals for routes/jobs_tasks.py — generic jobs tasks.

Key behaviors: parent_type validation, routing account-level tasks to the
bedrock-owned mirror table, status validation, required title, and the
try-both-tables PATCH/DELETE.
"""
import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _task_row(**ov):
    row = {"id": "11111111-1111-1111-1111-111111111111", "parent_type": "opportunity",
           "parent_id": "o1", "title": "T", "status": "Not Started", "owner": None,
           "owner_ids": [], "deadline": None, "start_date": None, "description": "",
           "links": [], "sort_order": 0, "created_at": None, "updated_at": None}
    row.update(ov)
    return row


# ── parent_type routing ─────────────────────────────────────────────────────────

def test_get_tasks_opportunity_uses_main_table():
    conn = FakeConn(lists={"FROM bedrock.jobs_task": [_task_row()]})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/jobs-tasks?parent_type=opportunity&parent_id=o1")
    assert r.status_code == 200, r.text
    assert conn.ran("FROM bedrock.jobs_task")
    assert not conn.ran("FROM bedrock.jobs_account_task")


def test_get_tasks_account_uses_mirror_table():
    conn = FakeConn(lists={"FROM bedrock.jobs_account_task": [_task_row(parent_type="account")]})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/jobs-tasks?parent_type=account&parent_id=acme")
    assert r.status_code == 200, r.text
    assert conn.ran("FROM bedrock.jobs_account_task")


def test_get_tasks_invalid_parent_type_400():
    c = make_jobs_client(FakeConn())
    r = c.get("/api/jobs/jobs-tasks?parent_type=widget&parent_id=x")
    assert r.status_code == 400


# ── create ──────────────────────────────────────────────────────────────────────

def test_create_task_requires_title():
    c = make_jobs_client(FakeConn())
    r = c.post("/api/jobs/jobs-tasks", json={"parent_type": "opportunity", "parent_id": "o1", "title": "  "})
    assert r.status_code == 400


def test_create_account_task_inserts_into_mirror():
    conn = FakeConn(rows={"INSERT INTO bedrock.jobs_account_task": _task_row(parent_type="account", title="Call")})
    c = make_jobs_client(conn)
    r = c.post("/api/jobs/jobs-tasks", json={"parent_type": "account", "parent_id": "acme", "title": "Call"})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["title"] == "Call"
    assert conn.ran("INSERT INTO bedrock.jobs_account_task")


# ── patch ─────────────────────────────────────────────────────────────────────

def test_patch_invalid_status_400():
    c = make_jobs_client(FakeConn())
    r = c.patch("/api/jobs/jobs-tasks/11111111-1111-1111-1111-111111111111", json={"status": "Bogus"})
    assert r.status_code == 400


def test_patch_falls_through_to_account_table():
    # main jobs_task returns no row; account mirror does → PATCH still succeeds
    conn = FakeConn(rows={"UPDATE bedrock.jobs_account_task": _task_row(parent_type="account", status="Completed")})
    c = make_jobs_client(conn)
    r = c.patch("/api/jobs/jobs-tasks/11111111-1111-1111-1111-111111111111", json={"status": "Completed"})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["status"] == "Completed"
    assert conn.ran("UPDATE bedrock.jobs_task")          # tried main first
    assert conn.ran("UPDATE bedrock.jobs_account_task")  # then the mirror


def test_patch_not_found_404():
    c = make_jobs_client(FakeConn())   # neither table returns a row
    r = c.patch("/api/jobs/jobs-tasks/11111111-1111-1111-1111-111111111111", json={"title": "x"})
    assert r.status_code == 404


# ── delete ──────────────────────────────────────────────────────────────────────

def test_delete_task_soft_deletes():
    conn = FakeConn()  # execute default "OK" != "UPDATE 0" → first table succeeds
    c = make_jobs_client(conn)
    r = c.delete("/api/jobs/jobs-tasks/11111111-1111-1111-1111-111111111111")
    assert r.status_code == 200, r.text
    assert conn.executed("SET deleted_at = now()")


def test_delete_task_not_found_404():
    conn = FakeConn(vals={"SET deleted_at = now()": "UPDATE 0"})  # both tables: nothing deleted
    c = make_jobs_client(conn)
    r = c.delete("/api/jobs/jobs-tasks/11111111-1111-1111-1111-111111111111")
    assert r.status_code == 404
