"""Tests for ``pebble.orchestrator.budget`` — bounded autonomy guard.

Asserts:
  A. Default caps come from constants / env.
  B. ``check()`` returns None when nothing's spent.
  C. Each cap (calls / cost / wall) trips ``check()`` independently.
  D. ``charge()`` accumulates; negative charges raise.
  E. ``can_afford()`` pre-flight gates plans that would exceed caps.
  F. ``elapsed_seconds()`` uses monotonic time (not wall — DST-safe).
  G. ``to_dict()`` snapshot has the right shape for scratchpad payload.
"""

import os
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.orchestrator.budget import Budget


# ---------------------------------------------------------------------------
# A. Defaults
# ---------------------------------------------------------------------------

def test_default_budget_has_documented_caps():
    b = Budget()
    assert b.max_tool_calls == 20
    assert b.max_cost_usd == 0.50
    assert b.max_wall_seconds == 60.0
    assert b.spent_tool_calls == 0
    assert b.spent_cost_usd == 0.0


# ---------------------------------------------------------------------------
# B. check() initial state
# ---------------------------------------------------------------------------

def test_check_returns_none_when_empty():
    assert Budget().check() is None


# ---------------------------------------------------------------------------
# C. Each cap trips independently
# ---------------------------------------------------------------------------

def test_check_trips_on_tool_call_exhaustion():
    b = Budget(max_tool_calls=3)
    b.charge(calls=3)
    halt = b.check()
    assert halt is not None
    assert "tool_call_budget_exhausted" in halt
    assert "3" in halt   # spent count


def test_check_trips_on_cost_exhaustion():
    b = Budget(max_cost_usd=0.10)
    b.charge(cost_usd=0.10)
    halt = b.check()
    assert halt is not None
    assert "cost_budget_exhausted" in halt


def test_check_trips_on_wall_clock_exhaustion():
    b = Budget(max_wall_seconds=0.001)
    time.sleep(0.005)
    halt = b.check()
    assert halt is not None
    assert "wall_clock_budget_exhausted" in halt


def test_check_does_not_trip_within_caps():
    b = Budget(max_tool_calls=10, max_cost_usd=1.0, max_wall_seconds=60.0)
    b.charge(calls=5, cost_usd=0.30)
    assert b.check() is None


# ---------------------------------------------------------------------------
# D. charge() semantics
# ---------------------------------------------------------------------------

def test_charge_accumulates():
    b = Budget()
    b.charge(calls=2, cost_usd=0.05)
    b.charge(calls=3, cost_usd=0.10)
    assert b.spent_tool_calls == 5
    assert b.spent_cost_usd == pytest.approx(0.15)


def test_charge_zero_args_is_noop():
    b = Budget()
    b.charge()
    assert b.spent_tool_calls == 0
    assert b.spent_cost_usd == 0.0


@pytest.mark.parametrize("calls,cost", [
    (-1, 0), (0, -0.01), (-5, -1.0),
])
def test_charge_rejects_negative(calls, cost):
    """Failed steps still cost something; pass 0 for free tools, never
    negative. Negative would be a bug in the caller."""
    b = Budget()
    with pytest.raises(ValueError, match=r"non-negative"):
        b.charge(calls=calls, cost_usd=cost)


# ---------------------------------------------------------------------------
# E. can_afford() pre-flight
# ---------------------------------------------------------------------------

def test_can_afford_returns_none_when_within_caps():
    b = Budget(max_tool_calls=10)
    assert b.can_afford(calls=5) is None


def test_can_afford_blocks_when_plan_exceeds_calls():
    b = Budget(max_tool_calls=10)
    b.charge(calls=8)
    halt = b.can_afford(calls=5)
    assert halt is not None
    assert "plan_exceeds_tool_call_budget" in halt
    assert "13" in halt   # would-be total


def test_can_afford_blocks_when_plan_exceeds_cost():
    b = Budget(max_cost_usd=1.00)
    b.charge(cost_usd=0.80)
    halt = b.can_afford(cost_usd=0.50)
    assert halt is not None
    assert "plan_exceeds_cost_budget" in halt


def test_can_afford_zero_charge_returns_none():
    b = Budget()
    assert b.can_afford(calls=0, cost_usd=0.0) is None


# ---------------------------------------------------------------------------
# F. Monotonic time
# ---------------------------------------------------------------------------

def test_elapsed_uses_monotonic_not_wall():
    """Don't use datetime.now or time.time — those can jump backward
    on NTP sync or DST transitions, breaking budgets."""
    import inspect

    from pebble.orchestrator import budget as budget_mod
    src = inspect.getsource(budget_mod)
    assert "time.monotonic" in src
    # And we should NOT use time.time() for elapsed math.
    assert "time.time()" not in src


def test_elapsed_returns_positive():
    b = Budget()
    time.sleep(0.01)
    assert b.elapsed_seconds() >= 0.01


# ---------------------------------------------------------------------------
# G. to_dict() snapshot
# ---------------------------------------------------------------------------

def test_to_dict_has_all_fields():
    b = Budget()
    b.charge(calls=2, cost_usd=0.05)
    snap = b.to_dict()
    assert set(snap.keys()) >= {
        "max_tool_calls", "max_cost_usd", "max_wall_seconds",
        "spent_tool_calls", "spent_cost_usd", "elapsed_seconds",
        "tool_calls", "cost_usd", "wall_seconds",
    }
    assert snap["spent_tool_calls"] == 2
    assert snap["spent_cost_usd"] == pytest.approx(0.05)
    assert snap["tool_calls"] == 18      # remaining


def test_remaining_clamps_to_zero():
    b = Budget(max_tool_calls=2)
    b.charge(calls=5)         # over-spend (e.g. last step charged after halt)
    rem = b.remaining()
    assert rem["tool_calls"] == 0   # never goes negative
