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
# verify_urls — fail-closed semantics + shared client (F3)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_verify_urls_200_kept_and_marked_ok():
    from pebble.orchestrator._pipeline import verify_urls
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"ok")

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        live, dropped = await verify_urls(
            [_claim("X", "https://a.org/1")], client=client,
        )
    assert len(live) == 1
    assert len(dropped) == 0
    assert live[0].get("url_verification_status") == "verified"


@pytest.mark.asyncio
async def test_verify_urls_404_dropped():
    from pebble.orchestrator._pipeline import verify_urls
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        live, dropped = await verify_urls(
            [_claim("Y", "https://a.org/missing")], client=client,
        )
    assert live == []
    assert len(dropped) == 1


@pytest.mark.asyncio
async def test_verify_urls_5xx_kept_but_marked_transient():
    """Server errors are not the claim's fault — keep it, but tell
    the synthesizer the URL is unverified-transient so it caveats."""
    from pebble.orchestrator._pipeline import verify_urls
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        live, dropped = await verify_urls(
            [_claim("Z", "https://a.org/down")], client=client,
        )
    assert len(live) == 1
    assert live[0]["url_verification_status"] == "transient_error"
    assert dropped == []


@pytest.mark.asyncio
async def test_verify_urls_network_error_kept_but_marked_transient():
    from pebble.orchestrator._pipeline import verify_urls
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns dead")

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        live, dropped = await verify_urls(
            [_claim("W", "https://nope.invalid/")], client=client,
        )
    assert len(live) == 1
    assert live[0]["url_verification_status"] == "transient_error"


@pytest.mark.asyncio
async def test_verify_urls_4xx_other_dropped():
    """403, 410 etc. are likely permanent — drop."""
    from pebble.orchestrator._pipeline import verify_urls
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        live, dropped = await verify_urls(
            [_claim("F", "https://a.org/forbidden")], client=client,
        )
    assert live == []
    assert len(dropped) == 1


@pytest.mark.asyncio
async def test_verify_urls_shared_client_used_for_all_claims():
    """The whole batch must use the same client — no new TCP+TLS per
    claim. We assert this by counting requests on a single transport."""
    from pebble.orchestrator._pipeline import verify_urls
    import httpx

    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        await verify_urls(
            [_claim(f"c{i}", f"https://a.org/{i}") for i in range(5)],
            client=client,
        )
    assert len(seen) == 5


@pytest.mark.asyncio
async def test_verify_urls_claim_without_url_dropped():
    from pebble.orchestrator._pipeline import verify_urls
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        live, dropped = await verify_urls(
            [_claim("urlless", "")], client=client,
        )
    assert live == []
    assert len(dropped) == 1


# ---------------------------------------------------------------------------
# Name-match validation (F4)
# ---------------------------------------------------------------------------

def test_validate_person_name_exact():
    from pebble.name_match import validate_person_name
    assert validate_person_name("Jane Smith", "Jane Smith")


def test_validate_person_name_handles_comma_and_case():
    from pebble.name_match import validate_person_name
    assert validate_person_name("Jane Smith", "Smith, Jane")
    assert validate_person_name("jane smith", "JANE SMITH")


def test_validate_person_name_requires_two_token_overlap():
    """A common first OR last name alone isn't enough — both first and
    last must appear (in any order) for a FEC/USA record to attach."""
    from pebble.name_match import validate_person_name
    assert not validate_person_name("Jane Smith", "Jane Doe")
    assert not validate_person_name("Jane Smith", "John Smith")


def test_validate_person_name_middle_initials_ok():
    from pebble.name_match import validate_person_name
    assert validate_person_name("Jane Smith", "Jane M. Smith")
    assert validate_person_name("Jane Marie Smith", "Jane Smith")


def test_validate_person_name_strips_titles():
    from pebble.name_match import validate_person_name
    assert validate_person_name("Jane Smith", "Dr. Jane Smith")
    assert validate_person_name("Jane Smith", "Jane Smith Jr.")


def test_validate_person_name_empty_inputs_reject():
    from pebble.name_match import validate_person_name
    assert not validate_person_name("", "Jane Smith")
    assert not validate_person_name("Jane Smith", "")
    assert not validate_person_name("", "")


def test_validate_org_name_handles_suffixes():
    from pebble.name_match import validate_org_name
    assert validate_org_name("Acme Corp", "Acme Corporation")
    assert validate_org_name("Acme Inc", "Acme")
    assert validate_org_name("The Smith Foundation", "Smith Foundation")


def test_validate_org_name_rejects_dissimilar():
    from pebble.name_match import validate_org_name
    assert not validate_org_name("Acme Corp", "Beta Industries")


def test_validate_org_name_distinct_token_single_match_ok():
    """An org with a single distinctive token (e.g. "Anthropic") should
    match the same name with suffixes added."""
    from pebble.name_match import validate_org_name
    assert validate_org_name("Anthropic", "Anthropic, PBC")


# Pipeline integration: claims_from_fec drops mismatched contributor_name.

def test_claims_from_fec_drops_mismatched_contributor():
    from pebble.claim_templates import claims_from_fec
    fec_results = [
        {"contributor_name": "Jane Smith",
         "contribution_receipt_amount": 1000,
         "committee_name": "ActBlue",
         "contribution_receipt_date": "2024-01-15"},
        {"contributor_name": "John Doe",
         "contribution_receipt_amount": 500,
         "committee_name": "Republican PAC",
         "contribution_receipt_date": "2024-02-01"},
    ]
    out = claims_from_fec(fec_results, prospect_name="Jane Smith")
    assert len(out) == 1
    assert "Jane Smith" in out[0]["text"]


def test_claims_from_usaspending_drops_mismatched_recipient():
    from pebble.claim_templates import claims_from_usaspending
    results = [
        {"recipient_name": "Acme Corp",
         "award_amount": 50000,
         "awarding_agency_name": "DOD",
         "period_of_performance_start_date": "2024-01-01",
         "source_url": "https://usa.gov/x"},
        {"recipient_name": "Different Org",
         "award_amount": 1000,
         "awarding_agency_name": "DOE",
         "period_of_performance_start_date": "2024-02-01",
         "source_url": "https://usa.gov/y"},
    ]
    out = claims_from_usaspending(results, prospect_org="Acme Corp")
    assert len(out) == 1
    assert "Acme Corp" in out[0]["text"]


def test_claims_from_fec_no_filter_when_prospect_name_omitted():
    """Backwards-compat: existing callers that don't pass prospect_name
    get the unfiltered behavior they had before F4."""
    from pebble.claim_templates import claims_from_fec
    fec_results = [
        {"contributor_name": "John Doe",
         "contribution_receipt_amount": 500,
         "committee_name": "x",
         "contribution_receipt_date": "2024-02-01"},
    ]
    out = claims_from_fec(fec_results)
    assert len(out) == 1


# ---------------------------------------------------------------------------
# Synthesis citation invariants (F5)
# ---------------------------------------------------------------------------

def test_validate_synthesis_output_happy():
    from pebble.orchestrator._pipeline import _validate_synthesis_output
    parsed = {
        "sentences": [
            {"text": "Jane Smith is the CEO of Acme.", "citations": ["c0", "c1"]},
            {"text": "She gave $25k to ActBlue.", "citations": ["c2"]},
        ],
        "confidence_score": "high",
    }
    ok, err = _validate_synthesis_output(parsed, {"c0", "c1", "c2"})
    assert ok, err


def test_validate_synthesis_output_rejects_uncited_sentence():
    from pebble.orchestrator._pipeline import _validate_synthesis_output
    parsed = {
        "sentences": [
            {"text": "Jane is the CEO of Acme.", "citations": ["c0"]},
            {"text": "She is also known for philanthropy.", "citations": []},
        ],
        "confidence_score": "medium",
    }
    ok, err = _validate_synthesis_output(parsed, {"c0"})
    assert not ok
    assert "uncited" in err.lower()


def test_validate_synthesis_output_rejects_unknown_claim_id():
    from pebble.orchestrator._pipeline import _validate_synthesis_output
    parsed = {
        "sentences": [
            {"text": "x.", "citations": ["c999"]},
        ],
        "confidence_score": "low",
    }
    ok, err = _validate_synthesis_output(parsed, {"c0"})
    assert not ok
    assert "unknown" in err.lower() or "c999" in err


def test_validate_synthesis_output_rejects_no_sentences():
    from pebble.orchestrator._pipeline import _validate_synthesis_output
    parsed = {"sentences": [], "confidence_score": "high"}
    ok, err = _validate_synthesis_output(parsed, {"c0"})
    assert not ok


def test_validate_synthesis_output_rejects_empty_sentence_text():
    from pebble.orchestrator._pipeline import _validate_synthesis_output
    parsed = {
        "sentences": [
            {"text": "", "citations": ["c0"]},
        ],
        "confidence_score": "high",
    }
    ok, err = _validate_synthesis_output(parsed, {"c0"})
    assert not ok


def test_validate_synthesis_output_rejects_wrong_shape():
    from pebble.orchestrator._pipeline import _validate_synthesis_output
    ok, err = _validate_synthesis_output({"summary": "x"}, {"c0"})
    assert not ok
    ok, err = _validate_synthesis_output(
        {"sentences": "string not list"}, {"c0"},
    )
    assert not ok


def test_assign_claim_ids_stable_and_in_order():
    from pebble.orchestrator._pipeline import _assign_claim_ids
    claims = [
        _claim("a", "https://x/1"),
        _claim("b", "https://x/2"),
        _claim("c", "https://x/3"),
    ]
    ided = _assign_claim_ids(claims)
    assert [c["claim_id"] for c in ided] == ["c0", "c1", "c2"]


def _synthesizer_result(content: str, outcome=AgentOutcome.SUCCESS,
                        cost_usd: float = 0.001) -> HarnessResult:
    return HarnessResult(outcome=outcome, data={"content": content}, cost_usd=cost_usd)


@pytest.mark.asyncio
async def test_synthesize_profile_happy_path(monkeypatch):
    """Verifies the citation contract end-to-end. Confidence here is
    'low' because the test claim pool is single-claim with no
    verification metadata — that's the deterministic rubric working
    as designed (audit-traceable, not LLM-picked)."""
    from pebble.orchestrator import _pipeline
    import json

    claims = [_claim("CEO of Acme", "https://acme.org/x", origin="forager")]
    response = json.dumps({
        "sentences": [
            {"text": "Serves as CEO of Acme.", "citations": ["c0"]},
        ],
        "confidence_score": "high",  # LLM-suggested; will be overridden
    })

    async def fake_to_thread(fn, prompt, system=""):
        return _synthesizer_result(response)

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(_pipeline, "log_harness_outcome", AsyncMock())

    out = await _pipeline.synthesize_profile(
        claims, {"first_name": "Jane", "last_name": "Smith"},
        MagicMock(), _budget(),
    )
    assert out["partial"] is False
    assert out["summary"] == "Serves as CEO of Acme."
    assert out["summary_sentences"][0]["citations"] == ["c0"]
    # Deterministic rubric overrides the LLM. The LLM's suggestion is
    # preserved for auditing the divergence.
    assert out["confidence_score"] == "low"
    assert out["confidence_llm_suggested"] == "high"


@pytest.mark.asyncio
async def test_synthesize_profile_confidence_high_with_full_pool(monkeypatch):
    """High-confidence pool: 2 forager-origin claims, full 3-of-3
    quorum, verified URLs. Confidence emerges as 'high' regardless of
    what the LLM suggests."""
    from pebble.orchestrator import _pipeline
    import json

    claims = [
        _verified_claim("forager", votes=3, n_success=3,
                        text="CEO of Acme", source_url="https://acme.org/x"),
        _verified_claim("forager", votes=3, n_success=3,
                        text="Board chair at Beta",
                        source_url="https://beta.org/y"),
    ]
    response = json.dumps({
        "sentences": [
            {"text": "Serves as CEO of Acme.", "citations": ["c0"]},
            {"text": "Also chairs the Beta board.", "citations": ["c1"]},
        ],
        "confidence_score": "low",  # LLM suggests low; deterministic upgrade
    })

    async def fake_to_thread(fn, prompt, system=""):
        return _synthesizer_result(response)

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(_pipeline, "log_harness_outcome", AsyncMock())

    out = await _pipeline.synthesize_profile(
        claims, {"first_name": "Jane", "last_name": "Smith"},
        MagicMock(), _budget(),
    )
    assert out["confidence_score"] == "high"
    assert out["confidence_llm_suggested"] == "low"


@pytest.mark.asyncio
async def test_synthesize_profile_retries_on_invalid_then_succeeds(monkeypatch):
    from pebble.orchestrator import _pipeline
    import json

    claims = [_claim("CEO of Acme", "https://acme.org/x", origin="forager")]
    bad = json.dumps({  # missing citations
        "sentences": [{"text": "She is known.", "citations": []}],
        "confidence_score": "medium",
    })
    good = json.dumps({
        "sentences": [{"text": "Serves as CEO of Acme.", "citations": ["c0"]}],
        "confidence_score": "high",
    })

    call_count = {"n": 0}

    async def fake_to_thread(fn, prompt, system=""):
        call_count["n"] += 1
        return _synthesizer_result(bad if call_count["n"] == 1 else good)

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(_pipeline, "log_harness_outcome", AsyncMock())

    out = await _pipeline.synthesize_profile(
        claims, {"first_name": "Jane", "last_name": "Smith"},
        MagicMock(), _budget(),
    )
    assert call_count["n"] == 2
    assert out["partial"] is False
    assert out["summary"]


# ---------------------------------------------------------------------------
# Deterministic confidence rubric (F8)
# ---------------------------------------------------------------------------

def _verified_claim(origin, votes, n_success, url_status="verified", **extra):
    c = _claim(extra.pop("text", "x"), extra.pop("source_url", "https://x/1"),
               origin=origin, confidence=extra.pop("confidence", "high"))
    c["verification_votes"] = votes
    c["verifiers_successful"] = n_success
    c["url_verification_status"] = url_status
    c.update(extra)
    return c


def test_confidence_high_requires_forager_full_quorum_all_urls_verified():
    from pebble.orchestrator._pipeline import compute_confidence_score
    claims = [
        _verified_claim("forager", votes=3, n_success=3),
        _verified_claim("forager", votes=3, n_success=3),
        _verified_claim("template", votes=2, n_success=3),
    ]
    assert compute_confidence_score(claims) == "high"


def test_confidence_medium_when_only_template_claims():
    from pebble.orchestrator._pipeline import compute_confidence_score
    claims = [
        _verified_claim("template", votes=2, n_success=3),
        _verified_claim("template", votes=2, n_success=3),
    ]
    assert compute_confidence_score(claims) == "medium"


def test_confidence_low_when_partial_quorum():
    from pebble.orchestrator._pipeline import compute_confidence_score
    claims = [
        _verified_claim("forager", votes=2, n_success=2),
    ]
    # 2-of-2 is full consensus but only 2 successful verifiers; this is
    # below the high bar (need full 3-of-3 quorum or 2-of-3 with all-3-
    # voted), and the single-claim pool is too thin → low.
    assert compute_confidence_score(claims) == "low"


def test_confidence_low_when_urls_transient():
    from pebble.orchestrator._pipeline import compute_confidence_score
    claims = [
        _verified_claim("forager", votes=3, n_success=3,
                        url_status="transient_error"),
        _verified_claim("forager", votes=3, n_success=3,
                        url_status="transient_error"),
        _verified_claim("forager", votes=3, n_success=3,
                        url_status="transient_error"),
    ]
    # All URLs unverified → can't claim high even with full quorum.
    assert compute_confidence_score(claims) != "high"


def test_confidence_low_with_no_claims():
    from pebble.orchestrator._pipeline import compute_confidence_score
    assert compute_confidence_score([]) == "low"


# ---------------------------------------------------------------------------
# Conflict detection (F7)
# ---------------------------------------------------------------------------

def test_detect_conflicts_former_vs_current():
    from pebble.orchestrator._pipeline import detect_conflicts
    claims = [
        _claim("Jane Smith serves as CEO of Acme Corp.",
               "https://acme.org/exec", origin="template"),
        _claim("Jane Smith was formerly CEO of Acme Corp.",
               "https://wiki.org/jane", origin="forager"),
    ]
    conflicts = detect_conflicts(claims)
    assert len(conflicts) == 1
    assert "Acme" in conflicts[0]["description"]


def test_detect_conflicts_no_conflict_different_orgs():
    from pebble.orchestrator._pipeline import detect_conflicts
    claims = [
        _claim("Jane is CEO of Acme.", "https://acme.org/x"),
        _claim("Jane was formerly CEO of Beta Industries.",
               "https://beta.com/x"),
    ]
    assert detect_conflicts(claims) == []


def test_detect_conflicts_handles_empty_and_single():
    from pebble.orchestrator._pipeline import detect_conflicts
    assert detect_conflicts([]) == []
    assert detect_conflicts([
        _claim("Jane is CEO of Acme.", "https://x/1"),
    ]) == []


def test_detect_conflicts_records_conflicting_claim_ids():
    """Conflicts should reference the claim_ids that disagree so the
    synthesizer can name them in its caveat."""
    from pebble.orchestrator._pipeline import detect_conflicts, _assign_claim_ids
    claims = _assign_claim_ids([
        _claim("Jane Smith currently serves as CEO of Acme Corp.",
               "https://acme.org/exec"),
        _claim("Jane Smith was previously CEO of Acme Corp.",
               "https://wiki.org/jane"),
    ])
    conflicts = detect_conflicts(claims)
    assert len(conflicts) == 1
    assert set(conflicts[0]["claim_ids"]) == {"c0", "c1"}


def test_confidence_high_to_medium_when_conflict_detected():
    from pebble.orchestrator._pipeline import compute_confidence_score
    claims = [
        _verified_claim("forager", votes=3, n_success=3),
        _verified_claim("forager", votes=3, n_success=3),
        _verified_claim("forager", votes=3, n_success=3),
    ]
    # Conflict detected → downgrade from high to medium (the
    # synthesizer must acknowledge the discrepancy).
    assert compute_confidence_score(claims, conflicts=[{"d": "x"}]) == "medium"


# ---------------------------------------------------------------------------
# synthesize_profile both-attempts-fail (keeps existing test)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# End-to-end pipeline contract (research_single_prospect)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_research_single_prospect_end_to_end_contract(monkeypatch):
    """One integration test asserting the whole-pipeline invariants for
    a synthetic prospect:

      * Every claim entering synthesis carries a stable claim_id.
      * The final summary's sentence citations are restricted to those
        claim_ids (no orphan references).
      * confidence_score is deterministic (rubric-driven, not LLM-picked).
      * save_profile is called exactly once with the final profile dict.
      * Quorum + conflict-detect + verify_urls + dedup all run on the
        merged claim pool.

    Mocks every external dep: fetch_research_data, DB saves,
    log_harness_outcome, and the harness LLM calls (via asyncio.to_thread).
    """
    from pebble.orchestrator import _pipeline
    import json
    import httpx

    prospect = {
        "id": "p-1",
        "first_name": "Jane",
        "last_name": "Smith",
        "organization": "Acme Corp",
    }

    fec_results = [
        {"contributor_name": "Jane Smith",
         "contribution_receipt_amount": 1000,
         "committee_name": "ActBlue",
         "contribution_receipt_date": "2024-01-15"},
        {"contributor_name": "Different Person",
         "contribution_receipt_amount": 5000,
         "committee_name": "x",
         "contribution_receipt_date": "2024-02-01"},
    ]

    async def fake_fetch(_p, _cc):
        return {
            "ein": None, "name": "Jane Smith", "primary_org": "Acme Corp",
            "ein_orgs": None, "cik_result": None,
            "fec_data": fec_results,
            "edgar_data": None, "usa_data": None, "wiki_data": None,
            "oc_data": None, "propublica_data": None, "sec_data": None,
        }

    monkeypatch.setattr(_pipeline, "fetch_research_data", fake_fetch)
    monkeypatch.setattr(_pipeline, "save_source_scores", AsyncMock())
    monkeypatch.setattr(_pipeline, "save_profile", AsyncMock())
    monkeypatch.setattr(_pipeline, "save_session", AsyncMock())
    monkeypatch.setattr(_pipeline, "log_harness_outcome", AsyncMock())
    monkeypatch.setattr(_pipeline, "get_source_reliability",
                        AsyncMock(return_value=1.0))

    # Mock the synthesis LLM. Verifiers must succeed too.
    def harness_dispatch(spec):
        if spec.agent_name in {"verifier_source", "verifier_consistency", "verifier_crossref"}:
            return _verifier_success([0])  # approve the single claim
        if spec.agent_name in {"api_response_extractor", "wealth_indicator_agent", "philanthropy_agent"}:
            return _synthesizer_result(json.dumps({"claims": []}))
        return _synthesizer_result(json.dumps({"claims": []}))

    async def fake_to_thread(fn_or_method, *args, **kwargs):
        # harness.execute_task(spec) → args = (spec,)
        # harness.execute(prompt, system=...) → args = (prompt,), kwargs has system
        if args and hasattr(args[0], "agent_name"):
            return harness_dispatch(args[0])
        # synthesizer: emit a single-sentence cited brief
        return _synthesizer_result(json.dumps({
            "sentences": [
                {"text": "Jane Smith donated to ActBlue.", "citations": ["c0"]},
            ],
            "confidence_score": "high",
        }))

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)

    # Shared MockTransport for verify_urls
    def mock_url_handler(request):
        return httpx.Response(200)

    async def patched_verify_urls(claims, *, client=None, timeout=5.0):
        # Skip the HEAD calls; mark all as verified so synthesis sees them.
        for c in claims:
            c["url_verification_status"] = "verified"
        return claims, []

    monkeypatch.setattr(_pipeline, "verify_urls", patched_verify_urls)

    def never_cancel():
        return False

    result = await _pipeline.research_single_prospect(
        prospect, "p-1", MagicMock(), never_cancel, user_email="t@x",
    )

    # The pipeline returned with a claim count.
    assert "claims_count" in result
    # save_profile was called exactly once.
    assert _pipeline.save_profile.await_count == 1
    saved_profile = _pipeline.save_profile.await_args.args[1]
    # F5 — every saved claim has a claim_id.
    assert all(c.get("claim_id") for c in saved_profile["claims"])
    # F5 — citation references are restricted to known claim_ids.
    sentences = saved_profile.get("summary_sentences", [])
    assert sentences
    valid_ids = {c["claim_id"] for c in saved_profile["claims"]}
    for sent in sentences:
        assert sent["citations"]
        for cite in sent["citations"]:
            assert cite in valid_ids, f"orphan citation {cite!r}"
    # F8 — confidence_score is a string from the deterministic rubric.
    assert saved_profile["confidence_score"] in {"high", "medium", "low"}
    # F4 — name-match dropped the "Different Person" FEC contributor.
    # Only Jane Smith's donation should remain in the claim pool.
    contributor_texts = [
        c.get("text", "") for c in saved_profile["claims"]
        if c.get("origin") == "template"
    ]
    assert all(
        "Different Person" not in t for t in contributor_texts
    ), f"name-match filter failed: {contributor_texts}"


@pytest.mark.asyncio
async def test_synthesize_profile_prompt_includes_conflicts(monkeypatch):
    """When conflicts are detected, the synthesis system prompt must
    name them so the brief addresses the discrepancy explicitly."""
    from pebble.orchestrator import _pipeline
    import json

    claims = [_claim("CEO of Acme", "https://acme.org/x", origin="forager")]
    response = json.dumps({
        "sentences": [{"text": "Serves as CEO of Acme.", "citations": ["c0"]}],
        "confidence_score": "high",
    })
    conflicts = [{"description": "role at Acme disputed", "claim_ids": ["c0", "c1"]}]
    captured = {"system": None}

    async def fake_to_thread(fn, prompt, system=""):
        captured["system"] = system
        return _synthesizer_result(response)

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(_pipeline, "log_harness_outcome", AsyncMock())

    await _pipeline.synthesize_profile(
        claims, {"first_name": "Jane", "last_name": "Smith"},
        MagicMock(), _budget(), conflicts=conflicts,
    )
    assert "role at Acme disputed" in (captured["system"] or "")
    assert "discrepancies" in (captured["system"] or "").lower()


@pytest.mark.asyncio
async def test_synthesize_profile_citation_contract_in_system_prompt(monkeypatch):
    """Every synthesis call must instruct the LLM with the explicit
    'every sentence MUST cite ≥1 claim_id' rule + the allowed id set."""
    from pebble.orchestrator import _pipeline
    import json

    claims = [
        _claim("CEO of Acme", "https://acme.org/x", origin="forager"),
        _claim("Board chair at Beta", "https://beta.org/y", origin="forager"),
    ]
    response = json.dumps({
        "sentences": [
            {"text": "CEO.", "citations": ["c0"]},
            {"text": "Chair.", "citations": ["c1"]},
        ],
        "confidence_score": "low",
    })
    captured = {"system": None, "prompt": None}

    async def fake_to_thread(fn, prompt, system=""):
        captured["system"] = system
        captured["prompt"] = prompt
        return _synthesizer_result(response)

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(_pipeline, "log_harness_outcome", AsyncMock())

    await _pipeline.synthesize_profile(
        claims, {"first_name": "Jane", "last_name": "Smith"},
        MagicMock(), _budget(),
    )
    sys_text = captured["system"] or ""
    prompt_text = captured["prompt"] or ""
    assert "EVERY sentence" in sys_text
    assert "claim_id" in sys_text
    assert "c0" in prompt_text and "c1" in prompt_text


@pytest.mark.asyncio
async def test_synthesize_profile_both_attempts_fail_returns_partial(monkeypatch):
    from pebble.orchestrator import _pipeline
    import json

    claims = [_claim("CEO of Acme", "https://acme.org/x", origin="forager")]
    bad = json.dumps({"sentences": [{"text": "x", "citations": ["c99"]}]})

    async def fake_to_thread(fn, prompt, system=""):
        return _synthesizer_result(bad)

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(_pipeline, "log_harness_outcome", AsyncMock())

    out = await _pipeline.synthesize_profile(
        claims, {"first_name": "Jane", "last_name": "Smith"},
        MagicMock(), _budget(),
    )
    assert out["partial"] is True
    assert out["summary"] == ""
    assert out["confidence_score"] == "low"
    assert "validation_error" in out


# ---------------------------------------------------------------------------
# Claim ranking (existing behavior — sanity)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Forager source-URL anchoring (F12)
# ---------------------------------------------------------------------------

def test_filter_claims_to_provided_sources_exact_match():
    from pebble.orchestrator._pipeline import _filter_claims_to_provided_sources
    claims = [_claim("X", "https://api.open.fec.gov/")]
    out = _filter_claims_to_provided_sources(claims, ["https://api.open.fec.gov/"])
    assert len(out) == 1


def test_filter_claims_to_provided_sources_prefix_match():
    """A forager may emit a more specific URL than the provided base
    (adding a path/fragment). The filter accepts startswith."""
    from pebble.orchestrator._pipeline import _filter_claims_to_provided_sources
    claims = [_claim("X", "https://en.wikipedia.org/wiki/Jane_Smith#career")]
    out = _filter_claims_to_provided_sources(
        claims, ["https://en.wikipedia.org/wiki/Jane_Smith"],
    )
    assert len(out) == 1


def test_filter_claims_drops_hallucinated_urls():
    from pebble.orchestrator._pipeline import _filter_claims_to_provided_sources
    claims = [
        _claim("X", "https://api.open.fec.gov/x"),     # valid
        _claim("Y", "https://hallucinated.example.com"),  # not provided
        _claim("Z", "https://api.opencorporates.com/y"),  # valid
    ]
    provided = ["https://api.open.fec.gov/", "https://api.opencorporates.com/"]
    out = _filter_claims_to_provided_sources(claims, provided)
    assert {c["text"] for c in out} == {"X", "Z"}


def test_filter_claims_empty_provided_list_keeps_all():
    """When the agent's source_urls list is empty (e.g., a workflow
    that doesn't bind to a single source), don't drop everything —
    fall through to existing source_url-presence check."""
    from pebble.orchestrator._pipeline import _filter_claims_to_provided_sources
    claims = [_claim("X", "https://x/1"), _claim("Y", "https://y/2")]
    out = _filter_claims_to_provided_sources(claims, [])
    assert len(out) == 2


# ---------------------------------------------------------------------------
# Budget-exhaustion contract (F11)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_quorum_budget_exhausted_rejects_all_claims(monkeypatch):
    """Fidelity invariant: when the budget cap is hit mid-pipeline,
    quorum_verify_claims must NOT return unverified claims as if they
    passed. The previous behavior (return claims unchanged) silently
    promoted unverified data to the synthesizer — exactly the failure
    mode F1's fail-closed semantics was meant to close."""
    from pebble.orchestrator._pipeline import (
        quorum_verify_claims, ProspectBudgetTracker,
    )

    claims = [_claim("X", "https://x/1"), _claim("Y", "https://x/2")]
    budget = ProspectBudgetTracker(prospect_id="p1", cap_usd=0.0)
    budget.add(1.0)  # force exceeded
    assert budget.exceeded()

    monkeypatch.setattr(
        "pebble.orchestrator._pipeline.log_harness_outcome",
        AsyncMock(),
    )

    verified = await quorum_verify_claims(claims, {"id": "p1"}, MagicMock(), budget)
    assert verified == []


@pytest.mark.asyncio
async def test_synthesize_profile_budget_exhausted_returns_full_shape(monkeypatch):
    """The budget-exhausted return path must include summary_sentences
    (even if empty) so research_single_prospect's pipeline doesn't lose
    that key downstream."""
    from pebble.orchestrator._pipeline import (
        synthesize_profile, ProspectBudgetTracker,
    )

    claims = [_claim("X", "https://x/1", origin="forager")]
    budget = ProspectBudgetTracker(prospect_id="p1", cap_usd=0.0)
    budget.add(1.0)

    out = await synthesize_profile(claims, {}, MagicMock(), budget)
    assert out["partial"] is True
    assert out["summary"] == ""
    assert "summary_sentences" in out
    assert out["summary_sentences"] == []
    assert out["confidence_score"] in {"low", "medium"}


# ---------------------------------------------------------------------------
# Freshness-weighted ranking (F10)
# ---------------------------------------------------------------------------

def test_freshness_tier_recent_vs_stale():
    from pebble.orchestrator._pipeline import _freshness_tier
    from datetime import date
    this_year = date.today().year
    assert _freshness_tier({"data_as_of": f"{this_year}-01-01"}) == 0
    assert _freshness_tier({"data_as_of": f"{this_year - 3}-01-01"}) == 1
    assert _freshness_tier({"data_as_of": f"{this_year - 8}-01-01"}) == 2


def test_freshness_tier_unknown_date():
    from pebble.orchestrator._pipeline import _freshness_tier
    assert _freshness_tier({"data_as_of": None}) == 3
    assert _freshness_tier({"data_as_of": ""}) == 3
    assert _freshness_tier({}) == 3
    assert _freshness_tier({"data_as_of": "garbage"}) == 3


def test_rank_claims_prefers_fresh_within_same_origin():
    from pebble.orchestrator._pipeline import _rank_claims
    from datetime import date
    this_year = date.today().year
    claims = [
        _claim("old", "https://x/1", origin="template"),
        _claim("new", "https://x/2", origin="template"),
    ]
    claims[0]["data_as_of"] = f"{this_year - 8}-01-01"
    claims[1]["data_as_of"] = f"{this_year}-01-01"
    ranked = _rank_claims(claims)
    assert ranked[0]["text"] == "new"


def test_rank_claims_origin_dominates_freshness():
    """A stale forager claim still beats a fresh template claim —
    analytical findings outweigh raw data points even when older."""
    from pebble.orchestrator._pipeline import _rank_claims
    from datetime import date
    this_year = date.today().year
    claims = [
        _claim("recent template", "https://x/1", origin="template"),
        _claim("old forager", "https://x/2", origin="forager"),
    ]
    claims[0]["data_as_of"] = f"{this_year}-01-01"
    claims[1]["data_as_of"] = f"{this_year - 9}-01-01"
    ranked = _rank_claims(claims)
    assert ranked[0]["origin"] == "forager"


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
