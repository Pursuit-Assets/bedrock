"""Tests for Pydantic models and their validators.

Verifies data contracts, validation rules, and enum consistency
between frontend and backend.
"""

import sys
import os
from datetime import date, datetime
from decimal import Decimal

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from models import (
    OpportunityStage,
    PaymentTerms,
    SalesforceOpportunity,
    SalesforceAccount,
    SalesforceContact,
    IntacctInvoice,
    IntacctPayment,
    PaymentForecast,
    CashFlowProjection,
    ForecastingMetrics,
    ApiResponse,
    OPEN_STAGES,
    CLOSED_STAGES,
    COLLECTING_STAGES,
)


# ---------------------------------------------------------------------------
# OpportunityStage enum — must match Salesforce picklist
# ---------------------------------------------------------------------------
class TestOpportunityStage:
    def test_all_stages_present(self):
        """Every stage in the Salesforce picklist has an enum member."""
        expected = {
            "--None--", "Lead Gen", "New Lead", "Qualifying",
            "Ask in Progress", "Proposal Submitted",
            "Contract Creation", "Contracting",
            "Collecting / In Effect", "Closed / Did not Fulfill",
            "Closed / Completed", "Closed Lost", "Withdrawn",
        }
        actual = {s.value for s in OpportunityStage}
        assert actual == expected

    def test_stage_groups_are_disjoint(self):
        """OPEN, COLLECTING, and CLOSED stages don't overlap."""
        assert OPEN_STAGES & CLOSED_STAGES == frozenset()
        assert OPEN_STAGES & COLLECTING_STAGES == frozenset()
        assert CLOSED_STAGES & COLLECTING_STAGES == frozenset()

    def test_stage_groups_cover_all_except_none(self):
        """All stages except --None-- belong to exactly one group."""
        all_grouped = OPEN_STAGES | COLLECTING_STAGES | CLOSED_STAGES
        all_stages = set(OpportunityStage) - {OpportunityStage.NONE}
        assert all_grouped == all_stages


# ---------------------------------------------------------------------------
# SalesforceOpportunity — validators
# ---------------------------------------------------------------------------
class TestSalesforceOpportunity:
    def test_valid_opportunity(self):
        opp = SalesforceOpportunity(
            Id="OPP001",
            AccountId="ACC001",
            Name="Test Grant",
            StageName="Qualifying",
            OwnerId="USR001",
            Amount=50000,
            Probability=40,
        )
        assert opp.probability == 40
        assert opp.amount == Decimal('50000')

    def test_probability_out_of_range_raises(self):
        with pytest.raises(ValueError, match="Probability"):
            SalesforceOpportunity(
                Id="OPP001",
                AccountId="ACC001",
                Name="Test",
                StageName="Qualifying",
                OwnerId="USR001",
                Probability=150,
            )

    def test_probability_negative_raises(self):
        with pytest.raises(ValueError, match="Probability"):
            SalesforceOpportunity(
                Id="OPP001",
                AccountId="ACC001",
                Name="Test",
                StageName="Qualifying",
                OwnerId="USR001",
                Probability=-10,
            )

    def test_probability_none_is_allowed(self):
        opp = SalesforceOpportunity(
            Id="OPP001",
            AccountId="ACC001",
            Name="Test",
            StageName="Qualifying",
            OwnerId="USR001",
        )
        assert opp.probability is None

    def test_alias_population(self):
        """Can create from Salesforce-style field names (aliases)."""
        opp = SalesforceOpportunity(
            Id="OPP001",
            AccountId="ACC001",
            Name="Test",
            StageName="Lead Gen",
            OwnerId="USR001",
        )
        assert opp.stage_name == OpportunityStage.LEAD_GEN


# ---------------------------------------------------------------------------
# CashFlowProjection — computed fields
# ---------------------------------------------------------------------------
class TestCashFlowProjection:
    def test_net_cash_flow_computed(self):
        proj = CashFlowProjection(
            period_start=date(2026, 3, 1),
            period_end=date(2026, 3, 31),
            opening_balance=Decimal('100000'),
            projected_receipts=Decimal('50000'),
            projected_payments=Decimal('30000'),
            net_cash_flow=Decimal('0'),  # should be overridden by validator
            closing_balance=Decimal('0'),
            confidence_level=0.85,
        )
        assert proj.net_cash_flow == Decimal('20000')
        assert proj.closing_balance == Decimal('120000')


# ---------------------------------------------------------------------------
# ApiResponse — envelope contract
# ---------------------------------------------------------------------------
class TestApiResponse:
    def test_success_response(self):
        resp = ApiResponse(success=True, data={"key": "value"})
        assert resp.success is True
        assert resp.data == {"key": "value"}
        assert resp.error is None

    def test_error_response(self):
        resp = ApiResponse(success=False, error="Something went wrong")
        assert resp.success is False
        assert resp.data is None
        assert resp.error == "Something went wrong"


# ---------------------------------------------------------------------------
# PaymentTerms enum
# ---------------------------------------------------------------------------
class TestPaymentTerms:
    def test_all_terms_present(self):
        expected = {"Net 15", "Net 30", "Net 45", "Net 60", "Net 90", "Immediate", "COD"}
        actual = {t.value for t in PaymentTerms}
        assert actual == expected
