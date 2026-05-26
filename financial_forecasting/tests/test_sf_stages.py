"""Tests for ``services/sf_stages.py`` — Phase 0.9 canonical stage source.

Invariants:

A. ``get_stages`` returns the static fallback list when no db_conn is provided.
B. Cache reads on the second call when fresh.
C. DB read is preferred when a connection is provided and cache is empty.
D. DB read failure falls through to static fallback (logged but not raised).
E. ``get_entry_stage`` returns the configured entry stage per record type.
F. Bucket predicates (`is_revenue_earning`, `is_open`, `is_closed`, `is_lost`)
   match the documented set semantics. Code using `if stage in BUCKET` keeps
   working without changes.
G. Bucket sets are immutable (frozenset) so accidental .add() raises.
"""

import os
import sys
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from services import sf_stages


@pytest.fixture(autouse=True)
def _clear_cache():
    sf_stages.clear_cache()
    yield
    sf_stages.clear_cache()


# ---------------------------------------------------------------------------
# A. Static fallback
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_stages_static_fallback_default():
    stages = await sf_stages.get_stages()
    assert stages[0] == "Lead Gen"
    assert "New Lead" in stages
    assert "Closed Won" in stages


@pytest.mark.asyncio
async def test_get_stages_unknown_record_type_returns_empty():
    stages = await sf_stages.get_stages("NonexistentRecordType")
    assert stages == ()


# ---------------------------------------------------------------------------
# B. Process-local cache
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cache_hit_avoids_db_on_second_call():
    fake_conn = AsyncMock()
    fake_conn.fetch = AsyncMock(return_value=[
        {"value": "Lead Gen"},
        {"value": "Closed Won"},
    ])
    s1 = await sf_stages.get_stages("Philanthropy", db_conn=fake_conn)
    s2 = await sf_stages.get_stages("Philanthropy", db_conn=fake_conn)
    assert s1 == s2 == ("Lead Gen", "Closed Won")
    fake_conn.fetch.assert_awaited_once()


@pytest.mark.asyncio
async def test_clear_cache_forces_refetch():
    fake_conn = AsyncMock()
    fake_conn.fetch = AsyncMock(return_value=[{"value": "Lead Gen"}])
    await sf_stages.get_stages("Philanthropy", db_conn=fake_conn)
    sf_stages.clear_cache()
    await sf_stages.get_stages("Philanthropy", db_conn=fake_conn)
    assert fake_conn.fetch.await_count == 2


# ---------------------------------------------------------------------------
# C. DB read preferred when present
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_db_read_preferred_over_static_when_present():
    fake_conn = AsyncMock()
    fake_conn.fetch = AsyncMock(return_value=[
        {"value": "Custom Stage One"},
        {"value": "Custom Stage Two"},
    ])
    stages = await sf_stages.get_stages("Philanthropy", db_conn=fake_conn)
    assert stages == ("Custom Stage One", "Custom Stage Two")


# ---------------------------------------------------------------------------
# D. DB error falls through to static
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_db_error_falls_through_to_static():
    fake_conn = AsyncMock()
    fake_conn.fetch = AsyncMock(side_effect=RuntimeError("DB unreachable"))
    stages = await sf_stages.get_stages("Philanthropy", db_conn=fake_conn)
    # Static fallback returns the documented Philanthropy list.
    assert "Lead Gen" in stages
    assert stages[0] == "Lead Gen"


@pytest.mark.asyncio
async def test_empty_db_result_falls_through_to_static():
    """Empty DB response (refresh job hasn't run yet, or all rows stale)
    falls through to static — never returns empty for a known record type."""
    fake_conn = AsyncMock()
    fake_conn.fetch = AsyncMock(return_value=[])
    stages = await sf_stages.get_stages("Philanthropy", db_conn=fake_conn)
    assert stages != ()
    assert "Lead Gen" in stages


# ---------------------------------------------------------------------------
# E. Entry stage
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_entry_stage_philanthropy():
    assert await sf_stages.get_entry_stage("Philanthropy") == "New Lead"


@pytest.mark.asyncio
async def test_entry_stage_unknown_record_type_is_none():
    assert await sf_stages.get_entry_stage("PBC") is None


# ---------------------------------------------------------------------------
# F. Bucket predicates
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("stage,expected", [
    ("Closed Won", True),
    ("Closed / Fulfilled", True),
    ("New Lead", False),
    ("Closed Lost", False),
    ("Withdrawn", False),
    ("Some Random Future Stage", False),
])
def test_is_revenue_earning(stage, expected):
    assert sf_stages.is_revenue_earning(stage) is expected


@pytest.mark.parametrize("stage,expected", [
    ("New Lead", True),
    ("Ask in Progress", True),
    ("Contracting", True),
    ("Closed Won", False),
    ("Closed Lost", False),
])
def test_is_open(stage, expected):
    assert sf_stages.is_open(stage) is expected


@pytest.mark.parametrize("stage,expected", [
    ("Closed Won", True),
    ("Closed Lost", True),
    ("Closed / Fulfilled", True),
    ("Withdrawn", True),
    ("New Lead", False),
])
def test_is_closed(stage, expected):
    assert sf_stages.is_closed(stage) is expected


@pytest.mark.parametrize("stage,expected", [
    ("Closed Lost", True),
    ("Withdrawn", True),
    ("Closed Won", False),
    ("Closed / Fulfilled", False),
])
def test_is_lost(stage, expected):
    assert sf_stages.is_lost(stage) is expected


# ---------------------------------------------------------------------------
# G. Frozen sets
# ---------------------------------------------------------------------------

def test_buckets_are_frozen():
    """Code mutating these sets is a bug — frozenset raises."""
    with pytest.raises(AttributeError):
        sf_stages.REVENUE_EARNING_STAGES.add("Sneaky Stage")  # type: ignore[attr-defined]
    with pytest.raises(AttributeError):
        sf_stages.OPEN_PIPELINE_STAGES.add("X")  # type: ignore[attr-defined]


def test_bucket_set_semantics_handle_unknown_stages():
    """``if stage in BUCKET:`` returns False for stages we don't know
    about — consistent with set membership semantics. The static
    fallback / cache content can grow without code changes."""
    assert "Stage From The Future" not in sf_stages.OPEN_PIPELINE_STAGES
    assert "Stage From The Future" not in sf_stages.CLOSED_STAGES
    # And the predicates match.
    assert sf_stages.is_open("Stage From The Future") is False
    assert sf_stages.is_closed("Stage From The Future") is False


def test_bucket_invariants_no_overlap_revenue_lost():
    """A stage cannot be simultaneously revenue-earning and lost."""
    overlap = sf_stages.REVENUE_EARNING_STAGES & sf_stages.LOST_STAGES
    assert overlap == frozenset()


def test_bucket_invariants_revenue_implies_closed():
    """Every revenue-earning stage must be a closed stage."""
    assert sf_stages.REVENUE_EARNING_STAGES.issubset(sf_stages.CLOSED_STAGES)


def test_bucket_invariants_lost_implies_closed():
    """Every lost stage must be a closed stage."""
    assert sf_stages.LOST_STAGES.issubset(sf_stages.CLOSED_STAGES)


def test_bucket_invariants_open_disjoint_closed():
    """Open and closed are mutually exclusive."""
    assert sf_stages.OPEN_PIPELINE_STAGES & sf_stages.CLOSED_STAGES == frozenset()
