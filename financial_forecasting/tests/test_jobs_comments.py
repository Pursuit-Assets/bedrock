"""Evals for routes/jobs_comments.py — generic jobs comments.

Key behaviors: parent_type validation, account-level routing to the mirror
table, required content, and author-only edit/delete.
"""
import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client, DEFAULT_USER


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _comment_row(**ov):
    row = {"id": "22222222-2222-2222-2222-222222222222", "parent_type": "prospect",
           "parent_id": "5", "author_id": None, "author_email": DEFAULT_USER["email"],
           "content": "hi", "created_at": None, "updated_at": None}
    row.update(ov)
    return row


def test_get_comments_account_uses_mirror():
    conn = FakeConn(lists={"FROM bedrock.jobs_account_comment": [_comment_row(parent_type="account")]})
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/jobs-comments?parent_type=account&parent_id=acme")
    assert r.status_code == 200, r.text
    assert conn.ran("FROM bedrock.jobs_account_comment")


def test_get_comments_invalid_parent_type_400():
    c = make_jobs_client(FakeConn())
    r = c.get("/api/jobs/jobs-comments?parent_type=widget&parent_id=x")
    assert r.status_code == 400


def test_create_comment_requires_content():
    c = make_jobs_client(FakeConn())
    r = c.post("/api/jobs/jobs-comments", json={"parent_type": "prospect", "parent_id": "5", "content": "   "})
    assert r.status_code == 400


def test_create_account_comment_inserts_into_mirror():
    conn = FakeConn(rows={"INSERT INTO bedrock.jobs_account_comment": _comment_row(parent_type="account", content="note")})
    c = make_jobs_client(conn)
    r = c.post("/api/jobs/jobs-comments", json={"parent_type": "account", "parent_id": "acme", "content": "note"})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["content"] == "note"
    assert conn.ran("INSERT INTO bedrock.jobs_account_comment")


def test_patch_comment_author_only_403():
    conn = FakeConn(rows={"author_email FROM bedrock.jobs_comment WHERE": {"author_email": "someone@else.org"}})
    c = make_jobs_client(conn)
    r = c.patch("/api/jobs/jobs-comments/22222222-2222-2222-2222-222222222222", json={"content": "x"})
    assert r.status_code == 403


def test_patch_comment_author_succeeds():
    conn = FakeConn(rows={
        "author_email FROM bedrock.jobs_comment WHERE": {"author_email": DEFAULT_USER["email"]},
        "UPDATE bedrock.jobs_comment SET content": _comment_row(content="edited"),
    })
    c = make_jobs_client(conn)
    r = c.patch("/api/jobs/jobs-comments/22222222-2222-2222-2222-222222222222", json={"content": "edited"})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["content"] == "edited"


def test_patch_comment_not_found_404():
    c = make_jobs_client(FakeConn())   # _locate_comment finds nothing in either table
    r = c.patch("/api/jobs/jobs-comments/22222222-2222-2222-2222-222222222222", json={"content": "x"})
    assert r.status_code == 404


def test_delete_comment_author_only_403():
    conn = FakeConn(rows={"author_email FROM bedrock.jobs_comment WHERE": {"author_email": "someone@else.org"}})
    c = make_jobs_client(conn)
    r = c.delete("/api/jobs/jobs-comments/22222222-2222-2222-2222-222222222222")
    assert r.status_code == 403
