"""Fidelity invariants for the donor-prospect research pipeline.

Locks down the contracts that make ``research_single_prospect`` safe
to ship to development officers:

  * Quorum verification is fail-CLOSED — a verifier that crashes or
    returns nonsense never silently approves every claim.
  * Claims are deduplicated before quorum so the verifier doesn't see
    the same claim from two origins.
  * URL verification distinguishes 404 (drop) from transient network
    error (keep but mark for review).
  * Search results are name-match validated before they enter the
    claim pool — a "Jane Smith" prospect doesn't inherit a different
    Jane Smith's FEC donations.

These tests fail by design on the *current* implementation in places —
the failures are the to-do list. As each fix lands, the matching test
flips from xfail to pass.
"""

from __future__ import annotations

import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from pebble.harness import AgentOutcome, HarnessResult
from pebble.orchestrator._pipeline import (
    ProspectBudgetTracker,
    _rank_claims,
    quorum_verify_claims,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _claim(text: str, source_url: str, *, origin: str = "template",
           confidence: str = "medium") -> dict:
    return {
        "text": text,
        "source_url": source_url,
        "origin": origin,
        "confidence": confidence,
    }


def _verifier_success(approved_indices: list[int]) -> HarnessResult:
    import json
    return HarnessResult(
        outcome=AgentOutcome.SUCCESS,
        data={"content": json.dumps({"approved": approved_indices})},
        cost_usd=0.001,
    )


def _verifier_killed() -> HarnessResult:
    return HarnessResult(
        outcome=AgentOutcome.KILLED_TIMEOUT,
        data=None,
        error="timeout",
    )


def _verifier_malformed() -> HarnessResult:
    return HarnessResult(
        outcome=AgentOutcome.SUCCESS,
        data={"content": "not json at all"},
        cost_usd=0.001,
    )


def _verifier_crash() -> HarnessResult:
    """Simulate the harness itself raising — never happens via the
    normal sync path but defends against future async-native swaps."""
    raise RuntimeError("verifier worker exploded")


def _make_quorum_runner(verifier_results: dict[str, object]):
    """Build an async patch for ``asyncio.to_thread`` that returns the
    canned HarnessResult per agent_name. ``verifier_results`` maps
    agent_name → HarnessResult OR a callable that returns/raises."""

    async def fake_to_thread(fn, spec):
        result = verifier_results.get(spec.agent_name)
        if callable(result):
            return result()
        return result

    return fake_to_thread


def _budget() -> ProspectBudgetTracker:
    return ProspectBudgetTracker(prospect_id="test-1")


# ---------------------------------------------------------------------------
# Quorum — fail-closed invariants (F1)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_quorum_all_three_verifiers_agree_passes_claim(monkeypatch):
    claims = [_claim("Donated $1000 to ActBlue", "https://fec.gov/x")]
    runner = _make_quorum_runner({
        "verifier_source": _verifier_success([0]),
        "verifier_consistency": _verifier_success([0]),
        "verifier_crossref": _verifier_success([0]),
    })
    monkeypatch.setattr("pebble.orchestrator._pipeline.asyncio.to_thread", runner)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    verified = await quorum_verify_claims(
        claims, {"id": "p1"}, MagicMock(), _budget(),
    )
    assert len(verified) == 1
    assert verified[0]["verification_votes"] == 3


@pytest.mark.asyncio
async def test_quorum_two_of_three_passes_claim(monkeypatch):
    claims = [_claim("Board member at Acme", "https://wiki.org/x")]
    runner = _make_quorum_runner({
        "verifier_source": _verifier_success([0]),
        "verifier_consistency": _verifier_success([0]),
        "verifier_crossref": _verifier_success([]),  # disagrees
    })
    monkeypatch.setattr("pebble.orchestrator._pipeline.asyncio.to_thread", runner)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    verified = await quorum_verify_claims(
        claims, {"id": "p1"}, MagicMock(), _budget(),
    )
    assert len(verified) == 1
    assert verified[0]["verification_votes"] == 2


@pytest.mark.asyncio
async def test_quorum_one_of_three_rejects_claim(monkeypatch):
    claims = [_claim("CEO of Acme", "https://example.org/x")]
    runner = _make_quorum_runner({
        "verifier_source": _verifier_success([0]),
        "verifier_consistency": _verifier_success([]),
        "verifier_crossref": _verifier_success([]),
    })
    monkeypatch.setattr("pebble.orchestrator._pipeline.asyncio.to_thread", runner)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    verified = await quorum_verify_claims(
        claims, {"id": "p1"}, MagicMock(), _budget(),
    )
    assert verified == []


@pytest.mark.asyncio
async def test_quorum_rejects_when_two_verifiers_fail(monkeypatch):
    """Fidelity invariant: if only one verifier produces a verdict,
    no claim can reach a 2-vote majority. ALL claims must be rejected
    (fail-closed) — current implementation fail-OPENS and approves
    everything from the failed verifiers, which is the bug we're locking
    against."""
    claims = [_claim("Donated $1000 to ActBlue", "https://fec.gov/x")]
    runner = _make_quorum_runner({
        "verifier_source": _verifier_success([0]),
        "verifier_consistency": _verifier_killed(),
        "verifier_crossref": _verifier_killed(),
    })
    monkeypatch.setattr("pebble.orchestrator._pipeline.asyncio.to_thread", runner)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    verified = await quorum_verify_claims(
        claims, {"id": "p1"}, MagicMock(), _budget(),
    )
    assert verified == [], (
        "fail-closed: with only one successful verifier no quorum is reachable"
    )


@pytest.mark.asyncio
async def test_quorum_all_verifiers_fail_rejects_all_claims(monkeypatch):
    claims = [
        _claim("Donated $1000 to ActBlue", "https://fec.gov/x"),
        _claim("Board member at Acme", "https://wiki.org/x"),
    ]
    runner = _make_quorum_runner({
        "verifier_source": _verifier_killed(),
        "verifier_consistency": _verifier_killed(),
        "verifier_crossref": _verifier_killed(),
    })
    monkeypatch.setattr("pebble.orchestrator._pipeline.asyncio.to_thread", runner)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    verified = await quorum_verify_claims(
        claims, {"id": "p1"}, MagicMock(), _budget(),
    )
    assert verified == []


@pytest.mark.asyncio
async def test_quorum_malformed_json_treated_as_no_vote(monkeypatch):
    """A verifier that returns garbage doesn't get to approve everything."""
    claims = [_claim("CEO of Acme", "https://example.org/x")]
    runner = _make_quorum_runner({
        "verifier_source": _verifier_success([0]),
        "verifier_consistency": _verifier_malformed(),
        "verifier_crossref": _verifier_malformed(),
    })
    monkeypatch.setattr("pebble.orchestrator._pipeline.asyncio.to_thread", runner)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    verified = await quorum_verify_claims(
        claims, {"id": "p1"}, MagicMock(), _budget(),
    )
    assert verified == [], (
        "malformed verifier output must not count as approval"
    )


@pytest.mark.asyncio
async def test_quorum_two_succeed_one_fails_requires_full_consensus(monkeypatch):
    """With only 2 successful verifiers, majority = 2 (full consensus).
    A claim approved by 1 of 2 must be rejected."""
    claims = [
        _claim("CEO of Acme", "https://a.org/1"),       # both approve
        _claim("Board chair at Beta", "https://b.org/2"),  # only source approves
    ]
    runner = _make_quorum_runner({
        "verifier_source": _verifier_success([0, 1]),
        "verifier_consistency": _verifier_success([0]),  # rejects index 1
        "verifier_crossref": _verifier_killed(),
    })
    monkeypatch.setattr("pebble.orchestrator._pipeline.asyncio.to_thread", runner)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    verified = await quorum_verify_claims(
        claims, {"id": "p1"}, MagicMock(), _budget(),
    )
    assert len(verified) == 1
    assert verified[0]["text"] == "CEO of Acme"


@pytest.mark.asyncio
async def test_quorum_records_successful_verifier_count(monkeypatch):
    """A passing claim's record should reflect how many verifiers
    successfully voted — downstream consumers (synthesis prompt,
    confidence score) lean on this."""
    claims = [_claim("X", "https://x.org/")]
    runner = _make_quorum_runner({
        "verifier_source": _verifier_success([0]),
        "verifier_consistency": _verifier_success([0]),
        "verifier_crossref": _verifier_killed(),
    })
    monkeypatch.setattr("pebble.orchestrator._pipeline.asyncio.to_thread", runner)
    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    verified = await quorum_verify_claims(
        claims, {"id": "p1"}, MagicMock(), _budget(),
    )
    assert len(verified) == 1
    # Verifiers_successful is the F1 addition — pinned here so it stays.
    assert verified[0].get("verifiers_successful") == 2
    assert verified[0]["verification_votes"] == 2


# ---------------------------------------------------------------------------
# Claim dedup (F2)
# ---------------------------------------------------------------------------

def test_dedupe_identical_claims():
    from pebble.orchestrator._pipeline import dedupe_claims
    claims = [
        _claim("CEO of Acme", "https://acme.org/exec", origin="template"),
        _claim("CEO of Acme", "https://acme.org/exec", origin="template"),
    ]
    out = dedupe_claims(claims)
    assert len(out) == 1


def test_dedupe_normalizes_whitespace_and_case():
    from pebble.orchestrator._pipeline import dedupe_claims
    claims = [
        _claim("CEO of Acme.", "https://acme.org/exec", origin="template"),
        _claim("ceo of acme", "https://acme.org/exec", origin="template"),
        _claim("CEO  of  Acme", "https://acme.org/exec", origin="template"),
    ]
    out = dedupe_claims(claims)
    assert len(out) == 1


def test_dedupe_keeps_best_origin():
    """Same canonical claim from multiple origins → keep the
    forager-tagged version (carries the highest analytical weight)."""
    from pebble.orchestrator._pipeline import dedupe_claims
    claims = [
        _claim("CEO of Acme", "https://acme.org/exec", origin="template"),
        _claim("CEO of Acme", "https://acme.org/exec", origin="forager"),
        _claim("CEO of Acme", "https://acme.org/exec", origin="llm_extracted"),
    ]
    out = dedupe_claims(claims)
    assert len(out) == 1
    assert out[0]["origin"] == "forager"


def test_dedupe_keeps_best_confidence_within_origin():
    from pebble.orchestrator._pipeline import dedupe_claims
    claims = [
        _claim("Donated $5000 to ActBlue", "https://fec.gov/x",
               origin="template", confidence="low"),
        _claim("Donated $5000 to ActBlue", "https://fec.gov/x",
               origin="template", confidence="high"),
    ]
    out = dedupe_claims(claims)
    assert len(out) == 1
    assert out[0]["confidence"] == "high"


def test_dedupe_different_urls_kept_separate():
    """Same text, different sources — both kept (independent
    corroboration is valuable signal)."""
    from pebble.orchestrator._pipeline import dedupe_claims
    claims = [
        _claim("CEO of Acme", "https://acme.org/exec"),
        _claim("CEO of Acme", "https://wikipedia.org/Acme"),
    ]
    out = dedupe_claims(claims)
    assert len(out) == 2


def test_dedupe_preserves_order_for_first_seen():
    from pebble.orchestrator._pipeline import dedupe_claims
    claims = [
        _claim("A", "https://x.org/a"),
        _claim("B", "https://x.org/b"),
        _claim("A", "https://x.org/a"),
    ]
    out = dedupe_claims(claims)
    assert [c["text"] for c in out] == ["A", "B"]


def test_dedupe_skips_claims_without_source_url():
    """Claims without source_url shouldn't survive anyway — but
    dedupe must not crash on them."""
    from pebble.orchestrator._pipeline import dedupe_claims
    claims = [
        _claim("X", ""),
        _claim("X", ""),  # both lack URLs
        _claim("X", "https://x.org/x"),
    ]
    out = dedupe_claims(claims)
    # The URL-less duplicates collapse together; the URL'd one is separate.
    assert len(out) == 2


# ---------------------------------------------------------------------------
# Claim ranking (existing behavior — sanity)
# ---------------------------------------------------------------------------

def test_rank_claims_forager_over_template():
    claims = [
        _claim("FEC: $500", "https://fec.gov/a", origin="template"),
        _claim("Board chair at Acme", "https://acme.org", origin="forager"),
        _claim("CEO of Beta", "https://beta.com", origin="llm_extracted"),
    ]
    ranked = _rank_claims(claims)
    origins = [c["origin"] for c in ranked]
    assert origins[0] == "forager"
    assert origins[-1] == "template"
