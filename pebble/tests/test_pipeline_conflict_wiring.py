"""Tests for the conflict-detector wiring in research_single_prospect.

detect_conflicts() and save_conflicts() existed pre-Wave-1 but were
only used from the tier3 handler. The main research pipeline now
invokes them after quorum verification, persists results to
bedrock.pebble_conflict_log, emits a divergence / conflict_spike
meta-alert, and exposes conflicts on the returned profile.

The unit tests below stub the data layer so we can run them without a
real Postgres connection — they assert the WIRING (right function
called with right args at right stage), not what conflict_detector
itself does (that's covered by test_conflict_detector.py).
"""

from __future__ import annotations

import asyncio
import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from pebble.orchestrator._pipeline import ProspectBudgetTracker


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_claim(text: str, source_url: str = "https://propublica.org/x") -> dict:
    return {"text": text, "source_url": source_url, "confidence": "medium", "origin": "template"}


def _run_with_stubs(
    verified_claims: list[dict],
    fake_conflicts: list[dict],
    monkeypatch,
    user_email: str = "jp@pursuit.org",
):
    """Drive research_single_prospect end-to-end with the data-source +
    LLM layer fully mocked. Returns (result, save_conflicts_mock,
    save_meta_alert_mock, save_profile_mock)."""
    from pebble.orchestrator import _pipeline as pipe

    # Mock all the data fetch/save layer
    monkeypatch.setattr(pipe, "fetch_research_data", AsyncMock(return_value={
        "fec_data": None,
        "edgar_data": None,
        "usa_data": None,
        "wiki_data": None,
        "oc_data": None,
        "propublica_data": None,
        "sec_data": None,
    }))
    monkeypatch.setattr(pipe, "score_source_richness", AsyncMock(return_value={}))
    monkeypatch.setattr(pipe, "save_source_scores", AsyncMock())
    monkeypatch.setattr(pipe, "save_profile", AsyncMock())

    # Skip the LLM-driven stages — return our seeded claim pool directly.
    monkeypatch.setattr(pipe, "stage1_enrich_prospect", AsyncMock(return_value={
        "claims": verified_claims,
        "partial": False,
        "failed_agents": [],
    }))
    monkeypatch.setattr(pipe, "activate_foragers", AsyncMock(return_value=[]))
    monkeypatch.setattr(pipe, "verify_urls", AsyncMock(return_value=(verified_claims, [])))
    monkeypatch.setattr(pipe, "quorum_verify_claims", AsyncMock(return_value=verified_claims))
    monkeypatch.setattr(pipe, "synthesize_profile", AsyncMock(return_value={
        "claims": verified_claims,
        "summary": "test",
        "confidence_score": "medium",
        "partial": False,
        "failed_agents": [],
    }))
    monkeypatch.setattr(pipe, "_save_session_for_prospect", AsyncMock())
    monkeypatch.setattr(pipe, "log_harness_outcome", AsyncMock())

    # Disable the per-claim prefilter for these tests — we want to
    # isolate the conflict-detection wiring.
    monkeypatch.setenv("PEBBLE_PER_CLAIM_VERIFIER_DISABLED", "true")

    # Stub detect_conflicts to return the test-controlled conflict list
    detect_mock = MagicMock(return_value=fake_conflicts)
    monkeypatch.setattr(pipe, "detect_conflicts", detect_mock)

    # Capture save_conflicts + save_meta_alert + save_profile
    save_conflicts_mock = AsyncMock()
    save_meta_alert_mock = AsyncMock()
    monkeypatch.setattr(pipe, "save_conflicts", save_conflicts_mock)
    monkeypatch.setattr(pipe, "save_meta_alert", save_meta_alert_mock)
    save_profile_mock = AsyncMock()
    monkeypatch.setattr(pipe, "save_profile", save_profile_mock)

    async def _go():
        return await pipe.research_single_prospect(
            prospect={"id": "p1", "first_name": "Jane", "last_name": "Doe", "organization": "ACME"},
            contact_id="p1",
            client=MagicMock(),
            cancel_check=lambda: False,
            user_email=user_email,
        )

    result = asyncio.run(_go())
    return result, save_conflicts_mock, save_meta_alert_mock, save_profile_mock, detect_mock


# ---------------------------------------------------------------------------
# Wiring tests
# ---------------------------------------------------------------------------

def test_detect_conflicts_invoked_after_quorum(monkeypatch):
    """The pipeline calls detect_conflicts(verified_claims, person_name)."""
    claims = [_make_claim("Jane Doe is Director at ACME")]
    _, _, _, _, detect_mock = _run_with_stubs(claims, [], monkeypatch)
    detect_mock.assert_called_once()
    args = detect_mock.call_args.args
    assert args[0] == claims
    # person_name derived from prospect.first_name + last_name
    assert args[1] == "Jane Doe"


def test_conflicts_persisted_to_conflict_log(monkeypatch):
    """When conflicts are found, save_conflicts is called with the run's
    session_id, contact_id, and conflict list."""
    claims = [_make_claim("Jane is Director"), _make_claim("Jane is CEO")]
    fake_conflicts = [{"type": "role", "claim_a": "x", "claim_b": "y", "description": "conflict at ACME"}]
    _, save_conflicts_mock, _, _, _ = _run_with_stubs(claims, fake_conflicts, monkeypatch)

    save_conflicts_mock.assert_awaited_once()
    args = save_conflicts_mock.await_args.args
    session_id, contact_id, persisted_conflicts = args
    assert isinstance(session_id, str) and len(session_id) > 0
    assert contact_id == "p1"
    assert persisted_conflicts == fake_conflicts


def test_no_conflicts_skips_save_and_alert(monkeypatch):
    """Empty conflict list = no DB writes, no meta-alert."""
    claims = [_make_claim("Jane is Director at ACME")]
    _, save_conflicts_mock, save_meta_alert_mock, _, _ = _run_with_stubs(claims, [], monkeypatch)

    save_conflicts_mock.assert_not_awaited()
    # No divergence / conflict_spike meta-alert either
    calls = save_meta_alert_mock.await_args_list
    kinds = [c.kwargs.get("alert_kind") for c in calls]
    assert "divergence" not in kinds
    assert "conflict_spike" not in kinds


def test_divergence_meta_alert_fires_on_small_conflict_count(monkeypatch):
    """1-2 conflicts → divergence warn."""
    claims = [_make_claim("c1"), _make_claim("c2")]
    fake_conflicts = [
        {"type": "role", "claim_a": "x", "claim_b": "y", "description": "one"},
        {"type": "financial", "claim_a": "p", "claim_b": "q", "description": "two"},
    ]
    _, _, save_meta_alert_mock, _, _ = _run_with_stubs(claims, fake_conflicts, monkeypatch)

    divergence_calls = [c for c in save_meta_alert_mock.await_args_list
                        if c.kwargs.get("alert_kind") == "divergence"]
    assert len(divergence_calls) == 1
    assert divergence_calls[0].kwargs["severity"] == "warn"
    payload = divergence_calls[0].kwargs["payload"]
    assert payload["conflict_count"] == 2
    assert "role" in payload["types"]
    assert "financial" in payload["types"]


def test_conflict_spike_alert_at_three_or_more(monkeypatch):
    """3+ conflicts → conflict_spike (still warn severity; throttle
    only after Wave 2 orchestrator can act)."""
    claims = [_make_claim(f"c{i}") for i in range(5)]
    fake_conflicts = [
        {"type": "role", "claim_a": "x", "claim_b": "y", "description": f"c{i}"}
        for i in range(3)
    ]
    _, _, save_meta_alert_mock, _, _ = _run_with_stubs(claims, fake_conflicts, monkeypatch)

    spike_calls = [c for c in save_meta_alert_mock.await_args_list
                   if c.kwargs.get("alert_kind") == "conflict_spike"]
    assert len(spike_calls) == 1
    divergence_calls = [c for c in save_meta_alert_mock.await_args_list
                        if c.kwargs.get("alert_kind") == "divergence"]
    assert divergence_calls == []  # only conflict_spike fires, not both


def test_profile_carries_conflicts(monkeypatch):
    """The persisted profile dict has a conflicts key with the
    detected list — cockpit consumes this on render."""
    claims = [_make_claim("c1")]
    fake_conflicts = [{"type": "role", "claim_a": "x", "claim_b": "y", "description": "z"}]
    _, _, _, save_profile_mock, _ = _run_with_stubs(claims, fake_conflicts, monkeypatch)

    save_profile_mock.assert_awaited()
    profile = save_profile_mock.await_args.args[1]
    assert "conflicts" in profile
    assert profile["conflicts"] == fake_conflicts


def test_no_meta_alert_when_user_email_missing(monkeypatch):
    """Audit attribution mandatory: no user_email → skip meta-alert."""
    claims = [_make_claim("c1")]
    fake_conflicts = [{"type": "role", "claim_a": "x", "claim_b": "y", "description": "z"}]
    _, save_conflicts_mock, save_meta_alert_mock, _, _ = _run_with_stubs(
        claims, fake_conflicts, monkeypatch, user_email=None,
    )

    # Conflicts STILL get persisted to conflict_log (that path doesn't
    # require email) — but the meta-alert is skipped.
    save_conflicts_mock.assert_awaited_once()
    meta_calls = [c for c in save_meta_alert_mock.await_args_list
                  if c.kwargs.get("alert_kind") in ("divergence", "conflict_spike")]
    assert meta_calls == []
