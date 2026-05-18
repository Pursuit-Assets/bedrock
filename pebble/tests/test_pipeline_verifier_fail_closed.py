"""Tests for the §4.11 fail-CLOSED fix in ``_pipeline.quorum_verify_claims``
and the §4.3 per-claim prefilter wiring.

Pins:
  A. A verifier that returns malformed JSON contributes ZERO approvals
     to the quorum (was: approve-everything, the §4.11 bug).
  B. A verifier that fails outright (timeout / retries / schema)
     contributes ZERO approvals.
  C. When all three quorum verifiers fail-closed simultaneously, no
     claim makes it through — synthesis sees the empty list.
  D. _prefilter_claims_per_claim drops rejected claims, admits parse-
     failed at low confidence, and skips when budget is exhausted.
  E. PEBBLE_PER_CLAIM_VERIFIER_DISABLED env-var disables the prefilter.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from pebble.harness import AgentOutcome, HarnessResult
from pebble.orchestrator._pipeline import (
    ProspectBudgetTracker,
    _per_claim_verifier_enabled,
    _prefilter_claims_per_claim,
    quorum_verify_claims,
)
from pebble.orchestrator.verifier import ClaimVerdict


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ok(content: str, cost: float = 0.0025) -> HarnessResult:
    return HarnessResult(
        outcome=AgentOutcome.SUCCESS,
        data={"content": content},
        cost_usd=cost,
        attempts=1,
    )


def _claim(text: str, url: str = "https://propublica.org/x") -> dict:
    return {"text": text, "source_url": url, "confidence": "medium", "origin": "template"}


# ---------------------------------------------------------------------------
# A. Quorum verifier — parse-broken output fails CLOSED (§4.11)
# ---------------------------------------------------------------------------

def test_quorum_verifier_parse_fail_drops_to_zero_approvals(monkeypatch):
    """Before the §4.11 fix, a verifier returning malformed JSON
    silently returned set(range(len(claims))) = approve everything.
    After the fix, it must return set() = approve nothing.

    With one parse-broken verifier and two clean rejecters, NO claim
    should pass the 2-of-3 quorum."""

    claims = [_claim("A"), _claim("B")]

    # Mock the three quorum verifiers:
    #   verifier_source        — returns BROKEN JSON (fail-closed → set())
    #   verifier_consistency   — rejects all (returns {"approved": []})
    #   verifier_crossref      — rejects all
    verifier_outputs = {
        "verifier_source": "this is not json at all",
        "verifier_consistency": '{"approved": []}',
        "verifier_crossref": '{"approved": []}',
    }

    def _execute_task(spec):
        return _ok(verifier_outputs[spec.agent_name])

    mock_harness_class = MagicMock()
    mock_harness_class.return_value.execute_task.side_effect = _execute_task

    # Patch the WorkerHarness reference used inside _pipeline
    monkeypatch.setattr("pebble.orchestrator._pipeline.WorkerHarness", mock_harness_class)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    budget = ProspectBudgetTracker(prospect_id="test")
    prospect = {"id": "test-1"}

    async def _go():
        return await quorum_verify_claims(
            claims=claims,
            prospect=prospect,
            client=MagicMock(),
            budget=budget,
            user_email="test@pursuit.org",
        )

    verified = asyncio.run(_go())
    # No claim should survive: source-verifier fail-closed (0 votes), other
    # two reject (0 votes each). Total per claim = 0/3 — quorum requires 2/3.
    assert verified == [], f"expected zero claims, got {len(verified)}: {verified}"


def test_quorum_verifier_parse_fail_does_not_block_clean_approvals(monkeypatch):
    """Defense-in-depth check: a single fail-closed verifier should NOT
    starve the quorum. With one verifier broken but the other two
    approving, the 2-of-3 quorum still admits the claim."""
    claims = [_claim("A")]

    verifier_outputs = {
        "verifier_source": "broken json",                  # 0 approvals
        "verifier_consistency": '{"approved": [0]}',       # approves claim 0
        "verifier_crossref": '{"approved": [0]}',          # approves claim 0
    }

    def _execute_task(spec):
        return _ok(verifier_outputs[spec.agent_name])

    mock_harness_class = MagicMock()
    mock_harness_class.return_value.execute_task.side_effect = _execute_task

    monkeypatch.setattr("pebble.orchestrator._pipeline.WorkerHarness", mock_harness_class)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    budget = ProspectBudgetTracker(prospect_id="test")
    prospect = {"id": "test-2"}

    async def _go():
        return await quorum_verify_claims(
            claims, prospect, MagicMock(), budget, user_email="test@pursuit.org",
        )

    verified = asyncio.run(_go())
    assert len(verified) == 1
    assert verified[0]["text"] == "A"


def test_quorum_verifier_unavailable_drops_to_zero(monkeypatch):
    """If a verifier itself errors (timeout, retries exhausted),
    contributes zero approvals — does NOT crash, does NOT approve all."""
    claims = [_claim("A")]

    def _execute_task(spec):
        if spec.agent_name == "verifier_source":
            return HarnessResult(outcome=AgentOutcome.KILLED_RETRIES, error="x", attempts=3)
        return _ok('{"approved": [0]}')

    mock_harness_class = MagicMock()
    mock_harness_class.return_value.execute_task.side_effect = _execute_task

    monkeypatch.setattr("pebble.orchestrator._pipeline.WorkerHarness", mock_harness_class)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    budget = ProspectBudgetTracker(prospect_id="test")
    prospect = {"id": "test-3"}

    async def _go():
        return await quorum_verify_claims(claims, prospect, MagicMock(), budget)

    verified = asyncio.run(_go())
    # 0 from source + 1 each from consistency+crossref = 2/3 → kept
    assert len(verified) == 1


def test_quorum_verifier_all_three_fail_closed_drops_all(monkeypatch):
    """When ALL three verifiers fail (parse / outage / timeout), no
    claim passes — this is the correct behavior. The old fail-open
    bug would have admitted every claim under exactly this scenario."""
    claims = [_claim("A"), _claim("B")]

    def _execute_task(spec):
        # All three verifiers return malformed output
        return _ok("not json")

    mock_harness_class = MagicMock()
    mock_harness_class.return_value.execute_task.side_effect = _execute_task

    monkeypatch.setattr("pebble.orchestrator._pipeline.WorkerHarness", mock_harness_class)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    budget = ProspectBudgetTracker(prospect_id="test")
    prospect = {"id": "test-4"}

    async def _go():
        return await quorum_verify_claims(claims, prospect, MagicMock(), budget)

    verified = asyncio.run(_go())
    assert verified == []


# ---------------------------------------------------------------------------
# D. Per-claim prefilter — drops rejects, keeps admits, logs each
# ---------------------------------------------------------------------------

def test_prefilter_drops_rejected_keeps_approved(monkeypatch):
    """The per-claim prefilter routes rejects → drop, approves → keep,
    admit_low_confidence → keep with confidence=low."""
    claims = [
        _claim("good claim"),
        _claim("bad claim", url="https://random-content-farm.example/x"),
        _claim("weak claim"),
    ]

    # Map claim text → verifier outcome
    outcomes = {
        "good claim": "approve",
        "bad claim": "reject",
        "weak claim": "redo",  # admit_low_confidence in one-shot path
    }

    def _execute_task(spec):
        text = spec.data["claim_text"]
        outcome = outcomes[text]
        return _ok(f'{{"outcome": "{outcome}", "reason": "test", "confidence_hint": null}}')

    mock_harness_class = MagicMock()
    mock_harness_class.return_value.execute_task.side_effect = _execute_task

    monkeypatch.setattr("pebble.orchestrator.verifier.WorkerHarness", mock_harness_class)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    budget = ProspectBudgetTracker(prospect_id="test")
    prospect = {"id": "test-prefilter-1"}

    async def _go():
        return await _prefilter_claims_per_claim(
            claims, prospect, MagicMock(), budget,
        )

    kept = asyncio.run(_go())
    assert len(kept) == 2  # good + weak (admit_low)
    texts = {c["text"] for c in kept}
    assert texts == {"good claim", "weak claim"}
    # The weak claim should be marked low confidence
    weak = next(c for c in kept if c["text"] == "weak claim")
    assert weak["confidence"] == "low"
    # The good claim should be marked pre_verified
    good = next(c for c in kept if c["text"] == "good claim")
    assert good["pre_verified"] is True


def test_prefilter_parse_fail_admits_low_does_not_drop(monkeypatch):
    """Parse failure on the per-claim verifier → admit_low_confidence,
    NOT drop. An adversary who can break the verifier's JSON output
    must not be able to drop legitimate claims."""
    claims = [_claim("evidence supports X")]

    def _execute_task(spec):
        return _ok("broken json that doesn't parse")

    mock_harness_class = MagicMock()
    mock_harness_class.return_value.execute_task.side_effect = _execute_task

    monkeypatch.setattr("pebble.orchestrator.verifier.WorkerHarness", mock_harness_class)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    budget = ProspectBudgetTracker(prospect_id="test")
    prospect = {"id": "test-prefilter-parse"}

    async def _go():
        return await _prefilter_claims_per_claim(claims, prospect, MagicMock(), budget)

    kept = asyncio.run(_go())
    assert len(kept) == 1
    assert kept[0]["confidence"] == "low"
    assert kept[0]["verifier_note"] == "verifier_parse_failed"


def test_prefilter_budget_exhausted_passes_through(monkeypatch):
    """If the budget exhausts mid-pass, remaining claims pass through
    UNVERIFIED — they will face the run-level quorum. No claim is
    silently dropped just because the prefilter ran out of money."""
    claims = [_claim(f"claim {i}") for i in range(5)]

    # Pre-spent budget so any add() pushes it over
    budget = ProspectBudgetTracker(prospect_id="test")
    budget.add(0.495)  # only $0.005 headroom under the $0.50 cap

    call_count = {"n": 0}

    def _execute_task(spec):
        call_count["n"] += 1
        # First call charges $0.01 — pushes over the cap
        return _ok('{"outcome": "approve", "reason": "ok"}', cost=0.01)

    mock_harness_class = MagicMock()
    mock_harness_class.return_value.execute_task.side_effect = _execute_task

    monkeypatch.setattr("pebble.orchestrator.verifier.WorkerHarness", mock_harness_class)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    prospect = {"id": "test-prefilter-budget"}

    async def _go():
        return await _prefilter_claims_per_claim(
            claims, prospect, MagicMock(), budget, concurrency=1,
        )

    kept = asyncio.run(_go())
    # All 5 claims kept (no drops, some via budget-skip pass-through)
    assert len(kept) == 5
    # Strictly less than 5 verifier calls were made (some skipped on budget)
    assert call_count["n"] < 5


# ---------------------------------------------------------------------------
# E. Kill switch
# ---------------------------------------------------------------------------

def test_per_claim_verifier_enabled_default():
    """Default behavior: prefilter ON."""
    if "PEBBLE_PER_CLAIM_VERIFIER_DISABLED" in os.environ:
        # Don't trample a user-set env var; just verify the default.
        old = os.environ.pop("PEBBLE_PER_CLAIM_VERIFIER_DISABLED")
        try:
            assert _per_claim_verifier_enabled() is True
        finally:
            os.environ["PEBBLE_PER_CLAIM_VERIFIER_DISABLED"] = old
    else:
        assert _per_claim_verifier_enabled() is True


def test_per_claim_verifier_disabled_via_env(monkeypatch):
    """Setting the kill-switch env to a truthy value disables the prefilter."""
    monkeypatch.setenv("PEBBLE_PER_CLAIM_VERIFIER_DISABLED", "true")
    assert _per_claim_verifier_enabled() is False

    monkeypatch.setenv("PEBBLE_PER_CLAIM_VERIFIER_DISABLED", "1")
    assert _per_claim_verifier_enabled() is False

    monkeypatch.setenv("PEBBLE_PER_CLAIM_VERIFIER_DISABLED", "yes")
    assert _per_claim_verifier_enabled() is False

    # Falsy values stay enabled
    monkeypatch.setenv("PEBBLE_PER_CLAIM_VERIFIER_DISABLED", "false")
    assert _per_claim_verifier_enabled() is True

    monkeypatch.setenv("PEBBLE_PER_CLAIM_VERIFIER_DISABLED", "")
    assert _per_claim_verifier_enabled() is True
