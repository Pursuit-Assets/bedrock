"""Tests for ``ModelClient`` cache-aware token capture + cost calc.

Wave 0 of the L2 Research Swarm plan (§4.12).

The integration path is: Anthropic SDK ``response.usage`` →
``ModelClient._last_usage`` (four fields) → ``HarnessResult.tokens_used``
→ ``pebble_harness_log`` row (cache_creation_input_tokens +
cache_read_input_tokens columns added in
2026-05-18-pebble-ledger-instrumentation.sql) → ledger event.

These tests pin the four-field shape and the cache-aware delegation
to ``pebble.llm.cost.calculate_cost_usd``. The canonical math itself
is exhaustively tested in ``test_llm_cost.py`` — we just verify the
delegation wiring + that legacy two-field input dicts still work.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from pebble.model_client import ModelClient


@pytest.fixture
def client(monkeypatch):
    """ModelClient with the Anthropic SDK init bypassed."""
    monkeypatch.setattr("pebble.model_client.Anthropic", lambda: object())
    return ModelClient()


# ---------------------------------------------------------------------------
# Default _last_usage shape — four fields, all zero
# ---------------------------------------------------------------------------

def test_last_usage_has_four_fields(client):
    """Fresh ModelClient exposes the four-field token dict."""
    assert set(client._last_usage.keys()) == {"input", "output", "cache_create", "cache_read"}
    assert all(v == 0 for v in client._last_usage.values())


# ---------------------------------------------------------------------------
# calculate_cost delegates to canonical pricing — model lookups by agent
# ---------------------------------------------------------------------------

def test_calculate_cost_sonnet_input_only(client):
    """Sonnet agent + 1Mtok input → $3.00 (matches MODEL_RATES table)."""
    client._last_provider = "anthropic/claude-sonnet-4-6"
    cost = client.calculate_cost(
        "philanthropy_agent",   # FORAGER tier → Sonnet 4.6
        {"input": 1_000_000, "output": 0, "cache_create": 0, "cache_read": 0},
    )
    assert cost == pytest.approx(3.0, rel=1e-6)


def test_calculate_cost_haiku_output_only(client):
    """Haiku agent + 1Mtok output → $5.00."""
    client._last_provider = "anthropic/claude-haiku-4-5-20251001"
    cost = client.calculate_cost(
        "verifier_source",      # WORKER tier → Haiku 4.5
        {"input": 0, "output": 1_000_000, "cache_create": 0, "cache_read": 0},
    )
    assert cost == pytest.approx(5.0, rel=1e-6)


def test_calculate_cost_cache_create_at_1_25x(client):
    """Sonnet + 1Mtok cache_create → $3.75 (input × 1.25)."""
    client._last_provider = "anthropic/claude-sonnet-4-6"
    cost = client.calculate_cost(
        "philanthropy_agent",
        {"input": 0, "output": 0, "cache_create": 1_000_000, "cache_read": 0},
    )
    assert cost == pytest.approx(3.75, rel=1e-6)


def test_calculate_cost_cache_read_at_0_10x(client):
    """Sonnet + 1Mtok cache_read → $0.30 (input × 0.10 — the 10x cut).

    This is the Plan §4.12 step 10 assertion: "cassette response with
    cache_read_input_tokens=4000 produces cost_cache_read_usd =
    4000 × 0.30 / 1e6 = $0.0012 and not the uncached rate".
    """
    client._last_provider = "anthropic/claude-sonnet-4-6"
    cost = client.calculate_cost(
        "philanthropy_agent",
        {"input": 0, "output": 0, "cache_create": 0, "cache_read": 1_000_000},
    )
    assert cost == pytest.approx(0.30, rel=1e-6)


def test_calculate_cost_plan_412_step_10_assertion(client):
    """Exact wording from Plan §4.12 step 10."""
    client._last_provider = "anthropic/claude-sonnet-4-6"
    cost = client.calculate_cost(
        "philanthropy_agent",
        {"input": 0, "output": 0, "cache_create": 0, "cache_read": 4000},
    )
    # Plan: 4000 × $0.30 / 1e6 = $0.0012
    assert cost == pytest.approx(0.0012, abs=1e-7)


def test_calculate_cost_mixed_four_fields_sum(client):
    """Mixed call: fresh in + output + cache_create + cache_read = sum."""
    client._last_provider = "anthropic/claude-sonnet-4-6"
    cost = client.calculate_cost(
        "philanthropy_agent",
        {
            "input": 500_000,            # 500K × $3 = $1.50
            "output": 200_000,           # 200K × $15 = $3.00
            "cache_create": 100_000,     # 100K × $3.75 = $0.375
            "cache_read": 400_000,       # 400K × $0.30 = $0.12
        },
    )
    # Expected: $1.50 + $3.00 + $0.375 + $0.12 = $4.995
    assert cost == pytest.approx(4.995, rel=1e-6)


# ---------------------------------------------------------------------------
# Backwards compatibility — legacy two-field tokens dict still works
# ---------------------------------------------------------------------------

def test_calculate_cost_legacy_two_field_tokens(client):
    """Callers that haven't migrated to the four-field shape still work.

    Missing cache fields default to 0 — no behavior change vs the
    pre-Wave-0 calculate_cost.
    """
    client._last_provider = "anthropic/claude-sonnet-4-6"
    cost = client.calculate_cost(
        "philanthropy_agent",
        {"input": 500_000, "output": 200_000},
    )
    # Same as $1.50 + $3.00 = $4.50, no cache surcharges
    assert cost == pytest.approx(4.50, rel=1e-6)


# ---------------------------------------------------------------------------
# OpenRouter free-tier short-circuit — $0 even with token counts
# ---------------------------------------------------------------------------

def test_openrouter_free_tier_costs_zero(client):
    """OpenRouter free-tier hits return $0 regardless of token count."""
    client._last_provider = "openrouter/nvidia/nemotron-3-super-120b-a12b:free"
    cost = client.calculate_cost(
        "verifier_source",
        {"input": 1_000_000, "output": 1_000_000, "cache_create": 0, "cache_read": 0},
    )
    assert cost == 0.0
