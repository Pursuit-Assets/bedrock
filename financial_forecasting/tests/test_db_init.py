"""Tests for db.init_db() fail-fast behavior on missing DATABASE_URL.

The prior implementation silently fell back to localhost if DATABASE_URL
was not set. That caused the 2026-04-17 data-drift incident where a dev
session wrote goals to local Postgres while teammates read from the shared
DB. After db.py's fix, init_db refuses to start without an explicit
DATABASE_URL and leaves the pool unset, which makes every DB-backed route
return 503 (via get_db's existing check).
"""

import sys
import os
import asyncio
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import db as db_module
from db import init_db, get_db_status, get_pool


@pytest.fixture(autouse=True)
def reset_db_module_state():
    """Reset db.py's module-level globals before each test so state from one
    test cannot leak into another. Mirrors the private-attr shape exactly."""
    db_module._pool = None
    db_module._db_init_status = "not_started"
    yield
    db_module._pool = None
    db_module._db_init_status = "not_started"


@pytest.fixture
def no_asyncpg_connect():
    """Fail loudly if the fail-fast path accidentally reaches asyncpg. This
    guards against a regression where someone removes the early-return
    check but leaves the error log in place — the test would still pass if
    we only checked get_db_status, but it would also silently hit the real
    network."""
    with patch("db.asyncpg.create_pool", side_effect=AssertionError(
        "asyncpg.create_pool must not be called when DATABASE_URL is missing — "
        "the fail-fast guard in init_db regressed"
    )) as mock:
        yield mock


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if hasattr(
        asyncio, "get_event_loop"
    ) else asyncio.run(coro)


class TestInitDbRequiresDatabaseUrl:
    """init_db must refuse to start without an explicit DATABASE_URL."""

    def test_refuses_missing_database_url(self, monkeypatch, no_asyncpg_connect):
        """DATABASE_URL unset → disconnected, no pool, no asyncpg call."""
        monkeypatch.delenv("DATABASE_URL", raising=False)
        asyncio.run(init_db())
        assert get_db_status() == "disconnected"
        assert db_module._pool is None
        assert no_asyncpg_connect.call_count == 0
        # get_pool() should raise 503 when the pool is None
        with pytest.raises(Exception) as exc_info:
            get_pool()
        assert "503" in str(exc_info.value) or "not available" in str(exc_info.value)

    def test_refuses_empty_database_url(self, monkeypatch, no_asyncpg_connect):
        """DATABASE_URL="" → disconnected."""
        monkeypatch.setenv("DATABASE_URL", "")
        asyncio.run(init_db())
        assert get_db_status() == "disconnected"
        assert db_module._pool is None
        assert no_asyncpg_connect.call_count == 0

    def test_refuses_whitespace_only_database_url(self, monkeypatch, no_asyncpg_connect):
        """DATABASE_URL of whitespace → disconnected. Prevents a .env with a
        trailing space (or a copy-paste with an invisible char) from slipping
        through as if the value were set."""
        monkeypatch.setenv("DATABASE_URL", "   \t  ")
        asyncio.run(init_db())
        assert get_db_status() == "disconnected"
        assert db_module._pool is None
        assert no_asyncpg_connect.call_count == 0
