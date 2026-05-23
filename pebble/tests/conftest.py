"""Pebble test configuration — ensure imports resolve correctly."""

import os
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

# Add project root to sys.path so `from pebble.xxx import ...` works
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))


@pytest.fixture(autouse=True)
def _chisel_real_autoload():
    """Restore the chisel workflow maps to the real ``pebble/chisel/``
    tree before each test. Framework tests in ``test_chisel_framework.py``
    call ``autoload(root=tmp_path)`` which resets the maps to a temp
    tree — without this fixture, the next test reads stale state."""
    from pebble import chisel
    chisel.autoload()


@pytest.fixture
def mock_pg_pool(monkeypatch):
    """Mock asyncpg connection pool for unit tests.

    Returns the mock connection object so tests can configure
    fetchrow/fetch/execute return values.
    """
    pool = MagicMock()
    conn = AsyncMock()

    # Make pool.acquire() work as async context manager
    acm = AsyncMock()
    acm.__aenter__ = AsyncMock(return_value=conn)
    acm.__aexit__ = AsyncMock(return_value=False)
    pool.acquire.return_value = acm

    monkeypatch.setattr("pebble.storage.db._pool", pool)
    return conn
