"""Token-usage → USD cost calculation for Anthropic models.

Pure module — no SDK dependency, easy to unit-test, easy to keep in
sync with Anthropic's published price list. Lives separately from
``anthropic_client.py`` so the cost path can be tested without an
``anthropic`` install in the test environment.

Pricing surface
---------------

Anthropic charges separately for:

  * regular input tokens   (``usage.input_tokens``)
  * output tokens          (``usage.output_tokens``)
  * cache creation tokens  (``usage.cache_creation_input_tokens``) —
                            one-time cost to write tokens into the
                            5-minute ephemeral cache; charged at
                            ~1.25× the regular input rate.
  * cache read tokens      (``usage.cache_read_input_tokens``) —
                            charged at ~0.10× the regular input rate
                            (the 90% discount that makes prompt
                            caching worth the line of code).

Pricing values reflect Anthropic's published rates for Claude 4.x
models (per the model_client.py canonical reference). Update this
table when Anthropic announces price changes.

Why we keep our own table instead of asking Anthropic at runtime:

  * The Anthropic API does not return per-call cost — only token
    counts. Cost = client-side multiply.
  * Our daily-cap enforcement (``pebble_proxy.py``) reads cost from
    our scratchpad rows. The cost we record IS the source of truth
    for cap calculations.
  * If Anthropic changes pricing, we update one place + redeploy;
    the dashboards keep working.

The ``calculate_cost_usd`` function is intentionally tolerant of
unknown models — falls back to a conservative high-water rate so
unmodeled traffic doesn't show as $0 (which would mask a budget
issue).
"""

from __future__ import annotations

from dataclasses import dataclass


# ---------------------------------------------------------------------------
# Rate table — USD per million tokens (per Anthropic's published pricing).
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ModelRates:
    """Per-million-token USD rates for one Claude model."""

    input_per_mtok: float
    output_per_mtok: float
    # Cache write is typically input × 1.25; we encode the factor so
    # one source of truth governs the math. Anthropic may publish an
    # absolute rate later — switch to that here.
    cache_write_factor: float = 1.25
    cache_read_factor: float = 0.10

    def cache_write_per_mtok(self) -> float:
        return self.input_per_mtok * self.cache_write_factor

    def cache_read_per_mtok(self) -> float:
        return self.input_per_mtok * self.cache_read_factor


# Canonical model → rates. Mirrors ``pebble/model_client.py:TIER_CONFIGS``
# but keyed by model_id rather than tier so callers don't need to know
# the tier system. New Claude models land here when Anthropic ships them.
MODEL_RATES: dict[str, ModelRates] = {
    # Claude Haiku 4.5 — fast, cheap. Used for evaluator + classifier.
    "claude-haiku-4-5-20251001": ModelRates(
        input_per_mtok=1.0, output_per_mtok=5.0,
    ),
    # Claude Sonnet 4.6 — used for the planner.
    "claude-sonnet-4-6": ModelRates(
        input_per_mtok=3.0, output_per_mtok=15.0,
    ),
    # Claude Opus 4.6 — reserved for QUEEN-tier in the prospect-research
    # pipeline. Listed here so any future orchestrator escalation path
    # has a price.
    "claude-opus-4-6": ModelRates(
        input_per_mtok=15.0, output_per_mtok=75.0,
    ),
}


# Conservative fallback for unknown models. Kept at the high end of the
# 4.x family so unmodeled cost shows up larger than it should rather
# than smaller — a budget alarm we'd rather over-trip than miss.
_FALLBACK_RATES = ModelRates(input_per_mtok=15.0, output_per_mtok=75.0)


# ---------------------------------------------------------------------------
# Cost calculation
# ---------------------------------------------------------------------------

def calculate_cost_usd(
    *,
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
) -> float:
    """Compute USD cost for one Anthropic Messages API call.

    Args
        model: the model id Anthropic returned (e.g. ``claude-sonnet-4-6``).
            Unknown models fall back to ``_FALLBACK_RATES`` — overestimate
            rather than underestimate.
        input_tokens: ``usage.input_tokens`` from the response — regular
            (non-cached, non-creation) input.
        output_tokens: ``usage.output_tokens`` from the response.
        cache_creation_input_tokens: tokens written INTO the cache this
            call; charged at ``cache_write_factor`` × input rate.
        cache_read_input_tokens: tokens served FROM the cache this
            call; charged at ``cache_read_factor`` × input rate.

    Returns
        Total cost in USD as a float. Always ≥ 0.

    Behavior contracts:
        * Negative token counts are clamped to 0 (defensive — Anthropic
          shouldn't return negatives but we don't trust upstream).
        * Unknown models log nothing (this is a hot path); the fallback
          table makes sure cost > 0 if any tokens flowed.
        * Returns ``0.0`` only when every token count is 0 — i.e. an
          actual zero-token call (rare; possible on instant rejection).
    """
    rates = MODEL_RATES.get(model, _FALLBACK_RATES)

    inp = max(0, int(input_tokens or 0))
    out = max(0, int(output_tokens or 0))
    cw = max(0, int(cache_creation_input_tokens or 0))
    cr = max(0, int(cache_read_input_tokens or 0))

    cost = (
        (inp / 1_000_000.0) * rates.input_per_mtok
        + (out / 1_000_000.0) * rates.output_per_mtok
        + (cw / 1_000_000.0) * rates.cache_write_per_mtok()
        + (cr / 1_000_000.0) * rates.cache_read_per_mtok()
    )
    # Round to 6 decimal places (sub-cent precision; matches the
    # NUMERIC(10,6) column in bedrock.pebble_chat_scratchpad).
    return round(cost, 6)
