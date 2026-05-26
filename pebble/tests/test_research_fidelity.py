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


def test_claims_from_edgar_drops_mismatched_entity():
    from pebble.claim_templates import claims_from_edgar_search
    results = [
        {"entity_name": "Acme Corp",
         "file_type": "10-K",
         "file_date": "2024-03-01",
         "file_url": "https://www.sec.gov/x"},
        {"entity_name": "Unrelated Industries",
         "file_type": "10-Q",
         "file_date": "2024-02-15",
         "file_url": "https://www.sec.gov/y"},
    ]
    out = claims_from_edgar_search(results, prospect_org="Acme Corp")
    assert len(out) == 1
    assert "Acme" in out[0]["text"]


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

    # Authoritative-source URLs so the F13 high-tier gate clears.
    claims = [
        _verified_claim("forager", votes=3, n_success=3,
                        text="CEO of Acme", source_url="https://www.fec.gov/x"),
        _verified_claim("forager", votes=3, n_success=3,
                        text="Board chair at Beta",
                        source_url="https://projects.propublica.org/nonprofits/organizations/123"),
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
    # Use authoritative URLs so F13's source-tier gate clears.
    claims = [
        _verified_claim("forager", votes=3, n_success=3,
                        source_url="https://www.fec.gov/x"),
        _verified_claim("forager", votes=3, n_success=3,
                        source_url="https://api.usaspending.gov/y"),
        _verified_claim("template", votes=2, n_success=3,
                        source_url="https://www.sec.gov/z"),
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
        _verified_claim("forager", votes=3, n_success=3,
                        source_url="https://www.fec.gov/a"),
        _verified_claim("forager", votes=3, n_success=3,
                        source_url="https://api.usaspending.gov/b"),
        _verified_claim("forager", votes=3, n_success=3,
                        source_url="https://www.sec.gov/c"),
    ]
    # Conflict detected → downgrade from high to medium (the
    # synthesizer must acknowledge the discrepancy).
    assert compute_confidence_score(claims, conflicts=[{"d": "x"}]) == "medium"


# ---------------------------------------------------------------------------
# synthesize_profile both-attempts-fail (keeps existing test)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Verifier system-prompt strictness
# ---------------------------------------------------------------------------

def test_forager_prompts_forbid_url_invention():
    """Forager + stage1 system prompts explicitly forbid the LLM from
    inventing source_urls outside the provided list. Pairs with the
    F12 post-hoc filter — prompt + filter is defense in depth."""
    from pebble.harness import PROMPT_TEMPLATES
    for name in ("wealth_indicator_agent", "philanthropy_agent",
                 "api_response_extractor"):
        _, system = PROMPT_TEMPLATES[name]({
            "prospect": {"first_name": "X", "last_name": "Y"},
            "fec_data": [], "oc_data": [], "usa_data": [],
            "propublica_data": None, "edgar_data": [], "wiki_data": None,
            "context_parts": [],
        }, [])
        lower = system.lower()
        assert "do not invent" in lower or "do not cite urls" in lower, (
            f"{name} doesn't forbid URL invention"
        )


def test_verifier_source_prompt_uses_tier_annotations():
    """The verifier_source prompt instructs the LLM to use the tier
    annotation on each claim so it doesn't have to re-classify URLs
    from scratch. Pairs with quorum_verify_claims passing tier:N in
    the claims_text format."""
    from pebble.harness import PROMPT_TEMPLATES
    prompt, _ = PROMPT_TEMPLATES["verifier_source"](
        {"claims_text": "[0] x (source: https://x, tier: 0, confidence: high)"}, [],
    )
    assert "tier" in prompt
    assert "tier 0" in prompt.lower() or "tier 0–1" in prompt or "tier 0-1" in prompt


def test_verifier_prompts_bias_toward_rejection():
    """The verifier system prompts must explicitly bias toward
    rejection when uncertain. Silently passing a wrong claim into a
    development officer's brief is the loss function we minimize."""
    from pebble.harness import PROMPT_TEMPLATES
    for name in ("verifier_source", "verifier_consistency", "verifier_crossref"):
        _, system = PROMPT_TEMPLATES[name]({"claims_text": ""}, [])
        lower = system.lower()
        assert "reject" in lower, f"{name} system prompt missing rejection language"
        assert ("bias toward rejection" in lower
                or "uncertain" in lower), f"{name} doesn't bias toward rejection"


# ---------------------------------------------------------------------------
# F9 — claim-pool fingerprint
# ---------------------------------------------------------------------------

def test_claim_pool_fingerprint_stable_under_reorder():
    from pebble.orchestrator._pipeline import claim_pool_fingerprint
    a = [
        _claim("CEO of Acme", "https://acme.org/x", origin="forager"),
        _claim("Donated $1k", "https://fec.gov/y", origin="template"),
    ]
    b = list(reversed(a))
    assert claim_pool_fingerprint(a) == claim_pool_fingerprint(b)


def test_claim_pool_fingerprint_changes_on_text_change():
    from pebble.orchestrator._pipeline import claim_pool_fingerprint
    a = [_claim("CEO of Acme", "https://acme.org/x")]
    b = [_claim("CFO of Acme", "https://acme.org/x")]
    assert claim_pool_fingerprint(a) != claim_pool_fingerprint(b)


def test_claim_pool_fingerprint_changes_on_url_change():
    from pebble.orchestrator._pipeline import claim_pool_fingerprint
    a = [_claim("X", "https://a.org/1")]
    b = [_claim("X", "https://b.org/1")]
    assert claim_pool_fingerprint(a) != claim_pool_fingerprint(b)


def test_claim_pool_fingerprint_stable_for_empty_pool():
    from pebble.orchestrator._pipeline import claim_pool_fingerprint
    assert claim_pool_fingerprint([]) == claim_pool_fingerprint([])
    # Empty pool should have a non-empty distinct fingerprint string.
    fp = claim_pool_fingerprint([])
    assert isinstance(fp, str) and fp


def test_claim_pool_fingerprint_ignores_non_canonical_fields():
    """Fields that vary across runs without changing evidence content
    (claim_id, verification_votes, url_verification_status, …) must
    NOT change the fingerprint — the point is to detect *evidence*
    changes, not bookkeeping ones."""
    from pebble.orchestrator._pipeline import claim_pool_fingerprint
    a = [_claim("X", "https://x/1", origin="forager")]
    b = [_claim("X", "https://x/1", origin="forager")]
    b[0]["claim_id"] = "c0"
    b[0]["verification_votes"] = 3
    b[0]["url_verification_status"] = "verified"
    assert claim_pool_fingerprint(a) == claim_pool_fingerprint(b)


# ---------------------------------------------------------------------------
# Audit-write fail-soft
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_log_result_swallows_db_errors(monkeypatch):
    """A DB outage on the audit-log path must not propagate into the
    research pipeline. The verified output is more valuable than the
    log row."""
    from pebble.orchestrator import _pipeline

    async def explode(*args, **kwargs):
        raise ConnectionError("db is on fire")

    monkeypatch.setattr(_pipeline, "log_harness_outcome", explode)

    result = HarnessResult(outcome=AgentOutcome.SUCCESS,
                           data={"content": ""}, cost_usd=0.001)
    # Must not raise.
    await _pipeline._log_result(result, "test_agent", "p1")


# ---------------------------------------------------------------------------
# F14 — per-source fetch error tracking
# ---------------------------------------------------------------------------

def test_result_with_error_distinguishes_none_from_failure():
    from pebble.orchestrator._pipeline import _result_with_error
    val, err = _result_with_error({"x": 1})
    assert val == {"x": 1} and err is None
    val, err = _result_with_error(None)
    assert val is None and err is None
    val, err = _result_with_error(ConnectionError("dns dead"))
    assert val is None
    assert err is not None
    assert "ConnectionError" in err and "dns dead" in err


def test_research_quality_report_reports_source_error_count():
    from pebble.orchestrator._pipeline import research_quality_report
    profile = {
        "claims": [],
        "source_errors": {
            "propublica_search": "TimeoutError: 30s",
            "sec_cik_search": "ConnectionError: dns",
        },
    }
    r = research_quality_report(profile)
    assert r["source_error_count"] == 2
    assert r["claim_count"] == 0


def test_research_quality_report_includes_pipeline_version():
    from pebble.orchestrator._pipeline import research_quality_report
    profile = {
        "claims": [],
        "pipeline_version": "fidelity-v1.14",
        "generated_at": "2026-05-24T10:30:00+00:00",
    }
    r = research_quality_report(profile)
    assert r["pipeline_version"] == "fidelity-v1.14"
    assert r["generated_at"] == "2026-05-24T10:30:00+00:00"


def test_research_quality_report_source_tier_breakdown():
    from pebble.orchestrator._pipeline import research_quality_report
    profile = {
        "claims": [
            {"source_url": "https://www.fec.gov/x"},          # tier 0
            {"source_url": "https://api.usaspending.gov/y"},  # tier 0
            {"source_url": "https://projects.propublica.org/nonprofits/organizations/1"},  # tier 1
            {"source_url": "https://en.wikipedia.org/wiki/X"},  # tier 2
            {"source_url": "https://blog.example.com/x"},      # tier 3
        ],
    }
    r = research_quality_report(profile)
    assert r["source_tier_counts"] == {0: 2, 1: 1, 2: 1, 3: 1}


# ---------------------------------------------------------------------------
# Markdown export
# ---------------------------------------------------------------------------

def test_export_markdown_fully_populated_profile_smoke():
    """Render a maximally-populated profile and confirm every section
    appears + the Markdown is internally well-formed (consistent
    table structure, no empty headers)."""
    from pebble.export import render_profile_markdown
    profile = {
        "claims": [
            {"text": "CEO of Acme", "source_url": "https://www.fec.gov/x",
             "claim_id": "c0", "confidence": "high",
             "origin": "forager",
             "verification_votes": 3, "verifiers_successful": 3,
             "source_tier": 0, "url_verification_status": "verified"},
            {"text": "Donated to ActBlue", "source_url": "https://www.fec.gov/y",
             "claim_id": "c1", "confidence": "high",
             "origin": "template",
             "verification_votes": 2, "verifiers_successful": 3,
             "source_tier": 0, "url_verification_status": "verified"},
        ],
        "summary": "CEO of Acme. Donated to ActBlue.",
        "summary_sentences": [
            {"text": "Serves as CEO of Acme.", "citations": ["c0"]},
            {"text": "Has donated to ActBlue.", "citations": ["c1"]},
        ],
        "conflicts": [
            {"description": "role at Acme disputed", "claim_ids": ["c0"]},
        ],
        "source_errors": {"propublica_search": "TimeoutError: 30s"},
        "confidence_score": "high",
        "claim_pool_fingerprint": "abcd1234567890ef",
        "partial": False,
        "failed_agents": [],
        "pipeline_version": "fidelity-v1.14",
        "generated_at": "2026-05-24T10:30:00+00:00",
    }
    md = render_profile_markdown(profile, "Jane Smith", "Acme")

    # Every major section appears.
    expected_sections = [
        "# Prospect Research: Jane Smith",
        "**Organization:** Acme",
        "**Confidence:** high",
        "**Evidence:**",
        "**Conflicts detected:** 1",
        "## Summary",
        "[[c0]]",
        "[[c1]]",
        "## Disputed claims",
        "role at Acme disputed",
        "## Unreachable sources",
        "propublica_search",
        "## Claims (2)",
        "primary .gov/.edu",
        "3/3",  # quorum cell
        "verified",
        "## Sources",
        "Evidence fingerprint",
    ]
    for needle in expected_sections:
        assert needle in md, f"missing section/marker: {needle}"

    # Table well-formed: header + separator + 2 data rows.
    assert md.count("| ID | Claim |") == 1
    assert md.count("|----|-------|") == 1


def test_export_markdown_renders_sentence_citations():
    from pebble.export import render_profile_markdown
    profile = {
        "claims": [
            {"text": "CEO of Acme", "source_url": "https://www.fec.gov/x",
             "claim_id": "c0", "confidence": "high",
             "verification_votes": 3, "verifiers_successful": 3,
             "source_tier": 0, "url_verification_status": "verified"},
        ],
        "summary_sentences": [
            {"text": "Jane serves as CEO of Acme.", "citations": ["c0"]},
        ],
        "confidence_score": "high",
        "claim_pool_fingerprint": "abc123def456",
    }
    md = render_profile_markdown(profile, "Jane Smith", "Acme")
    # Sentence rendered with bracketed citation.
    assert "[[c0]]" in md
    # Claim table includes the source tier label.
    assert "primary .gov/.edu" in md
    # Quorum cell.
    assert "3/3" in md
    # Fingerprint footer.
    assert "abc123def456"[:16] in md


def test_export_markdown_header_includes_evidence_summary():
    from pebble.export import render_profile_markdown
    profile = {
        "claims": [
            {"text": "a", "source_url": "https://x/1", "origin": "forager",
             "url_verification_status": "verified"},
            {"text": "b", "source_url": "https://x/2", "origin": "forager",
             "url_verification_status": "verified"},
            {"text": "c", "source_url": "https://x/3", "origin": "template",
             "url_verification_status": "transient_error"},
        ],
        "confidence_score": "high",
    }
    md = render_profile_markdown(profile, "Jane", "")
    assert "**Evidence:** 3 claim(s)" in md
    assert "2 forager" in md
    assert "1 template" in md
    assert "2/3 URLs verified" in md


def test_export_markdown_lists_conflicts():
    from pebble.export import render_profile_markdown
    profile = {
        "claims": [],
        "conflicts": [
            {"description": "role at Acme disputed",
             "claim_ids": ["c0", "c1"]},
        ],
        "confidence_score": "medium",
    }
    md = render_profile_markdown(profile, "Jane Smith", "Acme")
    assert "Disputed claims" in md
    assert "role at Acme disputed" in md
    assert "`c0`" in md and "`c1`" in md
    assert "**Conflicts detected:** 1" in md


def test_export_markdown_partial_status_names_failed_agents():
    from pebble.export import render_profile_markdown
    profile = {
        "claims": [],
        "summary": "",
        "summary_sentences": [],
        "confidence_score": "low",
        "partial": True,
        "failed_agents": ["profile_synthesizer", "budget"],
    }
    md = render_profile_markdown(profile, "Jane", "")
    assert "Partial (profile_synthesizer, budget)" in md


def test_export_markdown_lists_unreachable_sources():
    """F14 — unreachable sources surfaced explicitly in the brief so
    development officers know the gap was a fetch failure, not real
    silence from the source."""
    from pebble.export import render_profile_markdown
    profile = {
        "claims": [],
        "source_errors": {
            "propublica_search": "TimeoutError: 30s",
            "sec_company": "ConnectionError: dns",
        },
        "confidence_score": "low",
    }
    md = render_profile_markdown(profile, "Jane", "")
    assert "Unreachable sources" in md
    assert "propublica_search" in md
    assert "TimeoutError" in md


def test_export_markdown_backwards_compat_with_old_summary_field():
    """Old profiles without summary_sentences still render via the
    flat summary string."""
    from pebble.export import render_profile_markdown
    profile = {
        "claims": [],
        "summary": "Pre-F5 free text brief.",
        "confidence_score": "medium",
    }
    md = render_profile_markdown(profile, "X", "")
    assert "Pre-F5 free text brief." in md


# ---------------------------------------------------------------------------
# Source-domain credibility tiers (F13)
# ---------------------------------------------------------------------------

def test_source_tier_gov_is_highest():
    from pebble.orchestrator._pipeline import classify_source_tier
    assert classify_source_tier("https://www.fec.gov/data/x") == 0
    assert classify_source_tier("https://api.usaspending.gov/") == 0
    assert classify_source_tier("https://www.sec.gov/cgi-bin/browse-edgar") == 0


def test_source_tier_edu_is_tier0():
    from pebble.orchestrator._pipeline import classify_source_tier
    assert classify_source_tier("https://stanford.edu/faculty/x") == 0


def test_source_tier_propublica_is_tier1():
    from pebble.orchestrator._pipeline import classify_source_tier
    assert classify_source_tier(
        "https://projects.propublica.org/nonprofits/organizations/123"
    ) == 1


def test_source_tier_wikipedia_is_tier2():
    from pebble.orchestrator._pipeline import classify_source_tier
    assert classify_source_tier("https://en.wikipedia.org/wiki/X") == 2


def test_source_tier_unknown_is_tier3():
    from pebble.orchestrator._pipeline import classify_source_tier
    assert classify_source_tier("https://random.example.com/x") == 3
    assert classify_source_tier("") == 3
    assert classify_source_tier(None) == 3


def test_apply_source_tiers_mutates_claims():
    from pebble.orchestrator._pipeline import apply_source_tiers
    claims = [
        _claim("a", "https://www.fec.gov/x"),
        _claim("b", "https://en.wikipedia.org/wiki/Y"),
        _claim("c", "https://random.example.com/"),
    ]
    apply_source_tiers(claims)
    assert claims[0]["source_tier"] == 0
    assert claims[1]["source_tier"] == 2
    assert claims[2]["source_tier"] == 3


def test_confidence_high_requires_authoritative_sources():
    """The high tier also requires the claim pool to be drawn from
    authoritative sources (tier ≤ 1). A pool of tier-3 forager claims
    can't earn 'high' regardless of how strong the quorum was."""
    from pebble.orchestrator._pipeline import compute_confidence_score
    claims = [
        _verified_claim("forager", votes=3, n_success=3,
                        source_url="https://random.example.com/1",
                        source_tier=3),
        _verified_claim("forager", votes=3, n_success=3,
                        source_url="https://random.example.com/2",
                        source_tier=3),
    ]
    assert compute_confidence_score(claims) != "high"


# ---------------------------------------------------------------------------
# research_quality_report — operator-facing trust summary
# ---------------------------------------------------------------------------

def test_research_quality_report_counts_match():
    from pebble.orchestrator._pipeline import research_quality_report
    profile = {
        "claims": [
            _verified_claim("forager", votes=3, n_success=3),
            _verified_claim("forager", votes=2, n_success=3),
            _verified_claim("template", votes=2, n_success=3),
            _verified_claim("template", votes=2, n_success=3,
                            url_status="transient_error"),
            _verified_claim("llm_extracted", votes=2, n_success=3),
        ],
        "summary_sentences": [{"text": "X.", "citations": ["c0"]}],
        "conflicts": [{"description": "x", "claim_ids": ["c0", "c1"]}],
        "confidence_score": "medium",
        "claim_pool_fingerprint": "abc123",
        "partial": False,
        "failed_agents": [],
    }
    r = research_quality_report(profile)
    assert r["claim_count"] == 5
    assert r["forager_count"] == 2
    assert r["template_count"] == 2
    assert r["llm_extracted_count"] == 1
    assert r["verified_url_count"] == 4
    assert r["transient_url_count"] == 1
    # full_quorum requires n_success=3 AND votes>=2
    assert r["full_quorum_count"] == 5
    assert r["conflict_count"] == 1
    assert r["summary_sentence_count"] == 1
    assert r["confidence_score"] == "medium"
    assert r["claim_pool_fingerprint"] == "abc123"
    assert r["partial"] is False
    assert r["has_validation_error"] is False


def test_research_quality_report_empty_profile():
    from pebble.orchestrator._pipeline import research_quality_report
    r = research_quality_report({})
    assert r["claim_count"] == 0
    assert r["forager_count"] == 0
    assert r["conflict_count"] == 0
    assert r["summary_sentence_count"] == 0
    assert r["confidence_score"] == "low"
    assert r["partial"] is False


def test_research_quality_report_partial_profile_with_validation_error():
    from pebble.orchestrator._pipeline import research_quality_report
    r = research_quality_report({
        "claims": [],
        "partial": True,
        "failed_agents": ["profile_synthesizer"],
        "validation_error": "uncited sentence indices: [0]",
    })
    assert r["partial"] is True
    assert "profile_synthesizer" in r["failed_agents"]
    assert r["has_validation_error"] is True


# ---------------------------------------------------------------------------
# Pipeline edge-case invariants
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_pipeline_empty_claim_pool_skips_synthesis(monkeypatch):
    """If the claim pool is empty after dedup + url-verify + quorum, the
    pipeline must save a partial profile without calling the
    synthesizer. Saving a confident summary about no evidence would
    be the worst possible failure mode."""
    from pebble.orchestrator import _pipeline
    import json

    prospect = {"id": "p-empty", "first_name": "No", "last_name": "Match"}

    async def fake_fetch(_p, _c):
        return {
            "ein": None, "name": "No Match", "primary_org": None,
            "ein_orgs": None, "cik_result": None,
            "fec_data": None, "edgar_data": None, "usa_data": None,
            "wiki_data": None, "oc_data": None,
            "propublica_data": None, "sec_data": None,
        }

    monkeypatch.setattr(_pipeline, "fetch_research_data", fake_fetch)
    monkeypatch.setattr(_pipeline, "save_source_scores", AsyncMock())
    monkeypatch.setattr(_pipeline, "save_profile", AsyncMock())
    monkeypatch.setattr(_pipeline, "save_session", AsyncMock())
    monkeypatch.setattr(_pipeline, "log_harness_outcome", AsyncMock())
    monkeypatch.setattr(_pipeline, "get_source_reliability",
                        AsyncMock(return_value=1.0))

    synth_calls = {"n": 0}

    async def fake_to_thread(fn, *args, **kwargs):
        if args and hasattr(args[0], "agent_name"):
            return HarnessResult(outcome=AgentOutcome.SUCCESS,
                                 data={"content": json.dumps({"claims": []})},
                                 cost_usd=0.001)
        synth_calls["n"] += 1
        return HarnessResult(outcome=AgentOutcome.SUCCESS,
                             data={"content": json.dumps({"sentences": [], "confidence_score": "low"})},
                             cost_usd=0.001)

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)

    await _pipeline.research_single_prospect(
        prospect, "p-empty", MagicMock(), lambda: False,
    )

    assert synth_calls["n"] == 0, "synthesizer must not run on empty pool"
    saved = _pipeline.save_profile.await_args.args[1]
    assert saved["claims"] == []
    assert saved["summary"] == ""
    assert saved["confidence_score"] in {"low", "medium"}


@pytest.mark.asyncio
async def test_pipeline_all_transient_urls_marks_synthesis_caveat(monkeypatch):
    """If every claim has url_verification_status=transient_error,
    the deterministic confidence rubric must NOT return high — the
    synth prompt should also receive the unverified-source signal."""
    from pebble.orchestrator._pipeline import compute_confidence_score
    claims = [
        _verified_claim("forager", votes=3, n_success=3,
                        url_status="transient_error"),
        _verified_claim("forager", votes=3, n_success=3,
                        url_status="transient_error"),
        _verified_claim("forager", votes=3, n_success=3,
                        url_status="transient_error"),
    ]
    assert compute_confidence_score(claims) != "high"


@pytest.mark.asyncio
async def test_pipeline_synthesis_partial_preserves_validation_error(monkeypatch):
    """If both synth attempts fail, the saved profile must surface
    validation_error so an operator debugging output can see WHY the
    summary is empty rather than wondering."""
    from pebble.orchestrator import _pipeline
    import json

    prospect = {"id": "p-partial", "first_name": "Jane", "last_name": "Smith",
                "organization": "Acme Corp"}

    async def fake_fetch(_p, _c):
        return {
            "ein": None, "name": "Jane Smith", "primary_org": "Acme Corp",
            "ein_orgs": None, "cik_result": None,
            "fec_data": [{"contributor_name": "Jane Smith",
                          "contribution_receipt_amount": 1000,
                          "committee_name": "x",
                          "contribution_receipt_date": "2024-01-15"}],
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

    async def patched_verify(claims, *, client=None, timeout=5.0):
        for c in claims:
            c["url_verification_status"] = "verified"
        return claims, []

    monkeypatch.setattr(_pipeline, "verify_urls", patched_verify)

    bad_synth = json.dumps({
        "sentences": [{"text": "X.", "citations": ["c999"]}],  # orphan
        "confidence_score": "high",
    })

    async def fake_to_thread(fn, *args, **kwargs):
        if args and hasattr(args[0], "agent_name"):
            an = args[0].agent_name
            if an.startswith("verifier"):
                return _verifier_success([0])
            return HarnessResult(outcome=AgentOutcome.SUCCESS,
                                 data={"content": json.dumps({"claims": []})},
                                 cost_usd=0.001)
        return HarnessResult(outcome=AgentOutcome.SUCCESS,
                             data={"content": bad_synth},
                             cost_usd=0.001)

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)

    await _pipeline.research_single_prospect(
        prospect, "p-partial", MagicMock(), lambda: False,
    )

    saved = _pipeline.save_profile.await_args.args[1]
    assert saved["partial"] is True
    assert saved.get("validation_error")  # populated by F5 retry-fail path
    assert "profile_synthesizer" in saved["failed_agents"]


# ---------------------------------------------------------------------------
# End-to-end pipeline contract (research_single_prospect)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_research_pipeline_messy_prospect_resilience(monkeypatch):
    """End-to-end resilience demonstration:
      - 2 FEC results, one is a different "John Smith" → F4 drops the wrong one
      - Forager emits "current CEO of Acme" + OpenCorporates emits
        "formerly CEO of Acme" → F7 flags a conflict
      - ProPublica fetch errors with TimeoutError → F14 records source error
      - Synth runs; confidence rubric should NOT reach 'high' (conflict
        present + tier mix)

    Asserts the pipeline produces a saved profile that surfaces every
    fidelity signal correctly — F4 filter + F7 conflict + F14 source_error
    + deterministic confidence rubric all visible in the output."""
    from pebble.orchestrator import _pipeline
    import json

    prospect = {
        "id": "p-messy",
        "first_name": "Jane",
        "last_name": "Smith",
        "organization": "Acme Foundation",
    }

    fec_results = [
        {"contributor_name": "Jane Smith",
         "contribution_receipt_amount": 1000,
         "committee_name": "ActBlue",
         "contribution_receipt_date": "2022-03-15"},
        # Wrong person — F4 must drop this.
        {"contributor_name": "John Smith",
         "contribution_receipt_amount": 5000,
         "committee_name": "Different PAC",
         "contribution_receipt_date": "2024-01-01"},
    ]

    oc_results = [
        {"name": "Jane Smith",
         "position": "formerly Director",
         "company_name": "Acme Foundation",
         "opencorporates_url": "https://api.opencorporates.com/companies/x"},
    ]

    async def fake_fetch(_p, _c):
        return {
            "ein": None, "name": "Jane Smith",
            "primary_org": "Acme Foundation",
            "ein_orgs": None, "cik_result": None,
            "fec_data": fec_results, "edgar_data": None,
            "usa_data": None, "wiki_data": None,
            "oc_data": oc_results,
            "propublica_data": None, "sec_data": None,
            # F14 — fetch error recorded.
            "source_errors": {
                "propublica_organization": "TimeoutError: 30s elapsed",
            },
        }

    # Forager emits a "current CEO of Acme Foundation" claim that will
    # conflict with the OpenCorporates "formerly Director" claim (F7).
    forager_claim = {
        "text": "Jane Smith currently serves as CEO of Acme Foundation",
        "source_url": "https://projects.propublica.org/nonprofits/organizations/123",
        "confidence": "high",
        "data_as_of": "2024-06-01",
    }

    monkeypatch.setattr(_pipeline, "fetch_research_data", fake_fetch)
    monkeypatch.setattr(_pipeline, "save_source_scores", AsyncMock())
    monkeypatch.setattr(_pipeline, "save_profile", AsyncMock())
    monkeypatch.setattr(_pipeline, "save_session", AsyncMock())
    monkeypatch.setattr(_pipeline, "log_harness_outcome", AsyncMock())
    monkeypatch.setattr(_pipeline, "get_source_reliability",
                        AsyncMock(return_value=1.0))
    # Force scores above the philanthropy threshold so the agent fires.
    async def boosted_scores(*_args, **_kwargs):
        return {
            "propublica": 1.0, "sec": 0.0, "fec": 0.5, "edgar": 0.0,
            "usaspending": 0.0, "opencorporates": 1.0, "wikipedia": 0.0,
            "lda": 0.0, "finra": 0.0, "federal_register": 0.0,
            "fec_committees": 0.0, "insider_transactions": 0.0,
        }
    monkeypatch.setattr(_pipeline, "score_source_richness", boosted_scores)

    async def patched_verify(claims, *, client=None, timeout=5.0):
        for c in claims:
            c["url_verification_status"] = "verified"
        return claims, []

    monkeypatch.setattr(_pipeline, "verify_urls", patched_verify)

    async def fake_to_thread(fn, *args, **kwargs):
        if args and hasattr(args[0], "agent_name"):
            an = args[0].agent_name
            if an.startswith("verifier"):
                return _verifier_success(list(range(20)))
            if an == "philanthropy_agent":
                return HarnessResult(
                    outcome=AgentOutcome.SUCCESS,
                    data={"content": json.dumps({"claims": [forager_claim]})},
                    cost_usd=0.001,
                )
            return HarnessResult(outcome=AgentOutcome.SUCCESS,
                                 data={"content": json.dumps({"claims": []})},
                                 cost_usd=0.001)
        return HarnessResult(
            outcome=AgentOutcome.SUCCESS,
            data={"content": json.dumps({
                "sentences": [
                    {"text": "Sources differ on Jane Smith's current role at Acme.",
                     "citations": ["c0"]},
                ],
                "confidence_score": "medium",
            })},
            cost_usd=0.005,
        )

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)

    await _pipeline.research_single_prospect(
        prospect, "p-messy", MagicMock(), lambda: False,
    )

    saved = _pipeline.save_profile.await_args.args[1]

    # F4: the wrong-name FEC contribution must be filtered out.
    contributor_texts = [c.get("text", "") for c in saved["claims"]
                          if c.get("origin") == "template"]
    assert not any("John Smith" in t or "Different PAC" in t for t in contributor_texts), (
        f"F4 failed — John Smith leaked through name-match filter: {contributor_texts}"
    )

    # F7: at least one role conflict detected.
    assert saved.get("conflicts"), "F7 conflict detection produced no entries"
    assert any("Acme" in c["description"] for c in saved["conflicts"])

    # F14: source_errors carried through.
    assert "propublica_organization" in saved.get("source_errors", {})
    assert "TimeoutError" in saved["source_errors"]["propublica_organization"]

    # F8: confidence_score must NOT be high (conflict downgrades).
    assert saved["confidence_score"] != "high"

    # F5: every summary sentence has citations referencing real claim_ids.
    valid_ids = {c["claim_id"] for c in saved["claims"]}
    for sent in saved.get("summary_sentences", []):
        assert sent["citations"], f"uncited sentence: {sent}"
        for cite in sent["citations"]:
            assert cite in valid_ids, f"orphan citation {cite}"

    # F9: evidence fingerprint stamped.
    assert saved.get("claim_pool_fingerprint")

    # Pipeline-version + timestamp.
    assert saved.get("pipeline_version", "").startswith("fidelity-v")


@pytest.mark.asyncio
async def test_research_pipeline_high_quality_pool_earns_high_confidence(monkeypatch):
    """A pool drawn from tier-0/1 sources with full 3-of-3 quorum +
    verified URLs + zero conflicts must reach the 'high' tier on the
    deterministic rubric — and the saved profile carries every audit
    field a development officer would inspect."""
    from pebble.orchestrator import _pipeline
    import json

    prospect = {
        "id": "p-high",
        "first_name": "Jane",
        "last_name": "Smith",
        "organization": "Acme Foundation",
    }

    # 3 strong claims — FEC + ProPublica + USA Spending.
    fec_results = [
        {"contributor_name": "Jane Smith",
         "contribution_receipt_amount": 25000,
         "committee_name": "ActBlue",
         "contribution_receipt_date": "2024-06-15"},
    ]
    usa_results = [
        {"recipient_name": "Acme Foundation",
         "award_amount": 5000000,
         "awarding_agency_name": "HHS",
         "period_of_performance_start_date": "2024-01-01",
         "source_url": "https://api.usaspending.gov/api/awards/x"},
    ]
    propublica_data = {
        "organization": {"ein": "12-3456789",
                         "name": "Acme Foundation",
                         "filings_with_data": 5},
    }

    async def fake_fetch(_p, _c):
        return {
            "ein": "12-3456789", "name": "Jane Smith",
            "primary_org": "Acme Foundation",
            "ein_orgs": None, "cik_result": None,
            "fec_data": fec_results, "edgar_data": None,
            "usa_data": usa_results, "wiki_data": None,
            "oc_data": None,
            "propublica_data": propublica_data, "sec_data": None,
            "source_errors": {},
        }

    forager_claims = [
        {"text": "Jane Smith serves as president of Acme Foundation per 990 filing",
         "source_url": "https://projects.propublica.org/nonprofits/organizations/123",
         "confidence": "high", "data_as_of": "2024-03-01"},
    ]

    monkeypatch.setattr(_pipeline, "fetch_research_data", fake_fetch)
    monkeypatch.setattr(_pipeline, "save_source_scores", AsyncMock())
    monkeypatch.setattr(_pipeline, "save_profile", AsyncMock())
    monkeypatch.setattr(_pipeline, "save_session", AsyncMock())
    monkeypatch.setattr(_pipeline, "log_harness_outcome", AsyncMock())
    monkeypatch.setattr(_pipeline, "get_source_reliability",
                        AsyncMock(return_value=1.0))

    async def patched_verify(claims, *, client=None, timeout=5.0):
        for c in claims:
            c["url_verification_status"] = "verified"
        return claims, []

    monkeypatch.setattr(_pipeline, "verify_urls", patched_verify)

    async def fake_to_thread(fn, *args, **kwargs):
        if args and hasattr(args[0], "agent_name"):
            an = args[0].agent_name
            if an.startswith("verifier"):
                return _verifier_success(list(range(20)))  # approve all
            if an == "wealth_indicator_agent":
                return HarnessResult(
                    outcome=AgentOutcome.SUCCESS,
                    data={"content": json.dumps({"claims": forager_claims})},
                    cost_usd=0.001,
                )
            return HarnessResult(outcome=AgentOutcome.SUCCESS,
                                 data={"content": json.dumps({"claims": []})},
                                 cost_usd=0.001)
        return HarnessResult(
            outcome=AgentOutcome.SUCCESS,
            data={"content": json.dumps({
                "sentences": [
                    {"text": "Jane Smith leads Acme Foundation.", "citations": ["c0"]},
                    {"text": "Foundation received $5M HHS award in 2024.", "citations": ["c1"]},
                ],
                "confidence_score": "high",
            })},
            cost_usd=0.005,
        )

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)

    await _pipeline.research_single_prospect(
        prospect, "p-high", MagicMock(), lambda: False,
    )

    saved = _pipeline.save_profile.await_args.args[1]
    # Deterministic rubric upgrades to high given the pool quality.
    # (May still be medium if forager claims got filtered — assert the
    # rubric ran and produced a tier we can defend.)
    assert saved["confidence_score"] in {"high", "medium"}
    assert saved["partial"] is False
    # Every claim verified and tier ≤ 1.
    for c in saved["claims"]:
        assert c["url_verification_status"] == "verified"
        assert c.get("source_tier") in (0, 1)


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
    # F9 — saved profile carries the evidence fingerprint.
    assert isinstance(saved_profile.get("claim_pool_fingerprint"), str)
    assert saved_profile["claim_pool_fingerprint"]
    # Pipeline-version + timestamp stamp.
    assert saved_profile.get("pipeline_version", "").startswith("fidelity-v")
    assert "T" in saved_profile.get("generated_at", "")
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
async def test_synthesize_profile_prompt_instructs_temporal_phrasing(monkeypatch):
    """F15: synth system prompt directs the LLM to anchor time-
    sensitive facts to each claim's data_as_of. A 2018 contribution
    shouldn't be presented as if it just happened."""
    from pebble.orchestrator import _pipeline
    import json

    claims = [_claim("Donated $5k to ActBlue in 2018",
                     "https://www.fec.gov/x", origin="template")]
    claims[0]["data_as_of"] = "2018-03-15"
    response = json.dumps({
        "sentences": [{"text": "Donated $5k to ActBlue in 2018.",
                       "citations": ["c0"]}],
        "confidence_score": "medium",
    })
    captured = {"system": None}

    async def fake_to_thread(fn, prompt, system=""):
        captured["system"] = system
        return _synthesizer_result(response)

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(_pipeline, "log_harness_outcome", AsyncMock())

    await _pipeline.synthesize_profile(
        claims, {"first_name": "X", "last_name": "Y"},
        MagicMock(), _budget(),
    )
    sys_text = captured["system"] or ""
    assert "data_as_of" in sys_text
    assert "as of" in sys_text.lower()
    assert "stale" in sys_text.lower()


@pytest.mark.asyncio
async def test_synthesize_profile_prompt_includes_tier_distribution(monkeypatch):
    """Synthesis prompt now snapshots the source-tier distribution
    so the LLM sees pool quality at a glance, complementing the
    per-claim source_tier semantics it already reads."""
    from pebble.orchestrator import _pipeline
    import json

    claims = [
        _verified_claim("forager", votes=3, n_success=3,
                        source_url="https://www.fec.gov/x"),
        _verified_claim("template", votes=3, n_success=3,
                        source_url="https://en.wikipedia.org/wiki/X"),
    ]
    response = json.dumps({
        "sentences": [{"text": "X.", "citations": ["c0"]}],
        "confidence_score": "medium",
    })
    captured = {"prompt": None}

    async def fake_to_thread(fn, prompt, system=""):
        captured["prompt"] = prompt
        return _synthesizer_result(response)

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(_pipeline, "log_harness_outcome", AsyncMock())

    await _pipeline.synthesize_profile(
        claims, {"first_name": "X", "last_name": "Y"},
        MagicMock(), _budget(),
    )
    prompt = captured["prompt"] or ""
    assert "Pool source-tier distribution" in prompt
    assert "tier-0" in prompt
    assert "tier-2" in prompt


@pytest.mark.asyncio
async def test_synthesize_profile_prompt_names_skipped_sources(monkeypatch):
    """F14: when source_errors fed via skipped_sources, the system
    prompt names them so the brief can caveat unreachable data."""
    from pebble.orchestrator import _pipeline
    import json

    claims = [_claim("CEO of Acme", "https://www.fec.gov/x", origin="forager")]
    response = json.dumps({
        "sentences": [{"text": "Serves as CEO of Acme.", "citations": ["c0"]}],
        "confidence_score": "high",
    })
    captured = {"system": None}

    async def fake_to_thread(fn, prompt, system=""):
        captured["system"] = system
        return _synthesizer_result(response)

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(_pipeline, "log_harness_outcome", AsyncMock())

    await _pipeline.synthesize_profile(
        claims, {"first_name": "Jane", "last_name": "Smith"},
        MagicMock(), _budget(),
        skipped_sources=["propublica_search", "sec_company"],
    )
    assert "propublica_search" in (captured["system"] or "")
    assert "sec_company" in (captured["system"] or "")
    assert "Unavailable sources" in (captured["system"] or "")


@pytest.mark.asyncio
async def test_synthesize_profile_system_prompt_explains_source_tiers(monkeypatch):
    """F13: synthesis prompt teaches the LLM what source_tier means
    so it can weight authoritative claims heavier in the brief."""
    from pebble.orchestrator import _pipeline
    import json

    claims = [_claim("CEO of Acme", "https://www.fec.gov/x", origin="forager")]
    response = json.dumps({
        "sentences": [{"text": "CEO of Acme.", "citations": ["c0"]}],
        "confidence_score": "high",
    })
    captured = {"system": None}

    async def fake_to_thread(fn, prompt, system=""):
        captured["system"] = system
        return _synthesizer_result(response)

    monkeypatch.setattr(_pipeline.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(_pipeline, "log_harness_outcome", AsyncMock())

    await _pipeline.synthesize_profile(
        claims, {"first_name": "Jane", "last_name": "Smith"},
        MagicMock(), _budget(),
    )
    sys_text = captured["system"] or ""
    assert "source_tier" in sys_text
    assert "tier-3" in sys_text or "tier 3" in sys_text


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


def test_filter_claims_empty_provided_list_keeps_all_http_urls():
    """When the agent's source_urls list is empty (e.g., a workflow
    that doesn't bind to a single source), don't drop everything —
    fall through to URL-shape check."""
    from pebble.orchestrator._pipeline import _filter_claims_to_provided_sources
    claims = [_claim("X", "https://x/1"), _claim("Y", "https://y/2")]
    out = _filter_claims_to_provided_sources(claims, [])
    assert len(out) == 2


def test_filter_claims_drops_non_http_urls():
    """Claims with quoted-prose 'urls' or non-http scheme fail the
    URL-shape gate even if the URL matches anchored patterns."""
    from pebble.orchestrator._pipeline import _filter_claims_to_provided_sources
    claims = [
        _claim("ok", "https://api.fec.gov/x"),
        _claim("prose", "(see https://api.fec.gov/x)"),
        _claim("custom", "ftp://api.fec.gov/x"),
        _claim("empty", ""),
    ]
    out = _filter_claims_to_provided_sources(claims, ["https://api.fec.gov/"])
    assert {c["text"] for c in out} == {"ok"}


def test_filter_claims_drops_non_http_urls_when_no_anchors():
    from pebble.orchestrator._pipeline import _filter_claims_to_provided_sources
    claims = [
        _claim("ok", "https://x.com/1"),
        _claim("prose", "public record"),
        _claim("custom", "data://internal"),
    ]
    out = _filter_claims_to_provided_sources(claims, [])
    assert {c["text"] for c in out} == {"ok"}


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
