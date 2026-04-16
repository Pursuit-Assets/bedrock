"""Stage bucket parity + invariants.

Cross-checks the Python string-valued bucket sets in models.py against
hard-coded mirrors of the frontend sets in
frontend/src/types/salesforce.ts. If either side changes without the
other, the parity tests fail.

See tasks/f1-stage-buckets-plan.md + tasks/stage-schema-drift.md.
"""

import sys
import os

# Add parent to path so we can import from financial_forecasting
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from models import (
    OpportunityStage,
    OPEN_STAGES,
    CLOSED_STAGES,
    WON_STAGES_SET,
    LOST_STAGES_SET,
    COLLECTING_STAGES_SET,
    PAYMENT_RECEIVED_STAGES_SET,
)


# ---------------------------------------------------------------------------
# Frontend-mirror constants (verbatim from frontend/src/types/salesforce.ts).
# Update these together; the parity tests below asserts equality.
# ---------------------------------------------------------------------------
FRONTEND_WON_STAGES: frozenset[str] = frozenset({
    "Collecting / In Effect",
    "Closed / Completed",
    "Closed Won",
})

FRONTEND_LOST_STAGES: frozenset[str] = frozenset({
    "Closed Lost",
    "Withdrawn",
    "Closed / Did not Fulfill",
})

FRONTEND_COLLECTING_STAGES: frozenset[str] = frozenset({
    "Collecting / In Effect",
})

FRONTEND_PAYMENT_RECEIVED_STAGES: frozenset[str] = frozenset({
    "Closed / Completed",
    "Closed Won",
})


# ---------------------------------------------------------------------------
# Cross-language parity — frontend and backend must agree on membership.
# ---------------------------------------------------------------------------
class TestFrontendBackendParity:
    def test_won_stages_match_frontend(self):
        assert WON_STAGES_SET == FRONTEND_WON_STAGES

    def test_lost_stages_match_frontend(self):
        assert LOST_STAGES_SET == FRONTEND_LOST_STAGES

    def test_collecting_stages_match_frontend(self):
        assert COLLECTING_STAGES_SET == FRONTEND_COLLECTING_STAGES

    def test_payment_received_stages_match_frontend(self):
        assert PAYMENT_RECEIVED_STAGES_SET == FRONTEND_PAYMENT_RECEIVED_STAGES


# ---------------------------------------------------------------------------
# Membership — each canonical stage is in the sets we expect.
# ---------------------------------------------------------------------------
class TestBucketMemberships:
    def test_won_stages_contents(self):
        assert "Collecting / In Effect" in WON_STAGES_SET
        assert "Closed / Completed" in WON_STAGES_SET
        assert "Closed Won" in WON_STAGES_SET
        assert "Closed Lost" not in WON_STAGES_SET
        assert "Withdrawn" not in WON_STAGES_SET
        assert "Qualifying" not in WON_STAGES_SET
        assert len(WON_STAGES_SET) == 3

    def test_lost_stages_contents(self):
        assert "Closed Lost" in LOST_STAGES_SET
        assert "Withdrawn" in LOST_STAGES_SET
        assert "Closed / Did not Fulfill" in LOST_STAGES_SET
        assert "Closed / Completed" not in LOST_STAGES_SET
        assert "Closed Won" not in LOST_STAGES_SET
        assert "Qualifying" not in LOST_STAGES_SET
        assert len(LOST_STAGES_SET) == 3

    def test_collecting_stages_contents(self):
        assert "Collecting / In Effect" in COLLECTING_STAGES_SET
        assert "Closed / Completed" not in COLLECTING_STAGES_SET
        assert "Closed Won" not in COLLECTING_STAGES_SET
        assert len(COLLECTING_STAGES_SET) == 1

    def test_payment_received_stages_contents(self):
        assert "Closed / Completed" in PAYMENT_RECEIVED_STAGES_SET
        assert "Closed Won" in PAYMENT_RECEIVED_STAGES_SET
        assert "Collecting / In Effect" not in PAYMENT_RECEIVED_STAGES_SET
        assert "Closed Lost" not in PAYMENT_RECEIVED_STAGES_SET
        assert len(PAYMENT_RECEIVED_STAGES_SET) == 2


# ---------------------------------------------------------------------------
# Invariants — set-algebra relationships the rest of the app depends on.
# ---------------------------------------------------------------------------
class TestBucketInvariants:
    def test_payment_received_subset_of_won(self):
        assert PAYMENT_RECEIVED_STAGES_SET <= WON_STAGES_SET

    def test_collecting_subset_of_won(self):
        assert COLLECTING_STAGES_SET <= WON_STAGES_SET

    def test_payment_received_disjoint_from_collecting(self):
        assert PAYMENT_RECEIVED_STAGES_SET.isdisjoint(COLLECTING_STAGES_SET)

    def test_won_disjoint_from_lost(self):
        assert WON_STAGES_SET.isdisjoint(LOST_STAGES_SET)

    def test_won_disjoint_from_open(self):
        open_values = {s.value for s in OPEN_STAGES}
        assert WON_STAGES_SET.isdisjoint(open_values)

    def test_lost_disjoint_from_open(self):
        open_values = {s.value for s in OPEN_STAGES}
        assert LOST_STAGES_SET.isdisjoint(open_values)


# ---------------------------------------------------------------------------
# Enum/bucket-string coverage — any stage string used in the sets that IS in
# the 13-stage enum must resolve back to the same string.
# ---------------------------------------------------------------------------
class TestEnumStringRoundtrip:
    def test_won_stage_strings_resolve_back(self):
        # Collecting / In Effect and Closed / Completed are enum members
        assert OpportunityStage("Collecting / In Effect") is OpportunityStage.COLLECTING
        assert OpportunityStage("Closed / Completed") is OpportunityStage.CLOSED_COMPLETED

    def test_closed_won_is_outside_enum(self):
        # Document the deliberate gap: "Closed Won" is NOT in the enum.
        # If a future commit adds it, this test breaks — treat that as a
        # signal to audit WON_STAGES_SET / frontend WON_STAGES and decide
        # whether the enum widening is actually wanted.
        import pytest
        with pytest.raises(ValueError):
            OpportunityStage("Closed Won")
