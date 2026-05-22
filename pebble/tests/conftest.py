"""Pebble test configuration — ensure imports resolve correctly."""

import os
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

# Add project root to sys.path so `from pebble.xxx import ...` works
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))


@pytest.fixture(autouse=True)
def _chisel_real_autoload():
    """Ensure the chisel module-level slash / intent / plan-builder maps
    point at the real ``pebble/chisel/`` tree at the start of every test.

    Framework tests in ``test_chisel_framework.py`` call ``autoload(root=
    tmp_path)`` which resets those maps to the temp tree's contents; that
    leaves later tests reading from stale state. Re-running autoload
    before each test (and after) keeps router / streaming tests reading
    the real ``/pipeline`` workflow."""
    from pebble import chisel
    chisel.autoload()
    yield
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
