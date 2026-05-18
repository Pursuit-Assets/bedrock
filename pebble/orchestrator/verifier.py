"""Per-claim Doer/Verifier loop. Plan §4.3.

Wave 1 of the L2 swarm. Wraps the existing template-emitted claims (FEC,
ProPublica, OpenCorporates, foragers) in a Haiku check before they reach
the run-level 2-of-3 quorum. The run-level quorum is preserved as the
second line of defense.

Two entry points:

    verify_claim_once(claim, *, client, ...) -> ClaimVerdict
        One verifier call. Used for template-emitted claims (FEC rows,
        990 officer rows) where there is no Doer to "redo" — the claim
        comes from a deterministic data source. Approve/reject; admit
        as low-confidence on parse failure (FAIL-CLOSED per §4.11).

    verify_claim_loop(claim, doer_redo, *, client, max_loops, ...) -> ClaimVerdict
        Up to max_loops iterations of {Doer-emit → Verifier-check}.
        Used for LLM-emitted forager claims (wealth_indicator_agent,
        philanthropy_agent) where a redo hint can actually re-prompt
        the Doer. Admits as low-confidence on parse failure or redo
        exhaustion; rejects on explicit verifier reject.

Both entry points are sync wrappers around the existing WorkerHarness
(which is synchronous + bounded by a per-task timeout). The orchestrator
calls them from asyncio.to_thread per the existing pattern in
_pipeline.py:437 _run_verifier.

Wiring decisions documented inline; the rest of the contract lives in
the plan at ~/.claude/plans/glistening-crafting-matsumoto.md §4.3 + §4.11.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Awaitable, Callable, Literal, Optional

from ..harness import (
    AgentOutcome,
    TaskSpec,
    WorkerHarness,
    harness_config_for_agent,
)
from ..model_client import ModelClient
from .guardrails import wrap_retrieved

logger = logging.getLogger("pebble.orchestrator.verifier")


# ---------------------------------------------------------------------------
# Verdict shape
# ---------------------------------------------------------------------------

Outcome = Literal["approve", "reject", "redo", "admit_low_confidence"]


@dataclass
class ClaimVerdict:
    """The verifier's decision about one claim.

    Attributes:
        outcome: Final decision. The orchestrator uses this to decide
            whether to keep, drop, or admit-as-low-confidence the claim.
        claim: The (possibly mutated) claim dict — verifier may stamp
            ``verifier_note`` and ``confidence`` fields on it.
        reason: Verifier's stated reason. Surfaced to the cockpit.
        attempts: How many Doer→Verifier loops actually ran.
        cost_usd: Total cost incurred by this verdict.
        loop_costs_usd: Per-attempt cost list for ledger forensics.
    """
    outcome: Outcome
    claim: dict
    reason: str = ""
    attempts: int = 1
    cost_usd: float = 0.0
    loop_costs_usd: list[float] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.loop_costs_usd is None:
            self.loop_costs_usd = []


# ---------------------------------------------------------------------------
# Output parsing — fail-CLOSED on JSON garbage
# ---------------------------------------------------------------------------

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE | re.MULTILINE)


def _strip_fences(text: str) -> str:
    return _FENCE_RE.sub("", text).strip()


def _parse_verifier_output(content: str) -> dict | None:
    """Parse the verifier's JSON response. Returns None on parse failure.

    Returning None is the FAIL-CLOSED signal: the caller treats parse
    failure as "verifier broken, admit at low confidence" rather than
    "verifier approved" (the old fail-open bug — see §4.11).
    """
    if not content:
        return None
    try:
        raw = _strip_fences(content)
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


def _coerce_outcome(parsed: dict) -> Optional[Outcome]:
    """Normalize the model's outcome string to our literal set."""
    raw = str(parsed.get("outcome", "")).strip().lower()
    if raw in ("approve", "approved", "accept", "ok"):
        return "approve"
    if raw in ("reject", "rejected", "deny", "refuse", "false"):
        return "reject"
    if raw in ("redo", "retry", "revise", "rework"):
        return "redo"
    return None


# ---------------------------------------------------------------------------
# Raw verifier call shared between one-shot and loop paths
# ---------------------------------------------------------------------------

@dataclass
class _RawVerdict:
    """The verifier's raw output, without the no-doer collapse.

    Differs from ClaimVerdict in two ways:
      * outcome includes ``redo`` (not collapsed to admit_low_confidence)
      * confidence_hint is preserved separately so the caller can
        choose whether to apply it
    """
    outcome: Literal["approve", "reject", "redo", "parse_failed", "unavailable", "unknown_outcome"]
    reason: str
    confidence_hint: Optional[str]
    cost_usd: float


def _call_verifier_once(
    claim: dict,
    *,
    client: ModelClient,
    source_excerpt: str,
    source_origin: str,
    agent_name: str,
    redo_hint: Optional[str] = None,
) -> _RawVerdict:
    """Make one verifier call. Returns the raw verdict.

    This is the only place that actually invokes the harness. Both
    verify_claim_once and verify_claim_loop share it; the difference is
    how they interpret a ``redo`` outcome.
    """
    claim_text = claim.get("text", "")
    source_url = claim.get("source_url", "")
    wrapped_excerpt = wrap_retrieved(source_excerpt, source_origin) if source_excerpt else ""

    spec = TaskSpec(
        agent_name=agent_name,
        data={
            "claim_text": claim_text,
            "source_url": source_url,
            "source_excerpt": wrapped_excerpt,
            "redo_hint": redo_hint or "",
        },
    )
    harness = WorkerHarness(agent_name, harness_config_for_agent(agent_name), client)
    result = harness.execute_task(spec)

    cost = float(result.cost_usd or 0.0)

    if result.outcome not in (AgentOutcome.SUCCESS, AgentOutcome.ESCALATED):
        return _RawVerdict(
            outcome="unavailable",
            reason=f"verifier_unavailable:{result.outcome.value}",
            confidence_hint=None,
            cost_usd=cost,
        )

    parsed = _parse_verifier_output(result.data.get("content", "") if result.data else "")
    if parsed is None:
        return _RawVerdict(
            outcome="parse_failed",
            reason="verifier_parse_failed",
            confidence_hint=None,
            cost_usd=cost,
        )

    coerced = _coerce_outcome(parsed)
    reason = str(parsed.get("reason", ""))[:280]
    confidence_hint = parsed.get("confidence_hint")
    if confidence_hint not in ("high", "medium", "low"):
        confidence_hint = None

    if coerced is None:
        return _RawVerdict(
            outcome="unknown_outcome",
            reason=f"verifier_unknown_outcome:{parsed.get('outcome', '')!r}",
            confidence_hint=None,
            cost_usd=cost,
        )

    return _RawVerdict(
        outcome=coerced,
        reason=reason,
        confidence_hint=confidence_hint,
        cost_usd=cost,
    )


# ---------------------------------------------------------------------------
# One-shot verifier call (template-emitted claims)
# ---------------------------------------------------------------------------

def verify_claim_once(
    claim: dict,
    *,
    client: ModelClient,
    source_excerpt: str = "",
    source_origin: str = "unknown",
    agent_name: str = "claim_verifier_singleclaim",
) -> ClaimVerdict:
    """Single Haiku check on one claim. No redo loop.

    Used for template-emitted claims (FEC contributions, 990 officer
    rows, OpenCorporates records) where the source is deterministic and
    there is no Doer to re-prompt. The verifier either approves, rejects,
    or asks for a redo (which we treat as ``admit_low_confidence`` here
    since there is no Doer to redo).

    The function is synchronous because WorkerHarness.execute_task is
    synchronous. The pipeline runs it via asyncio.to_thread.
    """
    raw = _call_verifier_once(
        claim,
        client=client,
        source_excerpt=source_excerpt,
        source_origin=source_origin,
        agent_name=agent_name,
    )

    if raw.outcome == "unavailable":
        admitted = dict(claim)
        admitted["confidence"] = "low"
        admitted["verifier_note"] = raw.reason
        logger.warning("verify_claim_once: %s for agent %s", raw.reason, agent_name)
        return ClaimVerdict(
            outcome="admit_low_confidence",
            claim=admitted,
            reason=raw.reason,
            attempts=1,
            cost_usd=raw.cost_usd,
            loop_costs_usd=[raw.cost_usd],
        )

    if raw.outcome == "parse_failed":
        # FAIL-CLOSED per §4.11: admit at low confidence rather than
        # auto-approve. An adversary who breaks the verifier's JSON
        # output (via poisoned 990 free-text bleeding into the Haiku
        # context) does not get to either auto-approve OR auto-drop —
        # admitting at low confidence with an explicit verifier_note
        # marker lets synthesis treat the claim cautiously without
        # handing them the keys.
        admitted = dict(claim)
        admitted["confidence"] = "low"
        admitted["verifier_note"] = "verifier_parse_failed"
        logger.warning(
            "verify_claim_once: verifier %s returned unparseable output — admitting at low confidence",
            agent_name,
        )
        return ClaimVerdict(
            outcome="admit_low_confidence",
            claim=admitted,
            reason="verifier_parse_failed",
            attempts=1,
            cost_usd=raw.cost_usd,
            loop_costs_usd=[raw.cost_usd],
        )

    if raw.outcome == "unknown_outcome":
        admitted = dict(claim)
        admitted["confidence"] = "low"
        admitted["verifier_note"] = "verifier_unknown_outcome"
        logger.warning(
            "verify_claim_once: verifier %s returned unknown outcome — admitting at low confidence",
            agent_name,
        )
        return ClaimVerdict(
            outcome="admit_low_confidence",
            claim=admitted,
            reason=raw.reason,
            attempts=1,
            cost_usd=raw.cost_usd,
            loop_costs_usd=[raw.cost_usd],
        )

    if raw.outcome == "approve":
        admitted = dict(claim)
        if raw.confidence_hint and not admitted.get("confidence"):
            admitted["confidence"] = raw.confidence_hint
        admitted["pre_verified"] = True
        return ClaimVerdict(
            outcome="approve",
            claim=admitted,
            reason=raw.reason,
            attempts=1,
            cost_usd=raw.cost_usd,
            loop_costs_usd=[raw.cost_usd],
        )

    if raw.outcome == "reject":
        return ClaimVerdict(
            outcome="reject",
            claim=claim,
            reason=raw.reason or "verifier_reject",
            attempts=1,
            cost_usd=raw.cost_usd,
            loop_costs_usd=[raw.cost_usd],
        )

    # raw.outcome == "redo" — no Doer in the one-shot path, so collapse
    # to admit at low confidence with a marker so the cockpit can show
    # "verifier wanted tighter source".
    admitted = dict(claim)
    admitted["confidence"] = "low"
    admitted["verifier_note"] = f"verifier_redo_no_doer:{raw.reason}"
    return ClaimVerdict(
        outcome="admit_low_confidence",
        claim=admitted,
        reason=raw.reason or "verifier_redo",
        attempts=1,
        cost_usd=raw.cost_usd,
        loop_costs_usd=[raw.cost_usd],
    )


# ---------------------------------------------------------------------------
# Multi-loop verifier (Doer re-emits with hint)
# ---------------------------------------------------------------------------

DoerCallable = Callable[[Optional[str]], Awaitable[Optional[dict]]]
"""A Doer factory: takes an optional redo_hint and returns a fresh Claim
dict (or None if the Doer gives up). The pipeline supplies a closure
that captures the Doer's task spec + the current scratchpad so this
module stays decoupled from cluster internals."""


async def verify_claim_loop(
    initial_claim: dict,
    doer_redo: Optional[DoerCallable] = None,
    *,
    client: ModelClient,
    max_loops: int,
    source_excerpt: str = "",
    source_origin: str = "unknown",
    agent_name: str = "claim_verifier_singleclaim",
) -> ClaimVerdict:
    """Per-claim Doer→Verifier loop with bounded redos. Plan §4.3.

    Args:
        initial_claim: The Doer's first claim emission.
        doer_redo: Async callable that re-emits the claim with a hint.
            Pass None to behave identically to verify_claim_once (no
            redo capability) — but use verify_claim_once directly in
            that case; this loop adds wall-time + book-keeping overhead.
        client: Shared ModelClient instance.
        max_loops: Upper bound on Doer→Verifier iterations. Comes from
            TierBudget (plan §4.5): T1=0, T2=1, T3=2, T4=2.
        source_excerpt / source_origin: Forwarded to the verifier so it
            can ground its decision in the actual retrieved text.
        agent_name: Verifier template name (default singleclaim).

    Returns:
        ClaimVerdict.
    """
    if max_loops < 0:
        max_loops = 0

    import asyncio  # local import keeps top-level imports terse

    current_claim = initial_claim
    total_cost = 0.0
    per_loop_costs: list[float] = []
    last_reason = ""
    last_redo_reason = ""
    redo_hint: Optional[str] = None

    # Iteration count = 1 initial attempt + up to max_loops redos.
    for attempt in range(max_loops + 1):
        raw = await asyncio.to_thread(
            _call_verifier_once,
            current_claim,
            client=client,
            source_excerpt=source_excerpt,
            source_origin=source_origin,
            agent_name=agent_name,
            redo_hint=redo_hint,
        )
        total_cost += raw.cost_usd
        per_loop_costs.append(raw.cost_usd)
        last_reason = raw.reason

        if raw.outcome == "approve":
            admitted = dict(current_claim)
            if raw.confidence_hint and not admitted.get("confidence"):
                admitted["confidence"] = raw.confidence_hint
            admitted["pre_verified"] = True
            return ClaimVerdict(
                outcome="approve",
                claim=admitted,
                reason=raw.reason,
                attempts=attempt + 1,
                cost_usd=total_cost,
                loop_costs_usd=per_loop_costs,
            )

        if raw.outcome == "reject":
            return ClaimVerdict(
                outcome="reject",
                claim=current_claim,
                reason=raw.reason or "verifier_reject",
                attempts=attempt + 1,
                cost_usd=total_cost,
                loop_costs_usd=per_loop_costs,
            )

        # Non-terminal outcomes:
        #   parse_failed / unavailable / unknown_outcome — STOP the loop
        #     immediately; an adversary who can break the verifier's
        #     output must not be able to drag us through paid retries.
        #   redo — redo is the only outcome that asks the Doer to retry.
        if raw.outcome in ("parse_failed", "unavailable", "unknown_outcome"):
            admitted = dict(current_claim)
            admitted["confidence"] = "low"
            if raw.outcome == "parse_failed":
                admitted["verifier_note"] = "verifier_parse_failed"
            elif raw.outcome == "unavailable":
                admitted["verifier_note"] = raw.reason  # "verifier_unavailable:<x>"
            else:
                admitted["verifier_note"] = "verifier_unknown_outcome"
            return ClaimVerdict(
                outcome="admit_low_confidence",
                claim=admitted,
                reason=raw.reason,
                attempts=attempt + 1,
                cost_usd=total_cost,
                loop_costs_usd=per_loop_costs,
            )

        # raw.outcome == "redo"
        last_redo_reason = raw.reason
        if doer_redo is None or attempt >= max_loops:
            # Exhausted redo budget (or no Doer to redo against): admit
            # at low confidence with the appropriate marker.
            admitted = dict(current_claim)
            admitted["confidence"] = "low"
            if doer_redo is None:
                admitted["verifier_note"] = f"verifier_redo_no_doer:{raw.reason}"
            else:
                admitted["verifier_note"] = f"redo_exhausted:{raw.reason}"
            return ClaimVerdict(
                outcome="admit_low_confidence",
                claim=admitted,
                reason=admitted["verifier_note"],
                attempts=attempt + 1,
                cost_usd=total_cost,
                loop_costs_usd=per_loop_costs,
            )

        # Real redo path: re-prompt the Doer with the verifier's hint.
        new_claim = await doer_redo(raw.reason)
        if new_claim is None:
            admitted = dict(current_claim)
            admitted["confidence"] = "low"
            admitted["verifier_note"] = f"doer_gave_up:{raw.reason}"
            return ClaimVerdict(
                outcome="admit_low_confidence",
                claim=admitted,
                reason=f"doer_gave_up:{raw.reason}",
                attempts=attempt + 1,
                cost_usd=total_cost,
                loop_costs_usd=per_loop_costs,
            )
        current_claim = new_claim
        redo_hint = raw.reason

    # Defensive fall-through (should be unreachable — the loop always
    # returns inside its body). Keep a sane verdict so a future refactor
    # that breaks the invariant doesn't silently drop claims.
    admitted = dict(current_claim)
    admitted["confidence"] = "low"
    admitted["verifier_note"] = f"loop_fallthrough:{last_redo_reason or last_reason}"
    return ClaimVerdict(
        outcome="admit_low_confidence",
        claim=admitted,
        reason=admitted["verifier_note"],
        attempts=max_loops + 1,
        cost_usd=total_cost,
        loop_costs_usd=per_loop_costs,
    )
