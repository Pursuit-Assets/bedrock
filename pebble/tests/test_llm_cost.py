"""Tests for ``pebble.llm.cost`` — token-usage → USD calculation.

Asserts:
  A. Known model + only regular input → cost matches rate × tokens.
  B. Output tokens factored at output_per_mtok rate.
  C. Cache creation tokens charged at 1.25× input rate.
  D. Cache read tokens charged at 0.10× input rate (the 90% discount).
  E. Mixed call (input + output + cache_create + cache_read) sums correctly.
  F. Unknown model falls back to high-water rate (≥ Sonnet's rate).
  G. Negative token counts clamped to 0.
  H. None values for any field default to 0.
  I. Zero everywhere → exactly 0.0.
  J. ModelRates.cache_write_per_mtok / cache_read_per_mtok arithmetic.
  K. All canonical models in MODEL_RATES have positive rates.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.llm.cost import (
    MODEL_RATES,
    ModelRates,
    calculate_cost_usd,
)


# ---------------------------------------------------------------------------
# A. Known model + regular input only
# ---------------------------------------------------------------------------

def test_known_model_input_only():
    cost = calculate_cost_usd(
        model="claude-sonnet-4-6",
        input_tokens=1_000_000, output_tokens=0,
    )
    # Sonnet input = $3/Mtok → $3 for exactly 1M
    assert cost == pytest.approx(3.0, rel=1e-6)


def test_haiku_input_only():
    cost = calculate_cost_usd(
        model="claude-haiku-4-5-20251001",
        input_tokens=1_000_000, output_tokens=0,
    )
    assert cost == pytest.approx(1.0, rel=1e-6)


# ---------------------------------------------------------------------------
# B. Output tokens
# ---------------------------------------------------------------------------

def test_output_tokens_billed_at_output_rate():
    cost = calculate_cost_usd(
        model="claude-sonnet-4-6",
        input_tokens=0, output_tokens=1_000_000,
    )
    # Sonnet output = $15/Mtok
    assert cost == pytest.approx(15.0, rel=1e-6)


# ---------------------------------------------------------------------------
# C. Cache creation tokens — 1.25× input rate
# ---------------------------------------------------------------------------

def test_cache_creation_tokens_billed_at_1_25x_input():
    cost = calculate_cost_usd(
        model="claude-sonnet-4-6",
        cache_creation_input_tokens=1_000_000,
    )
    # Sonnet input × 1.25 = $3 × 1.25 = $3.75 per Mtok
    assert cost == pytest.approx(3.75, rel=1e-6)


# ---------------------------------------------------------------------------
# D. Cache read tokens — 0.10× input rate
# ---------------------------------------------------------------------------

def test_cache_read_tokens_billed_at_0_10x_input():
    cost = calculate_cost_usd(
        model="claude-sonnet-4-6",
        cache_read_input_tokens=1_000_000,
    )
    # Sonnet input × 0.10 = $0.30 per Mtok
    assert cost == pytest.approx(0.30, rel=1e-6)


def test_haiku_cache_read_at_0_10():
    cost = calculate_cost_usd(
        model="claude-haiku-4-5-20251001",
        cache_read_input_tokens=2_000_000,
    )
    # Haiku input × 0.10 × 2 = $0.20
    assert cost == pytest.approx(0.20, rel=1e-6)


# ---------------------------------------------------------------------------
# E. Mixed call — sum of all four components
# ---------------------------------------------------------------------------

def test_mixed_call_components_sum():
    cost = calculate_cost_usd(
        model="claude-sonnet-4-6",
        input_tokens=500_000,                     # 500K × $3 / 1M = $1.50
        output_tokens=200_000,                    # 200K × $15 / 1M = $3.00
        cache_creation_input_tokens=100_000,      # 100K × $3.75 / 1M = $0.375
        cache_read_input_tokens=400_000,          # 400K × $0.30 / 1M = $0.12
    )
    expected = 1.50 + 3.00 + 0.375 + 0.12  # = 4.995
    assert cost == pytest.approx(expected, rel=1e-6)


def test_typical_planner_call_cost_under_one_cent():
    """A typical planner request uses ~500 input + ~400 output tokens.
    With Sonnet rates, this should be a small fraction of a cent.
    """
    cost = calculate_cost_usd(
        model="claude-sonnet-4-6",
        input_tokens=500, output_tokens=400,
    )
    # 500 × $3/1M + 400 × $15/1M = $0.0015 + $0.006 = $0.0075
    assert cost < 0.01
    assert cost > 0


# ---------------------------------------------------------------------------
# F. Unknown model — high-water fallback
# ---------------------------------------------------------------------------

def test_unknown_model_uses_high_water_fallback():
    cost_unknown = calculate_cost_usd(
        model="claude-future-9-9",
        input_tokens=1_000_000,
    )
    cost_known_sonnet = calculate_cost_usd(
        model="claude-sonnet-4-6",
        input_tokens=1_000_000,
    )
    # Fallback should be at least as expensive as Sonnet — the point of
    # high-water fallback is to overestimate, never underestimate.
    assert cost_unknown >= cost_known_sonnet


# ---------------------------------------------------------------------------
# G. Negative tokens clamped to 0
# ---------------------------------------------------------------------------

def test_negative_tokens_clamped():
    cost = calculate_cost_usd(
        model="claude-sonnet-4-6",
        input_tokens=-10_000, output_tokens=-50,
    )
    assert cost == 0.0


# ---------------------------------------------------------------------------
# H. None defaults
# ---------------------------------------------------------------------------

def test_none_values_default_to_zero():
    cost = calculate_cost_usd(
        model="claude-sonnet-4-6",
        input_tokens=None,                # type: ignore[arg-type]
        output_tokens=None,                # type: ignore[arg-type]
        cache_creation_input_tokens=None,  # type: ignore[arg-type]
        cache_read_input_tokens=None,      # type: ignore[arg-type]
    )
    assert cost == 0.0


# ---------------------------------------------------------------------------
# I. All zero → 0.0
# ---------------------------------------------------------------------------

def test_all_zero_returns_zero():
    cost = calculate_cost_usd(model="claude-sonnet-4-6")
    assert cost == 0.0


# ---------------------------------------------------------------------------
# J. ModelRates arithmetic helpers
# ---------------------------------------------------------------------------

def test_model_rates_cache_write_arithmetic():
    rates = ModelRates(input_per_mtok=4.0, output_per_mtok=20.0)
    assert rates.cache_write_per_mtok() == pytest.approx(5.0)  # 4 × 1.25
    assert rates.cache_read_per_mtok() == pytest.approx(0.4)   # 4 × 0.10


def test_model_rates_overridable_factors():
    rates = ModelRates(
        input_per_mtok=10.0, output_per_mtok=50.0,
        cache_write_factor=2.0, cache_read_factor=0.5,
    )
    assert rates.cache_write_per_mtok() == pytest.approx(20.0)
    assert rates.cache_read_per_mtok() == pytest.approx(5.0)


# ---------------------------------------------------------------------------
# K. Canonical models all have positive rates
# ---------------------------------------------------------------------------

def test_all_canonical_models_have_positive_rates():
    assert MODEL_RATES, "MODEL_RATES table must not be empty"
    for model_id, rates in MODEL_RATES.items():
        assert rates.input_per_mtok > 0, f"{model_id} has non-positive input rate"
        assert rates.output_per_mtok > 0, f"{model_id} has non-positive output rate"
        assert rates.input_per_mtok < rates.output_per_mtok, (
            f"{model_id}: output should be more expensive than input — Anthropic "
            "has always priced output > input; if this changes, update test + table"
        )


def test_planner_default_model_in_rate_table():
    """The default planner model must be priced — otherwise we'd
    silently use the high-water fallback for every conversation.
    """
    assert "claude-sonnet-4-6" in MODEL_RATES


def test_evaluator_default_model_in_rate_table():
    assert "claude-haiku-4-5-20251001" in MODEL_RATES


# ---------------------------------------------------------------------------
# L. Rounding to 6 decimal places (matches NUMERIC(10,6) DB column)
# ---------------------------------------------------------------------------

def test_cost_rounded_to_six_decimals():
    cost = calculate_cost_usd(
        model="claude-haiku-4-5-20251001",
        input_tokens=7,  # 7 × $1 / 1M = $0.000007 — at the rounding edge
    )
    # 7e-6 rounded to 6 decimals = 0.000007
    assert cost == pytest.approx(0.000007, abs=1e-9)
    # Verify no extra precision sneaks through
    assert len(str(cost).split(".")[-1]) <= 6
