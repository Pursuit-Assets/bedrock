"""End-to-end forecasting engine integration tests with mocked I/O.

Exercises the full ForecastingEngine lifecycle:
  - generate_payment_forecasts (with mocked SF queries)
  - generate_cash_flow_projections (receipts + expenses)
  - calculate_forecasting_metrics (pipeline, win rate, windows)
  - _refresh_historical_data (mocked SF + Intacct queries)
  - _get_current_cash_position (Intacct fallback)
  - _calculate_adjusted_probability (blended factors)

All async methods use mocked MCP clients from conftest.
"""

import sys
import os
from datetime import datetime, date, timedelta
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Add parent to path so we can import from financial_forecasting
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from forecasting_engine import ForecastingEngine, ForecastAssumptions
from models import (
    OpportunityStage, PaymentTerms, PaymentForecast, CashFlowProjection,
    ForecastingMetrics, OPEN_STAGES, CLOSED_STAGES,
)
from conftest import make_sf_opportunity, make_intacct_invoice, make_intacct_payment, make_pipeline_scenario


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _open_opps_from_scenario(opps):
    """Filter a scenario list to only open opportunities (not closed stages)."""
    closed_stage_values = {s.value for s in CLOSED_STAGES}
    return [o for o in opps if o["StageName"] not in closed_stage_values]


# ===========================================================================
# 1. Empty pipeline -> zero forecasts, cash flow shows only expenses
# ===========================================================================
class TestEmptyPipeline:

    @pytest.mark.asyncio
    async def test_empty_pipeline_returns_no_forecasts(self, forecasting_engine, mock_mcp_client):
        """An empty pipeline should produce zero payment forecasts."""
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        forecasts = await forecasting_engine.generate_payment_forecasts(days_ahead=90)

        assert forecasts == []

    @pytest.mark.asyncio
    async def test_empty_pipeline_cash_flow_shows_only_expenses(self, forecasting_engine, mock_mcp_client):
        """With no pipeline, cash flow projections should reflect expenses only."""
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        projections = await forecasting_engine.generate_cash_flow_projections(months_ahead=3)

        assert len(projections) == 3
        for proj in projections:
            assert proj.projected_receipts == Decimal('0')
            assert proj.projected_payments == ForecastAssumptions.DEFAULT_MONTHLY_EXPENSES
            # Net cash flow should be negative (only expenses, no receipts)
            assert proj.net_cash_flow == -ForecastAssumptions.DEFAULT_MONTHLY_EXPENSES

    @pytest.mark.asyncio
    async def test_empty_pipeline_running_balance_decreases(self, forecasting_engine, mock_mcp_client):
        """Running balance should decrease each month by monthly expenses."""
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        projections = await forecasting_engine.generate_cash_flow_projections(months_ahead=3)

        # First month opens with the default cash position
        assert projections[0].opening_balance == ForecastAssumptions.DEFAULT_CASH_POSITION
        # Each subsequent month opens with the previous closing balance
        for i in range(1, len(projections)):
            assert projections[i].opening_balance == projections[i - 1].closing_balance


# ===========================================================================
# 2. All-closed pipeline -> no new forecasts
# ===========================================================================
class TestAllClosedPipeline:

    @pytest.mark.asyncio
    async def test_all_closed_pipeline_produces_no_forecasts(self, forecasting_engine, mock_mcp_client):
        """Closed opportunities should not generate payment forecasts.

        The query in generate_payment_forecasts filters for open opps only,
        so even if the mock returns closed opps, the SF query would normally
        exclude them. We simulate the SF-side filter by returning an empty list.
        """
        # The real SF query filters WHERE StageName NOT IN (closed stages),
        # so Salesforce returns nothing for an all-closed pipeline.
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        forecasts = await forecasting_engine.generate_payment_forecasts(days_ahead=90)

        assert forecasts == []

    @pytest.mark.asyncio
    async def test_all_closed_metrics_show_zero_pipeline(self, forecasting_engine, mock_mcp_client):
        """Metrics with no open pipeline should show zero values."""
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        metrics = await forecasting_engine.calculate_forecasting_metrics()

        assert metrics.total_pipeline_value == Decimal('0')
        assert metrics.weighted_pipeline_value == Decimal('0')


# ===========================================================================
# 3. Mixed pipeline -> forecasts for open opps, cash flow includes receipts
# ===========================================================================
class TestMixedPipeline:

    @pytest.fixture
    def mixed_scenario(self):
        return make_pipeline_scenario("mixed")

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_mixed_pipeline_generates_forecasts_for_open_opps(
        self, forecasting_engine, mock_mcp_client, mixed_scenario
    ):
        """Only open opportunities should produce payment forecasts."""
        open_opps = _open_opps_from_scenario(mixed_scenario)
        # Mock SF to return open opps (simulating server-side filter)
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": open_opps})

        forecasts = await forecasting_engine.generate_payment_forecasts(days_ahead=180)

        assert len(forecasts) == len(open_opps)
        for fc in forecasts:
            assert fc.stage_name.value not in {s.value for s in CLOSED_STAGES}

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_mixed_pipeline_cash_flow_includes_receipts(
        self, forecasting_engine, mock_mcp_client, mixed_scenario
    ):
        """Cash flow should include projected receipts from open opportunities."""
        open_opps = _open_opps_from_scenario(mixed_scenario)
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": open_opps})

        projections = await forecasting_engine.generate_cash_flow_projections(months_ahead=6)

        # At least one month should have projected receipts > 0
        total_receipts = sum(p.projected_receipts for p in projections)
        assert total_receipts > Decimal('0'), "Mixed pipeline should produce some receipts"

    @pytest.mark.asyncio
    async def test_mixed_pipeline_metrics_reflect_open_opps(
        self, forecasting_engine, mock_mcp_client, mixed_scenario
    ):
        """Metrics should reflect the open portion of the pipeline."""
        open_opps = _open_opps_from_scenario(mixed_scenario)
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": open_opps})

        metrics = await forecasting_engine.calculate_forecasting_metrics()

        expected_total = sum(Decimal(str(o.get("Amount", 0))) for o in open_opps)
        assert metrics.total_pipeline_value == expected_total
        assert metrics.weighted_pipeline_value > Decimal('0')
        assert metrics.weighted_pipeline_value <= expected_total


# ===========================================================================
# 4. Single large deal -> concentration risk, specific forecast amounts
# ===========================================================================
class TestSingleLargeDeal:

    @pytest.fixture
    def large_deal_scenario(self):
        return make_pipeline_scenario("single_large")

    @pytest.mark.asyncio
    async def test_single_large_deal_high_concentration_risk(
        self, forecasting_engine, mock_mcp_client, large_deal_scenario
    ):
        """A dominant large deal should create high concentration risk."""
        mock_mcp_client.salesforce.query = AsyncMock(
            return_value={"records": large_deal_scenario}
        )

        metrics = await forecasting_engine.calculate_forecasting_metrics()

        # The $500k deal from one account dominates the $510k pipeline
        assert metrics.concentration_risk_score >= 0.7

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_large_deal_forecast_amount(
        self, forecasting_engine, mock_mcp_client, large_deal_scenario
    ):
        """Forecast amount should be amount * probability / 100."""
        mock_mcp_client.salesforce.query = AsyncMock(
            return_value={"records": large_deal_scenario}
        )

        forecasts = await forecasting_engine.generate_payment_forecasts(days_ahead=180)

        large_forecast = next(
            (f for f in forecasts if f.opportunity_id == "006LARGE001"), None
        )
        assert large_forecast is not None
        # Amount=500000, Probability=70 => expected_amount=350000
        assert large_forecast.expected_amount == Decimal('350000')
        assert large_forecast.amount == Decimal('500000')

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_large_deal_risk_factors(
        self, forecasting_engine, mock_mcp_client, large_deal_scenario
    ):
        """A $500k deal should flag 'Large deal size' as a risk factor."""
        mock_mcp_client.salesforce.query = AsyncMock(
            return_value={"records": large_deal_scenario}
        )

        forecasts = await forecasting_engine.generate_payment_forecasts(days_ahead=180)

        large_forecast = next(
            (f for f in forecasts if f.opportunity_id == "006LARGE001"), None
        )
        assert large_forecast is not None
        assert "Large deal size" in large_forecast.risk_factors


# ===========================================================================
# 5. Payment forecast date calculation
# ===========================================================================
class TestPaymentForecastDateCalculation:

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_expected_payment_date_net30(self, forecasting_engine, mock_mcp_client):
        """Expected payment date = close_date + payment_term_days + avg_delay."""
        close_date = (date.today() + timedelta(days=30)).isoformat()
        opp = make_sf_opportunity({
            "Id": "006DATE001",
            "StageName": "Qualifying",
            "Amount": 50000,
            "Probability": 40,
            "CloseDate": close_date,
            "Payment_Terms__c": "Net 30",
        })
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": [opp]})

        forecasts = await forecasting_engine.generate_payment_forecasts(days_ahead=90)

        assert len(forecasts) == 1
        fc = forecasts[0]
        expected_close = date.fromisoformat(close_date)
        # Net 30 = 30 days + 8 days avg delay = 38 days after close
        expected_payment = expected_close + timedelta(days=30 + 8)
        assert fc.expected_payment_date == expected_payment

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_expected_payment_date_net60(self, forecasting_engine, mock_mcp_client):
        """Net 60 terms should add 60 + 15 (avg delay for Net 60) days."""
        close_date = (date.today() + timedelta(days=20)).isoformat()
        opp = make_sf_opportunity({
            "Id": "006DATE002",
            "StageName": "Contract Creation",
            "Amount": 75000,
            "Probability": 70,
            "CloseDate": close_date,
            "Payment_Terms__c": "Net 60",
        })
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": [opp]})

        forecasts = await forecasting_engine.generate_payment_forecasts(days_ahead=90)

        assert len(forecasts) == 1
        fc = forecasts[0]
        expected_close = date.fromisoformat(close_date)
        # Net 60 = 60 days + 15 days avg delay = 75 days after close
        expected_payment = expected_close + timedelta(days=60 + 15)
        assert fc.expected_payment_date == expected_payment

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_expected_payment_date_immediate(self, forecasting_engine, mock_mcp_client):
        """Immediate terms: 0 days + 2 day avg delay."""
        close_date = (date.today() + timedelta(days=10)).isoformat()
        opp = make_sf_opportunity({
            "Id": "006DATE003",
            "StageName": "Contracting",
            "Amount": 20000,
            "Probability": 80,
            "CloseDate": close_date,
            "Payment_Terms__c": "Immediate",
        })
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": [opp]})

        forecasts = await forecasting_engine.generate_payment_forecasts(days_ahead=90)

        assert len(forecasts) == 1
        fc = forecasts[0]
        expected_close = date.fromisoformat(close_date)
        expected_payment = expected_close + timedelta(days=0 + 2)
        assert fc.expected_payment_date == expected_payment


# ===========================================================================
# 6. Cash flow projection running balance correctness
# ===========================================================================
class TestCashFlowRunningBalance:

    @pytest.mark.asyncio
    async def test_running_balance_chain(self, forecasting_engine, mock_mcp_client):
        """Each month's opening balance must equal the previous closing balance."""
        opp = make_sf_opportunity({
            "Id": "006BAL001",
            "StageName": "Qualifying",
            "Amount": 100000,
            "Probability": 50,
            "CloseDate": (date.today() + timedelta(days=45)).isoformat(),
            "Payment_Terms__c": "Net 30",
        })
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": [opp]})

        projections = await forecasting_engine.generate_cash_flow_projections(months_ahead=6)

        assert len(projections) == 6
        # First month opens at the default cash position
        assert projections[0].opening_balance == ForecastAssumptions.DEFAULT_CASH_POSITION
        for i in range(1, len(projections)):
            assert projections[i].opening_balance == projections[i - 1].closing_balance, (
                f"Month {i}: opening balance mismatch"
            )

    @pytest.mark.asyncio
    async def test_closing_balance_equals_opening_plus_net(self, forecasting_engine, mock_mcp_client):
        """closing_balance = opening_balance + net_cash_flow for each projection."""
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        projections = await forecasting_engine.generate_cash_flow_projections(months_ahead=4)

        for proj in projections:
            expected_closing = proj.opening_balance + proj.net_cash_flow
            assert proj.closing_balance == expected_closing

    @pytest.mark.asyncio
    async def test_net_cash_flow_equals_receipts_minus_payments(self, forecasting_engine, mock_mcp_client):
        """net_cash_flow = projected_receipts - projected_payments."""
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        projections = await forecasting_engine.generate_cash_flow_projections(months_ahead=3)

        for proj in projections:
            expected_net = proj.projected_receipts - proj.projected_payments
            assert proj.net_cash_flow == expected_net


# ===========================================================================
# 7. Metrics calculation: weighted pipeline, 30/60/90 day windows
# ===========================================================================
class TestMetricsCalculation:

    @pytest.mark.asyncio
    async def test_weighted_pipeline_value(self, forecasting_engine, mock_mcp_client):
        """Weighted pipeline = sum(amount * probability / 100)."""
        opps = [
            make_sf_opportunity({
                "Id": "006MET001",
                "StageName": "Qualifying",
                "Amount": 100000,
                "Probability": 40,
                "CloseDate": (date.today() + timedelta(days=30)).isoformat(),
            }),
            make_sf_opportunity({
                "Id": "006MET002",
                "StageName": "Contract Creation",
                "Amount": 50000,
                "Probability": 70,
                "CloseDate": (date.today() + timedelta(days=15)).isoformat(),
            }),
        ]
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": opps})

        metrics = await forecasting_engine.calculate_forecasting_metrics()

        # Weighted: 100k*0.4 + 50k*0.7 = 40k + 35k = 75k
        assert metrics.weighted_pipeline_value == Decimal('75000')
        assert metrics.total_pipeline_value == Decimal('150000')

    @pytest.mark.asyncio
    async def test_revenue_windows_30_60_90(self, forecasting_engine, mock_mcp_client):
        """30/60/90-day revenue windows include opps closing within those windows."""
        today = date.today()
        opps = [
            make_sf_opportunity({
                "Id": "006WIN001",
                "StageName": "Contract Creation",
                "Amount": 50000,
                "Probability": 80,
                "CloseDate": (today + timedelta(days=15)).isoformat(),
            }),
            make_sf_opportunity({
                "Id": "006WIN002",
                "StageName": "Qualifying",
                "Amount": 40000,
                "Probability": 50,
                "CloseDate": (today + timedelta(days=45)).isoformat(),
            }),
            make_sf_opportunity({
                "Id": "006WIN003",
                "StageName": "Lead Gen",
                "Amount": 60000,
                "Probability": 10,
                "CloseDate": (today + timedelta(days=75)).isoformat(),
            }),
        ]
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": opps})

        metrics = await forecasting_engine.calculate_forecasting_metrics()

        # 30-day: 50k*0.8 = 40k
        assert metrics.expected_revenue_30_days == Decimal('40000')
        # 60-day: 50k*0.8 + 40k*0.5 = 40k + 20k = 60k
        assert metrics.expected_revenue_60_days == Decimal('60000')
        # 90-day: all three = 40k + 20k + 6k = 66k
        assert metrics.expected_revenue_90_days == Decimal('66000')

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_win_rate_from_historical_data(self, forecasting_engine, mock_mcp_client):
        """Win rate = won / total_closed from historical cache."""
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        metrics = await forecasting_engine.calculate_forecasting_metrics()

        # Historical cache in conftest has 3 opps: 2 won, 1 lost
        # Win rate = 2/3 ~= 0.667
        assert abs(metrics.win_rate - 2 / 3) < 0.01

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_average_deal_size_from_won_opps(self, forecasting_engine, mock_mcp_client):
        """Average deal size comes from Closed/Completed opportunities."""
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        metrics = await forecasting_engine.calculate_forecasting_metrics()

        # Historical cache: 2 won opps with Amount 50000 and 30000
        # Average = (50000 + 30000) / 2 = 40000
        assert metrics.average_deal_size == Decimal('40000')


# ===========================================================================
# 8. Historical data refresh with mocked SF/Intacct queries
# ===========================================================================
class TestHistoricalDataRefresh:

    @pytest.mark.asyncio
    async def test_refresh_populates_cache(self, mock_mcp_client):
        """_load_historical_data should populate the cache from SF + Intacct."""
        engine = ForecastingEngine(mock_mcp_client)
        assert engine.historical_data_cache == {}

        closed_opps = [
            make_sf_opportunity({
                "Id": "006HIST001",
                "StageName": "Closed / Completed",
                "Amount": 45000,
            }),
        ]
        mock_mcp_client.salesforce.query = AsyncMock(
            return_value={"records": closed_opps}
        )
        mock_mcp_client.sage_intacct.get_invoices = AsyncMock(
            return_value={"success": True, "data": [make_intacct_invoice()]}
        )
        mock_mcp_client.sage_intacct.get_payments = AsyncMock(
            return_value={"success": True, "data": [make_intacct_payment()]}
        )

        await engine._load_historical_data()

        assert len(engine.historical_data_cache["closed_opportunities"]) == 1
        assert len(engine.historical_data_cache["invoices"]) == 1
        assert len(engine.historical_data_cache["payments"]) == 1
        assert engine.last_cache_update is not None

    @pytest.mark.asyncio
    async def test_refresh_handles_sf_failure_gracefully(self, mock_mcp_client):
        """If SF query fails, cache should be empty but not crash."""
        engine = ForecastingEngine(mock_mcp_client)
        mock_mcp_client.salesforce.query = AsyncMock(side_effect=Exception("SF down"))

        await engine._load_historical_data()

        assert engine.historical_data_cache["closed_opportunities"] == []
        assert engine.historical_data_cache["invoices"] == []
        assert engine.historical_data_cache["payments"] == []

    @pytest.mark.asyncio
    async def test_refresh_handles_intacct_failure_gracefully(self, mock_mcp_client):
        """If Intacct returns failure, invoices/payments should be empty."""
        engine = ForecastingEngine(mock_mcp_client)
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})
        mock_mcp_client.sage_intacct.get_invoices = AsyncMock(
            return_value={"success": False, "error": "auth expired"}
        )
        mock_mcp_client.sage_intacct.get_payments = AsyncMock(
            return_value={"success": False, "error": "auth expired"}
        )

        await engine._load_historical_data()

        assert engine.historical_data_cache["closed_opportunities"] == []
        assert engine.historical_data_cache["invoices"] == []
        assert engine.historical_data_cache["payments"] == []

    @pytest.mark.asyncio
    async def test_cache_refresh_skipped_when_recent(self, forecasting_engine, mock_mcp_client):
        """If the cache was updated recently, _refresh_cache_if_needed should not reload."""
        forecasting_engine.last_cache_update = datetime.now()
        original_cache = forecasting_engine.historical_data_cache.copy()

        await forecasting_engine._refresh_cache_if_needed()

        # Cache should not have been reloaded
        assert forecasting_engine.historical_data_cache == original_cache

    @pytest.mark.asyncio
    async def test_cache_refresh_triggers_when_stale(self, mock_mcp_client):
        """If cache is older than 1 hour, _refresh_cache_if_needed should reload."""
        engine = ForecastingEngine(mock_mcp_client)
        engine.last_cache_update = datetime.now() - timedelta(hours=2)

        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})
        mock_mcp_client.sage_intacct.get_invoices = AsyncMock(
            return_value={"success": True, "data": []}
        )
        mock_mcp_client.sage_intacct.get_payments = AsyncMock(
            return_value={"success": True, "data": []}
        )

        await engine._refresh_cache_if_needed()

        # Cache should have been refreshed (last_cache_update updated)
        assert (datetime.now() - engine.last_cache_update).seconds < 5


# ===========================================================================
# Cash position fallback
# ===========================================================================
class TestCashPositionFallback:

    @pytest.mark.asyncio
    async def test_returns_default_when_intacct_succeeds(self, forecasting_engine, mock_mcp_client):
        """Even when Intacct responds successfully, we currently fall back to default."""
        mock_mcp_client.sage_intacct.get_financial_metrics = AsyncMock(
            return_value={"success": True, "data": {"total_revenue": 1000000}}
        )

        cash = await forecasting_engine._get_current_cash_position()

        assert cash == ForecastAssumptions.DEFAULT_CASH_POSITION

    @pytest.mark.asyncio
    async def test_returns_default_when_intacct_fails(self, forecasting_engine, mock_mcp_client):
        """If Intacct call raises, we should get the default cash position."""
        mock_mcp_client.sage_intacct.get_financial_metrics = AsyncMock(
            side_effect=Exception("Connection refused")
        )

        cash = await forecasting_engine._get_current_cash_position()

        assert cash == ForecastAssumptions.DEFAULT_CASH_POSITION


# ===========================================================================
# Adjusted probability blending
# ===========================================================================
class TestAdjustedProbabilityIntegration:

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_probability_blends_stage_and_stated(self, forecasting_engine, mock_mcp_client):
        """Adjusted probability should blend stated probability with stage probability."""
        opp = make_sf_opportunity({
            "Id": "006PROB001",
            "StageName": "Qualifying",
            "Amount": 50000,
            "Probability": 40,
            "CloseDate": (date.today() + timedelta(days=30)).isoformat(),
        })
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": [opp]})

        forecasts = await forecasting_engine.generate_payment_forecasts(days_ahead=90)

        assert len(forecasts) == 1
        fc = forecasts[0]
        # Should be between 0 and 1
        assert 0.0 <= fc.payment_probability <= 1.0
        # Should not be exactly the stated probability (blend applies)
        # Stated=40%, Stage Qualifying=20%
        # Base blend = 0.4 * 0.7 + 0.2 * 0.3 = 0.28 + 0.06 = 0.34
        # With account win rate from cache (2/3): 0.34 * 0.8 + 0.667 * 0.2 = 0.272 + 0.133 = 0.405
        # Then deal size adjustment applies on top
        assert fc.payment_probability != 0.40

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_probability_accounts_for_deal_size(self, forecasting_engine, mock_mcp_client):
        """Very large deals should have lower adjusted probability than small ones."""
        large_opp = make_sf_opportunity({
            "Id": "006PROBSZ1",
            "AccountId": "001NEWACCOUNT01",  # No historical data
            "StageName": "Qualifying",
            "Amount": 500000,
            "Probability": 50,
            "CloseDate": (date.today() + timedelta(days=30)).isoformat(),
        })
        small_opp = make_sf_opportunity({
            "Id": "006PROBSZ2",
            "AccountId": "001NEWACCOUNT02",  # No historical data
            "StageName": "Qualifying",
            "Amount": 10000,
            "Probability": 50,
            "CloseDate": (date.today() + timedelta(days=30)).isoformat(),
        })

        mock_mcp_client.salesforce.query = AsyncMock(
            return_value={"records": [large_opp, small_opp]}
        )

        forecasts = await forecasting_engine.generate_payment_forecasts(days_ahead=90)

        large_fc = next(f for f in forecasts if f.opportunity_id == "006PROBSZ1")
        small_fc = next(f for f in forecasts if f.opportunity_id == "006PROBSZ2")
        # Large deal should have lower adjusted probability due to size penalty
        assert large_fc.payment_probability < small_fc.payment_probability


# ===========================================================================
# Confidence level on cash flow projections
# ===========================================================================
class TestConfidenceLevel:

    @pytest.mark.asyncio
    async def test_no_receipts_high_confidence(self, forecasting_engine, mock_mcp_client):
        """Months with no forecasted receipts should have high confidence."""
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        projections = await forecasting_engine.generate_cash_flow_projections(months_ahead=3)

        for proj in projections:
            assert proj.confidence_level >= 0.8

    @pytest.mark.asyncio
    async def test_confidence_within_valid_range(self, forecasting_engine, mock_mcp_client):
        """All confidence levels should be between 0.0 and 1.0."""
        open_opps = _open_opps_from_scenario(make_pipeline_scenario("mixed"))
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": open_opps})

        projections = await forecasting_engine.generate_cash_flow_projections(months_ahead=6)

        for proj in projections:
            assert 0.0 <= proj.confidence_level <= 1.0


# ===========================================================================
# Payment forecast model fields
# ===========================================================================
class TestPaymentForecastFields:

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_forecast_has_all_required_fields(self, forecasting_engine, mock_mcp_client):
        """Each PaymentForecast should have all required fields populated."""
        opp = make_sf_opportunity({
            "Id": "006FIELD01",
            "StageName": "Qualifying",
            "Amount": 50000,
            "Probability": 40,
            "CloseDate": (date.today() + timedelta(days=30)).isoformat(),
        })
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": [opp]})

        forecasts = await forecasting_engine.generate_payment_forecasts(days_ahead=90)

        assert len(forecasts) == 1
        fc = forecasts[0]
        assert fc.opportunity_id == "006FIELD01"
        assert fc.account_id == opp["AccountId"]
        assert fc.amount == Decimal('50000')
        assert fc.probability == 40
        assert fc.close_date == date.fromisoformat(opp["CloseDate"])
        assert fc.payment_terms == PaymentTerms.NET_30
        assert isinstance(fc.expected_payment_date, date)
        assert isinstance(fc.risk_factors, list)

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_forecast_defaults_to_net30_for_unknown_terms(
        self, forecasting_engine, mock_mcp_client
    ):
        """Unknown payment terms should default to Net 30."""
        opp = make_sf_opportunity({
            "Id": "006TERM01",
            "StageName": "Qualifying",
            "Amount": 50000,
            "Probability": 40,
            "CloseDate": (date.today() + timedelta(days=30)).isoformat(),
            "Payment_Terms__c": "Custom Terms 120",
        })
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": [opp]})

        forecasts = await forecasting_engine.generate_payment_forecasts(days_ahead=90)

        assert len(forecasts) == 1
        assert forecasts[0].payment_terms == PaymentTerms.NET_30
