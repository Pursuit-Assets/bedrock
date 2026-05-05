"""Tier 21-30: Advanced forecasting engine tests.

Covers:
  - Stage probability completeness and invariants
  - Adjusted probability calculation (method-level)
  - Deal size adjustment edge cases
  - Account win rate calculation
  - Payment term/delay lookup completeness
  - Cash flow projection boundary conditions
  - Concentration risk detection
"""

import sys
import os
from datetime import date, timedelta
from decimal import Decimal

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from forecasting_engine import (
    calculate_weighted_pipeline,
    calculate_expected_revenue_in_window,
    identify_risk_factors,
    ForecastAssumptions,
    ForecastingEngine,
)
from models import OpportunityStage, PaymentTerms, OPEN_STAGES, CLOSED_STAGES, COLLECTING_STAGES


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture
def engine():
    """ForecastingEngine with no real MCP client, pre-populated cache."""
    e = ForecastingEngine(mcp_client=None)
    e.historical_data_cache = {
        "closed_opportunities": [
            {"AccountId": "ACC001", "Amount": 50000, "StageName": "Closed / Completed"},
            {"AccountId": "ACC001", "Amount": 40000, "StageName": "Closed / Completed"},
            {"AccountId": "ACC001", "Amount": 30000, "StageName": "Closed Lost"},
            {"AccountId": "ACC001", "Amount": 60000, "StageName": "Closed / Completed"},
            {"AccountId": "ACC002", "Amount": 20000, "StageName": "Closed Lost"},
            {"AccountId": "ACC002", "Amount": 15000, "StageName": "Closed Lost"},
            {"AccountId": "ACC002", "Amount": 25000, "StageName": "Closed Lost"},
        ],
        "invoices": [],
        "payments": [],
    }
    return e


# ===========================================================================
# Stage probability completeness
# ===========================================================================
class TestStageProbabilities:
    def test_every_stage_has_a_probability(self):
        e = ForecastingEngine(mcp_client=None)
        for stage in OpportunityStage:
            assert stage in e.stage_probabilities, f"Missing probability for {stage}"

    def test_probabilities_in_valid_range(self):
        e = ForecastingEngine(mcp_client=None)
        for stage, prob in e.stage_probabilities.items():
            assert 0.0 <= prob <= 1.0, f"{stage} has invalid probability {prob}"

    def test_closed_completed_is_certain(self):
        e = ForecastingEngine(mcp_client=None)
        assert e.stage_probabilities[OpportunityStage.CLOSED_COMPLETED] == 1.0

    def test_lost_stages_are_zero(self):
        e = ForecastingEngine(mcp_client=None)
        assert e.stage_probabilities[OpportunityStage.CLOSED_LOST] == 0.0
        assert e.stage_probabilities[OpportunityStage.CLOSED_DID_NOT_FULFILL] == 0.0
        assert e.stage_probabilities[OpportunityStage.WITHDRAWN] == 0.0
        assert e.stage_probabilities[OpportunityStage.NONE] == 0.0

    def test_probabilities_increase_through_pipeline(self):
        """Later pipeline stages should have higher probabilities."""
        e = ForecastingEngine(mcp_client=None)
        pipeline = [
            OpportunityStage.LEAD_GEN,
            OpportunityStage.NEW_LEAD,
            OpportunityStage.QUALIFYING,
            OpportunityStage.ASK_IN_PROGRESS,
            OpportunityStage.PROPOSAL_SUBMITTED,
            OpportunityStage.CONTRACT_CREATION,
            OpportunityStage.CONTRACTING,
            OpportunityStage.COLLECTING,
        ]
        probs = [e.stage_probabilities[s] for s in pipeline]
        assert probs == sorted(probs), "Pipeline probabilities should increase monotonically"


# ===========================================================================
# Payment terms completeness
# ===========================================================================
class TestPaymentTermsMaps:
    def test_every_payment_term_has_days(self):
        e = ForecastingEngine(mcp_client=None)
        for term in PaymentTerms:
            assert term in e.payment_term_days, f"Missing days for {term}"

    def test_every_payment_term_has_collection_rate(self):
        e = ForecastingEngine(mcp_client=None)
        for term in PaymentTerms:
            assert term in e.collection_rates, f"Missing collection rate for {term}"

    def test_every_payment_term_has_delay(self):
        e = ForecastingEngine(mcp_client=None)
        for term in PaymentTerms:
            assert term in e.average_payment_delays, f"Missing delay for {term}"

    def test_collection_rates_decrease_with_longer_terms(self):
        """Longer payment terms should have lower collection rates."""
        e = ForecastingEngine(mcp_client=None)
        assert e.collection_rates[PaymentTerms.IMMEDIATE] > e.collection_rates[PaymentTerms.NET_90]

    def test_immediate_and_cod_are_zero_days(self):
        e = ForecastingEngine(mcp_client=None)
        assert e.payment_term_days[PaymentTerms.IMMEDIATE] == 0
        assert e.payment_term_days[PaymentTerms.COD] == 0


# ===========================================================================
# Account win rate
# ===========================================================================
class TestAccountWinRate:
    def test_returns_none_for_insufficient_data(self, engine):
        """Needs at least 3 opportunities to calculate."""
        engine.historical_data_cache["closed_opportunities"] = [
            {"AccountId": "ACC099", "StageName": "Closed / Completed"},
        ]
        assert engine._get_account_historical_win_rate("ACC099") is None

    def test_returns_rate_for_sufficient_data(self, engine):
        # ACC001 has 4 opps: 3 won, 1 lost → 75%
        rate = engine._get_account_historical_win_rate("ACC001")
        assert rate == pytest.approx(0.75)

    def test_low_win_rate_account(self, engine):
        # ACC002 has 3 opps: 0 won, 3 lost → 0%
        rate = engine._get_account_historical_win_rate("ACC002")
        assert rate == pytest.approx(0.0)

    def test_unknown_account(self, engine):
        assert engine._get_account_historical_win_rate("NONEXISTENT") is None


# ===========================================================================
# Deal size adjustment
# ===========================================================================
class TestDealSizeAdjustment:
    def test_no_data_returns_one(self):
        e = ForecastingEngine(mcp_client=None)
        e.historical_data_cache = {"closed_opportunities": []}
        assert e._get_deal_size_adjustment(Decimal('50000')) == 1.0

    def test_average_deal_no_adjustment(self, engine):
        # Average of cache = (50k+40k+30k+60k+20k+15k+25k)/7 ≈ 34286
        # A deal of 34000 is close to average
        adj = engine._get_deal_size_adjustment(Decimal('34000'))
        assert adj == 1.0

    def test_very_large_deal_penalized(self, engine):
        # Average ≈ 34286, 2x = 68571
        adj = engine._get_deal_size_adjustment(Decimal('200000'))
        assert adj == 0.85

    def test_large_deal_slight_penalty(self, engine):
        # 1.5x average ≈ 51429
        adj = engine._get_deal_size_adjustment(Decimal('55000'))
        assert adj == 0.92

    def test_small_deal_bonus(self, engine):
        # 0.5x average ≈ 17143
        adj = engine._get_deal_size_adjustment(Decimal('5000'))
        assert adj == 1.05


# ===========================================================================
# Adjusted probability calculation
# ===========================================================================
class TestAdjustedProbability:
    def test_bounds_never_exceed_zero_to_one(self, engine):
        """Result must be in [0, 1] regardless of inputs."""
        for stage in OpportunityStage:
            for prob in [0, 50, 100]:
                result = engine._calculate_adjusted_probability(
                    stage, prob, "ACC001", Decimal('50000')
                )
                assert 0.0 <= result <= 1.0, f"Out of bounds for {stage}, prob={prob}"

    def test_closed_completed_high_probability(self, engine):
        result = engine._calculate_adjusted_probability(
            OpportunityStage.CLOSED_COMPLETED, 100, "UNKNOWN", Decimal('30000')
        )
        assert result > 0.9

    def test_closed_lost_low_probability(self, engine):
        result = engine._calculate_adjusted_probability(
            OpportunityStage.CLOSED_LOST, 0, "UNKNOWN", Decimal('30000')
        )
        assert result == 0.0

    def test_incorporates_account_history(self, engine):
        """Account with poor history should lower probability."""
        # ACC002 has 0% win rate
        result_bad = engine._calculate_adjusted_probability(
            OpportunityStage.QUALIFYING, 50, "ACC002", Decimal('25000')
        )
        # Unknown account (no history adjustment)
        result_neutral = engine._calculate_adjusted_probability(
            OpportunityStage.QUALIFYING, 50, "UNKNOWN", Decimal('25000')
        )
        assert result_bad < result_neutral


# ===========================================================================
# Risk factors — additional edge cases
# ===========================================================================
class TestRiskFactorsAdvanced:
    def test_overdue_close_date(self):
        risks = identify_risk_factors(
            {}, OpportunityStage.QUALIFYING, date.today() - timedelta(days=5),
            Decimal('50000'), None, date.today()
        )
        assert "Overdue close date" in risks

    def test_close_within_one_week(self):
        risks = identify_risk_factors(
            {}, OpportunityStage.QUALIFYING, date.today() + timedelta(days=3),
            Decimal('50000'), None, date.today()
        )
        assert "Close date within 1 week" in risks

    def test_early_stage_near_close(self):
        risks = identify_risk_factors(
            {}, OpportunityStage.LEAD_GEN, date.today() + timedelta(days=15),
            Decimal('50000'), None, date.today()
        )
        assert "Early stage with near-term close date" in risks

    def test_early_stage_far_close_no_risk(self):
        risks = identify_risk_factors(
            {}, OpportunityStage.LEAD_GEN, date.today() + timedelta(days=90),
            Decimal('50000'), None, date.today()
        )
        assert "Early stage with near-term close date" not in risks

    def test_large_deal_risk(self):
        risks = identify_risk_factors(
            {}, OpportunityStage.COLLECTING, date.today() + timedelta(days=60),
            Decimal('500000'), None, date.today()
        )
        assert "Large deal size" in risks

    def test_low_win_rate_risk(self):
        risks = identify_risk_factors(
            {}, OpportunityStage.COLLECTING, date.today() + timedelta(days=60),
            Decimal('50000'), 0.2, date.today()
        )
        assert "Low historical win rate for account" in risks

    def test_extended_payment_terms_risk(self):
        risks = identify_risk_factors(
            {"Payment_Terms__c": "Net 90"}, OpportunityStage.COLLECTING,
            date.today() + timedelta(days=60), Decimal('50000'), None, date.today()
        )
        assert "Extended payment terms" in risks

    def test_net_30_no_payment_risk(self):
        risks = identify_risk_factors(
            {"Payment_Terms__c": "Net 30"}, OpportunityStage.COLLECTING,
            date.today() + timedelta(days=60), Decimal('50000'), None, date.today()
        )
        assert "Extended payment terms" not in risks

    def test_multiple_risks_stacking(self):
        """An opportunity can have multiple concurrent risk factors."""
        risks = identify_risk_factors(
            {"Payment_Terms__c": "Net 90"},
            OpportunityStage.LEAD_GEN,
            date.today() - timedelta(days=1),
            Decimal('200000'),
            0.1,
            date.today(),
        )
        assert len(risks) >= 4  # overdue + large + low win rate + extended terms


# ===========================================================================
# Revenue window — edge cases
# ===========================================================================
class TestRevenueWindowEdgeCases:
    def test_exact_cutoff_date_included(self):
        """Opportunities on the cutoff date should be included (<=)."""
        today = date(2026, 3, 16)
        opps = [{"Amount": 10000, "Probability": 100, "CloseDate": "2026-04-15"}]
        result = calculate_expected_revenue_in_window(opps, today, 30)
        assert result == Decimal('10000')

    def test_day_after_cutoff_excluded(self):
        today = date(2026, 3, 16)
        opps = [{"Amount": 10000, "Probability": 100, "CloseDate": "2026-04-16"}]
        result = calculate_expected_revenue_in_window(opps, today, 30)
        assert result == Decimal('0')

    def test_missing_close_date_skipped(self):
        today = date(2026, 3, 16)
        opps = [{"Amount": 10000, "Probability": 100}]
        result = calculate_expected_revenue_in_window(opps, today, 30)
        assert result == Decimal('0')

    def test_zero_probability_contributes_nothing(self):
        today = date(2026, 3, 16)
        opps = [{"Amount": 100000, "Probability": 0, "CloseDate": "2026-03-20"}]
        result = calculate_expected_revenue_in_window(opps, today, 30)
        assert result == Decimal('0')

    def test_zero_days_window(self):
        """Only today's opportunities."""
        today = date(2026, 3, 16)
        opps = [
            {"Amount": 10000, "Probability": 100, "CloseDate": "2026-03-16"},
            {"Amount": 20000, "Probability": 100, "CloseDate": "2026-03-17"},
        ]
        result = calculate_expected_revenue_in_window(opps, today, 0)
        assert result == Decimal('10000')


# ===========================================================================
# ForecastAssumptions — smoke tests
# ===========================================================================
class TestForecastAssumptions:
    def test_defaults_are_positive(self):
        assert ForecastAssumptions.DEFAULT_CASH_POSITION > 0
        assert ForecastAssumptions.DEFAULT_MONTHLY_EXPENSES > 0
        assert ForecastAssumptions.DEFAULT_AVG_PAYMENT_DELAY_DAYS > 0
        assert ForecastAssumptions.DEFAULT_COLLECTION_RATE > 0

    def test_collection_rate_is_fraction(self):
        assert 0 < ForecastAssumptions.DEFAULT_COLLECTION_RATE <= 1
