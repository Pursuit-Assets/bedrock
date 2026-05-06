"""Tests for ``services/search_indexer.py`` — Layer 1.6.

Locks in:

A. Composer registry: register / get / clear behaviors.
B. Built-in composers produce expected SearchDocRow shapes.
C. Built-in composers return None on missing / deleted / wrong-status rows.
D. drain_once happy path: upsert + dequeue.
E. drain_once handles 'delete' op via soft-delete.
F. drain_once with no composer leaves the queue row in place (no attempt bump).
G. drain_once on composer error bumps attempt_count + records last_error.
H. drain_once skips rows past MAX_ATTEMPT_COUNT.
I. backfill enqueues all rows from the id-source.
J. backfill rejects unregistered entity_type.
"""

import os
import sys
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from services import search_indexer as si


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def fresh_registry():
    """Snapshot+restore the composer registry so tests don't leak."""
    snapshot = dict(si._composers)
    yield
    si.clear_registry()
    si._composers.update(snapshot)


@pytest.fixture
def mock_pool_with_conn():
    """Pool whose acquire() yields a single configured AsyncMock conn."""
    conn = AsyncMock()
    conn.fetchrow = AsyncMock()
    conn.fetch = AsyncMock(return_value=[])
    conn.execute = AsyncMock(return_value="UPDATE 1")
    conn.fetchval = AsyncMock(return_value=0)
    conn.executemany = AsyncMock()

    @asynccontextmanager
    async def _acquire():
        yield conn

    pool = MagicMock()
    pool.acquire = lambda: _acquire()
    return pool, conn


# ---------------------------------------------------------------------------
# A. Registry
# ---------------------------------------------------------------------------

def test_default_registry_has_built_in_composers():
    assert "bedrock_project" in si.registered_entity_types()
    assert "bedrock_saved_view" in si.registered_entity_types()
    assert "pebble_profile" in si.registered_entity_types()


def test_register_overwrites(fresh_registry):
    async def custom(conn, eid):
        return None
    si.register_composer("bedrock_project", custom)
    assert si.get_composer("bedrock_project") is custom


def test_get_composer_unknown_returns_none():
    assert si.get_composer("does_not_exist") is None


def test_clear_registry_empties_it(fresh_registry):
    si.clear_registry()
    assert si.registered_entity_types() == ()


# ---------------------------------------------------------------------------
# B + C. Built-in composers
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_compose_bedrock_project_happy_path():
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value={
        "id": "abc-123",
        "name": "Q4 Capacity Build",
        "description": "Spin up training cohort.",
        "created_by": "rm@pursuit.org",
        "created_at": datetime(2026, 5, 1, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 5, 6, tzinfo=timezone.utc),
        "is_deleted": False,
    })
    doc = await si.compose_bedrock_project(conn, "abc-123")
    assert doc is not None
    assert doc.entity_type == "bedrock_project"
    assert doc.entity_id == "abc-123"
    assert doc.title == "Q4 Capacity Build"
    assert "Spin up training cohort" in doc.subtitle
    assert doc.href == "/projects/abc-123"
    assert doc.owner_email == "rm@pursuit.org"
    assert doc.visibility == "org"
    assert "Q4 Capacity Build" in doc.search_text


@pytest.mark.asyncio
async def test_compose_bedrock_project_deleted_returns_none():
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value={
        "id": "abc-123", "name": "X", "description": "", "created_by": None,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
        "is_deleted": True,
    })
    assert await si.compose_bedrock_project(conn, "abc-123") is None


@pytest.mark.asyncio
async def test_compose_bedrock_project_missing_returns_none():
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value=None)
    assert await si.compose_bedrock_project(conn, "abc-123") is None


@pytest.mark.asyncio
async def test_compose_bedrock_saved_view_personal_is_private():
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value={
        "id": "v1", "scope_key": "pipeline", "name": "My Open Deals",
        "owner_email": "rm@pursuit.org", "is_global": False,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    })
    doc = await si.compose_bedrock_saved_view(conn, "v1")
    assert doc.visibility == "private"
    assert doc.owner_email == "rm@pursuit.org"
    assert doc.title == "My Open Deals"
    assert doc.href == "/pipeline?view=v1"


@pytest.mark.asyncio
async def test_compose_bedrock_saved_view_global_clears_owner():
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value={
        "id": "v2", "scope_key": "accounts", "name": "Top Tier",
        "owner_email": "admin@pursuit.org", "is_global": True,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    })
    doc = await si.compose_bedrock_saved_view(conn, "v2")
    assert doc.visibility == "org"
    assert doc.owner_email is None


@pytest.mark.asyncio
async def test_compose_pebble_profile_happy_path():
    profile = {"summary": "Major donor in workforce dev. 3 prior gifts."}
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value={
        "id": "sess-1", "contact_id": "003ABC",
        "prospect_name": "Jane Donor", "prospect_org": "MetLife Foundation",
        "tier": "T2", "status": "completed", "batch_id": None,
        "profile_json": json.dumps(profile),
        "created_at": datetime(2026, 5, 6, tzinfo=timezone.utc),
    })
    doc = await si.compose_pebble_profile(conn, "sess-1")
    assert doc.title == "Jane Donor"
    assert "MetLife Foundation" in doc.subtitle
    assert "Tier T2" in doc.subtitle
    assert doc.href == "/pebble/profiles/sess-1"
    assert "Jane Donor" in doc.search_text
    assert "MetLife Foundation" in doc.search_text
    assert "Major donor" in doc.search_text


@pytest.mark.asyncio
async def test_compose_pebble_profile_in_progress_returns_none():
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value={
        "id": "sess-2", "contact_id": "003ABC",
        "prospect_name": "X", "prospect_org": "Y",
        "tier": "T1", "status": "in_progress",   # not 'completed'
        "batch_id": None, "profile_json": None,
        "created_at": datetime.now(timezone.utc),
    })
    assert await si.compose_pebble_profile(conn, "sess-2") is None


@pytest.mark.asyncio
async def test_compose_pebble_profile_handles_invalid_json():
    """Bad JSON in profile_json must NOT crash the composer."""
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value={
        "id": "sess-3", "contact_id": "003ABC",
        "prospect_name": "Acme", "prospect_org": None,
        "tier": None, "status": "completed", "batch_id": None,
        "profile_json": "{not valid json",
        "created_at": datetime.now(timezone.utc),
    })
    doc = await si.compose_pebble_profile(conn, "sess-3")
    assert doc is not None
    assert doc.title == "Acme"


# ---------------------------------------------------------------------------
# D + E + F + G + H. drain_once
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_drain_once_upserts_and_dequeues(mock_pool_with_conn, fresh_registry):
    pool, conn = mock_pool_with_conn

    async def fake_composer(c, eid):
        return si.SearchDocRow(
            entity_type="bedrock_test", entity_id=eid,
            title=f"Title {eid}", subtitle=None, href=f"/test/{eid}",
            search_text=f"text {eid}",
        )
    si.register_composer("bedrock_test", fake_composer)

    conn.fetch.return_value = [
        {"id": 1, "entity_type": "bedrock_test", "entity_id": "e1", "op": "upsert", "attempt_count": 0},
    ]

    stats = await si.drain_once(pool, batch_size=10)

    assert stats.rows_processed == 1
    assert stats.rows_upserted == 1
    assert stats.rows_errored == 0

    # An UPSERT and a DELETE FROM queue both happened.
    sqls = [call.args[0] for call in conn.execute.call_args_list]
    assert any("INSERT INTO bedrock.search_doc" in s for s in sqls)
    assert any("DELETE FROM bedrock.search_index_queue" in s for s in sqls)


@pytest.mark.asyncio
async def test_drain_once_handles_delete_op(mock_pool_with_conn):
    pool, conn = mock_pool_with_conn
    conn.fetch.return_value = [
        {"id": 7, "entity_type": "bedrock_project", "entity_id": "abc",
         "op": "delete", "attempt_count": 0},
    ]
    stats = await si.drain_once(pool)
    assert stats.rows_deleted == 1
    sqls = [call.args[0] for call in conn.execute.call_args_list]
    assert any("UPDATE bedrock.search_doc" in s and "deleted_at = now()" in s for s in sqls)


@pytest.mark.asyncio
async def test_drain_once_no_composer_leaves_queue_intact(mock_pool_with_conn, fresh_registry):
    """Queue row for an unregistered entity_type stays in the queue
    without a failure bump. Future workers with the composer will
    process it."""
    pool, conn = mock_pool_with_conn
    si.clear_registry()    # remove built-ins for this test

    conn.fetch.return_value = [
        {"id": 1, "entity_type": "bedrock_unknown", "entity_id": "x",
         "op": "upsert", "attempt_count": 0},
    ]

    stats = await si.drain_once(pool)
    assert stats.rows_no_composer == 1
    # No DELETE on queue, no UPDATE attempt_count.
    sqls = [call.args[0] for call in conn.execute.call_args_list]
    assert not any("DELETE FROM bedrock.search_index_queue" in s for s in sqls)
    assert not any("UPDATE bedrock.search_index_queue" in s for s in sqls)


@pytest.mark.asyncio
async def test_drain_once_composer_error_bumps_attempt_count(mock_pool_with_conn, fresh_registry):
    pool, conn = mock_pool_with_conn

    async def boom(c, eid):
        raise RuntimeError("intentional boom")
    si.register_composer("bedrock_boom", boom)

    conn.fetch.return_value = [
        {"id": 5, "entity_type": "bedrock_boom", "entity_id": "x",
         "op": "upsert", "attempt_count": 1},
    ]
    stats = await si.drain_once(pool)
    assert stats.rows_errored == 1
    sqls = [call.args[0] for call in conn.execute.call_args_list]
    assert any("UPDATE bedrock.search_index_queue" in s and "attempt_count" in s for s in sqls)
    assert any("intentional boom" in str(call.args) for call in conn.execute.call_args_list)


@pytest.mark.asyncio
async def test_drain_once_excludes_rows_past_max_attempt(mock_pool_with_conn):
    pool, conn = mock_pool_with_conn
    await si.drain_once(pool)
    # The SELECT MUST contain attempt_count < $1 with $1 = MAX_ATTEMPT_COUNT.
    sent_sql = conn.fetch.call_args.args[0]
    assert "attempt_count < $1" in sent_sql
    assert si.MAX_ATTEMPT_COUNT in conn.fetch.call_args.args


# ---------------------------------------------------------------------------
# I + J. backfill
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_backfill_enqueues_all_source_rows(mock_pool_with_conn):
    pool, conn = mock_pool_with_conn

    # 3 source rows total (one batch).
    conn.fetchval.return_value = 3
    conn.fetch.side_effect = [
        [{"id": "p1"}, {"id": "p2"}, {"id": "p3"}],
        [],
    ]

    progress_calls: list[tuple[int, int]] = []
    enqueued = await si.backfill(
        pool, "bedrock_project", batch_size=500,
        progress_cb=lambda d, t: progress_calls.append((d, t)),
    )
    assert enqueued == 3
    assert progress_calls == [(3, 3)]
    conn.executemany.assert_awaited_once()


@pytest.mark.asyncio
async def test_backfill_rejects_unregistered_entity_type(mock_pool_with_conn):
    pool, _ = mock_pool_with_conn
    with pytest.raises(ValueError, match="No composer registered"):
        await si.backfill(pool, "totally_unregistered")
