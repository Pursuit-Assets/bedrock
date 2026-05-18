"""Tests for ``pebble.orchestrator.verifier`` — per-claim Doer/Verifier
loop (§4.3) + fail-CLOSED parse handling (§4.11).

Mocks the WorkerHarness so we control exactly what the verifier "saw"
without making real LLM calls. Each verdict path documented in the
plan §4.3 has a test.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from pebble.harness import AgentOutcome, HarnessResult
from pebble.orchestrator.verifier import (
    ClaimVerdict,
    _parse_verifier_output,
    _coerce_outcome,
    verify_claim_loop,
    verify_claim_once,
)


# ---------------------------------------------------------------------------
# Helpers — fake harness responses
# ---------------------------------------------------------------------------

def _ok(content: str, cost_usd: float = 0.0025) -> HarnessResult:
    """Fake successful HarnessResult with the given JSON content."""
    return HarnessResult(
        outcome=AgentOutcome.SUCCESS,
        data={"content": content},
        cost_usd=cost_usd,
        attempts=1,
    )


def _fail(outcome: AgentOutcome = AgentOutcome.KILLED_RETRIES) -> HarnessResult:
    return HarnessResult(outcome=outcome, error="forced", attempts=1)


def _claim(text: str = "John Doe is a director of XYZ Foundation", url: str = "https://propublica.org/x") -> dict:
    return {"text": text, "source_url": url, "confidence": "medium", "origin": "template"}


# ---------------------------------------------------------------------------
# Parse helpers
# ---------------------------------------------------------------------------

def test_parse_verifier_output_strips_fences():
    raw = "```json\n{\"outcome\": \"approve\"}\n```"
    out = _parse_verifier_output(raw)
    assert out == {"outcome": "approve"}


def test_parse_verifier_output_returns_none_on_garbage():
    assert _parse_verifier_output("not json at all") is None
    assert _parse_verifier_output("") is None
    assert _parse_verifier_output(None) is None


def test_parse_verifier_output_returns_none_on_non_dict():
    assert _parse_verifier_output("[1, 2, 3]") is None
    assert _parse_verifier_output("\"approve\"") is None


def test_coerce_outcome_accepts_variants():
    assert _coerce_outcome({"outcome": "approve"}) == "approve"
    assert _coerce_outcome({"outcome": "APPROVED"}) == "approve"
    assert _coerce_outcome({"outcome": "Reject"}) == "reject"
    assert _coerce_outcome({"outcome": "redo"}) == "redo"
    assert _coerce_outcome({"outcome": "maybe"}) is None
    assert _coerce_outcome({}) is None


# ---------------------------------------------------------------------------
# verify_claim_once — approve / reject / redo / parse-fail
# ---------------------------------------------------------------------------

def _mock_harness(monkeypatch, harness_result: HarnessResult):
    """Patch WorkerHarness.execute_task to return the given result."""
    mock_instance = MagicMock()
    mock_instance.execute_task.return_value = harness_result
    monkeypatch.setattr(
        "pebble.orchestrator.verifier.WorkerHarness",
        MagicMock(return_value=mock_instance),
    )
    return mock_instance


def test_verify_claim_once_approve(monkeypatch):
    _mock_harness(monkeypatch, _ok('{"outcome": "approve", "reason": "ok", "confidence_hint": "high"}'))
    verdict = verify_claim_once(_claim(), client=MagicMock())
    assert verdict.outcome == "approve"
    assert verdict.claim["pre_verified"] is True
    assert verdict.attempts == 1
    assert verdict.cost_usd == 0.0025


def test_verify_claim_once_reject(monkeypatch):
    _mock_harness(monkeypatch, _ok('{"outcome": "reject", "reason": "unrecognizable source"}'))
    verdict = verify_claim_once(_claim(), client=MagicMock())
    assert verdict.outcome == "reject"
    assert "unrecognizable" in verdict.reason
    # Rejected claim is returned unchanged — caller drops it.
    assert verdict.claim.get("pre_verified") is None


def test_verify_claim_once_redo_no_doer_admits_low(monkeypatch):
    """One-shot has no Doer; redo collapses to admit_low_confidence."""
    _mock_harness(monkeypatch, _ok('{"outcome": "redo", "reason": "source weak"}'))
    verdict = verify_claim_once(_claim(), client=MagicMock())
    assert verdict.outcome == "admit_low_confidence"
    assert verdict.claim["confidence"] == "low"
    assert "verifier_redo_no_doer" in verdict.claim["verifier_note"]


def test_verify_claim_once_parse_fail_admits_low_FAIL_CLOSED(monkeypatch):
    """The §4.11 fix: a verifier whose JSON output can be broken (by
    poisoned 990 free-text bleeding into the prompt, say) MUST NOT
    auto-approve. Old behavior was approve-everything; new behavior is
    admit-at-low-confidence with a verifier_note, so synthesis treats
    it cautiously and the adversary cannot force a drop either."""
    _mock_harness(monkeypatch, _ok("not json at all"))
    verdict = verify_claim_once(_claim(), client=MagicMock())
    assert verdict.outcome == "admit_low_confidence"
    assert verdict.claim["confidence"] == "low"
    assert verdict.claim["verifier_note"] == "verifier_parse_failed"


def test_verify_claim_once_verifier_unavailable_admits_low(monkeypatch):
    """Verifier itself failed (timeout / retries exhausted). Don't auto-
    drop — the run-level quorum is the second chance."""
    _mock_harness(monkeypatch, _fail(AgentOutcome.KILLED_RETRIES))
    verdict = verify_claim_once(_claim(), client=MagicMock())
    assert verdict.outcome == "admit_low_confidence"
    assert verdict.claim["confidence"] == "low"
    assert "verifier_unavailable" in verdict.claim["verifier_note"]


def test_verify_claim_once_unknown_outcome_admits_low(monkeypatch):
    """Model returned valid JSON but used a word we don't recognize.
    Fail-closed to admit_low_confidence rather than guessing."""
    _mock_harness(monkeypatch, _ok('{"outcome": "maybe", "reason": "uncertain"}'))
    verdict = verify_claim_once(_claim(), client=MagicMock())
    assert verdict.outcome == "admit_low_confidence"
    assert verdict.claim["verifier_note"] == "verifier_unknown_outcome"


def test_verify_claim_once_approve_does_not_downgrade_existing_confidence(monkeypatch):
    """If the claim already has confidence="high", verifier approve should
    not downgrade it to whatever confidence_hint says."""
    _mock_harness(monkeypatch, _ok('{"outcome": "approve", "reason": "ok", "confidence_hint": "low"}'))
    claim = _claim()
    claim["confidence"] = "high"
    verdict = verify_claim_once(claim, client=MagicMock())
    assert verdict.claim["confidence"] == "high"


# ---------------------------------------------------------------------------
# verify_claim_loop — Doer redo path
# ---------------------------------------------------------------------------

def test_verify_claim_loop_approves_first_try(monkeypatch):
    _mock_harness(monkeypatch, _ok('{"outcome": "approve", "reason": "ok"}'))

    async def _go():
        verdict = await verify_claim_loop(
            _claim(),
            doer_redo=None,
            client=MagicMock(),
            max_loops=2,
        )
        return verdict

    verdict = asyncio.run(_go())
    assert verdict.outcome == "approve"
    assert verdict.attempts == 1


def test_verify_claim_loop_redo_then_approve(monkeypatch):
    """First call returns redo; Doer re-emits; second call approves."""
    call_count = {"n": 0}

    def _execute_task(spec):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _ok('{"outcome": "redo", "reason": "tighten source"}')
        return _ok('{"outcome": "approve", "reason": "ok"}')

    mock_instance = MagicMock()
    mock_instance.execute_task.side_effect = _execute_task
    monkeypatch.setattr(
        "pebble.orchestrator.verifier.WorkerHarness",
        MagicMock(return_value=mock_instance),
    )

    async def _doer_redo(hint):
        assert hint == "tighten source"
        return _claim(text="John Doe is a director (tighter)", url="https://propublica.org/x/v2")

    async def _go():
        return await verify_claim_loop(
            _claim(),
            doer_redo=_doer_redo,
            client=MagicMock(),
            max_loops=2,
        )

    verdict = asyncio.run(_go())
    assert verdict.outcome == "approve"
    assert verdict.attempts == 2
    assert verdict.cost_usd == 0.005  # 2x the per-call cost
    assert len(verdict.loop_costs_usd) == 2


def test_verify_claim_loop_redo_exhausts_admits_low(monkeypatch):
    """Verifier keeps asking for redo; loop hits max_loops and admits low."""
    mock_instance = MagicMock()
    mock_instance.execute_task.return_value = _ok('{"outcome": "redo", "reason": "still weak"}')
    monkeypatch.setattr(
        "pebble.orchestrator.verifier.WorkerHarness",
        MagicMock(return_value=mock_instance),
    )

    redo_calls = {"n": 0}

    async def _doer_redo(hint):
        redo_calls["n"] += 1
        return _claim(text=f"attempt {redo_calls['n']}")

    async def _go():
        return await verify_claim_loop(
            _claim(),
            doer_redo=_doer_redo,
            client=MagicMock(),
            max_loops=2,
        )

    verdict = asyncio.run(_go())
    assert verdict.outcome == "admit_low_confidence"
    assert verdict.attempts == 3  # initial + 2 redos
    assert verdict.claim["confidence"] == "low"
    assert "redo_exhausted" in verdict.claim["verifier_note"]


def test_verify_claim_loop_doer_gives_up(monkeypatch):
    """Doer returns None on redo → admit current claim at low confidence."""
    mock_instance = MagicMock()
    mock_instance.execute_task.return_value = _ok('{"outcome": "redo", "reason": "weak"}')
    monkeypatch.setattr(
        "pebble.orchestrator.verifier.WorkerHarness",
        MagicMock(return_value=mock_instance),
    )

    async def _doer_redo(hint):
        return None

    async def _go():
        return await verify_claim_loop(
            _claim(),
            doer_redo=_doer_redo,
            client=MagicMock(),
            max_loops=2,
        )

    verdict = asyncio.run(_go())
    assert verdict.outcome == "admit_low_confidence"
    assert "doer_gave_up" in verdict.claim["verifier_note"]


def test_verify_claim_loop_rejects_early(monkeypatch):
    """Reject is terminal — don't keep redoing."""
    mock_instance = MagicMock()
    mock_instance.execute_task.return_value = _ok('{"outcome": "reject", "reason": "fake source"}')
    monkeypatch.setattr(
        "pebble.orchestrator.verifier.WorkerHarness",
        MagicMock(return_value=mock_instance),
    )

    redo_calls = {"n": 0}

    async def _doer_redo(hint):
        redo_calls["n"] += 1
        return _claim()

    async def _go():
        return await verify_claim_loop(
            _claim(),
            doer_redo=_doer_redo,
            client=MagicMock(),
            max_loops=5,
        )

    verdict = asyncio.run(_go())
    assert verdict.outcome == "reject"
    assert verdict.attempts == 1
    assert redo_calls["n"] == 0  # Doer never re-prompted


def test_verify_claim_loop_parse_fail_stops_immediately(monkeypatch):
    """Parse failure does NOT trigger a redo — that would let an adversary
    drag us through expensive retries by breaking JSON. Stop and admit at
    low confidence (admit_low_confidence is the terminal state)."""
    mock_instance = MagicMock()
    mock_instance.execute_task.return_value = _ok("broken json")
    monkeypatch.setattr(
        "pebble.orchestrator.verifier.WorkerHarness",
        MagicMock(return_value=mock_instance),
    )

    redo_calls = {"n": 0}

    async def _doer_redo(hint):
        redo_calls["n"] += 1
        return _claim()

    async def _go():
        return await verify_claim_loop(
            _claim(),
            doer_redo=_doer_redo,
            client=MagicMock(),
            max_loops=3,
        )

    verdict = asyncio.run(_go())
    assert verdict.outcome == "admit_low_confidence"
    assert verdict.claim["verifier_note"] == "verifier_parse_failed"
    assert redo_calls["n"] == 0  # NO redo on parse failure


def test_verify_claim_loop_zero_max_loops_means_single_pass(monkeypatch):
    """T1 tier (max_loops=0) gets one call, no redo capability."""
    mock_instance = MagicMock()
    mock_instance.execute_task.return_value = _ok('{"outcome": "redo", "reason": "x"}')
    monkeypatch.setattr(
        "pebble.orchestrator.verifier.WorkerHarness",
        MagicMock(return_value=mock_instance),
    )

    async def _doer_redo(hint):
        return _claim()

    async def _go():
        return await verify_claim_loop(
            _claim(),
            doer_redo=_doer_redo,
            client=MagicMock(),
            max_loops=0,
        )

    verdict = asyncio.run(_go())
    assert verdict.attempts == 1
    assert verdict.outcome == "admit_low_confidence"


def test_verify_claim_loop_negative_max_loops_normalized(monkeypatch):
    """max_loops=-1 should normalize to 0 (single call, no redo)."""
    mock_instance = MagicMock()
    mock_instance.execute_task.return_value = _ok('{"outcome": "approve", "reason": "ok"}')
    monkeypatch.setattr(
        "pebble.orchestrator.verifier.WorkerHarness",
        MagicMock(return_value=mock_instance),
    )

    async def _go():
        return await verify_claim_loop(
            _claim(),
            doer_redo=None,
            client=MagicMock(),
            max_loops=-5,
        )

    verdict = asyncio.run(_go())
    assert verdict.outcome == "approve"
    assert verdict.attempts == 1


# ---------------------------------------------------------------------------
# ClaimVerdict shape
# ---------------------------------------------------------------------------

def test_claim_verdict_default_loop_costs_is_list():
    """A fresh ClaimVerdict must have loop_costs_usd = [] (not None)
    so the ledger can extend it without type errors."""
    v = ClaimVerdict(outcome="approve", claim={})
    assert v.loop_costs_usd == []
