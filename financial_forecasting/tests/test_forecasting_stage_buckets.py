"""Tests for F1 bucket-set integration in forecasting_engine + main VALID_STAGES.

Covers:
  - SOQL queries at forecasting_engine.py:179/234/538 use WON ∪ LOST terminal list
  - Python filters at L353/560/566 use WON_STAGES_SET for win-counting
  - main.VALID_STAGES admits 'Closed Won' and 'Collecting / In Effect'

Supersedes the pre-existing skipped tests at test_forecasting_integration.py:434, :447
(they remain skipped; semantics are covered here via last_cache_update preset).
"""

import os
import sys
from datetime import datetime
from decimal import Decimal
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from forecasting_engine import ForecastingEngine


TERMINAL_STAGES = {
    "Collecting / In Effect",
    "Closed / Completed",
    "Closed Won",
    "Closed Lost",
    "Withdrawn",
    "Closed / Did not Fulfill",
}


# ---------------------------------------------------------------------------
# 1-3. SOQL string assertions — each query uses WON ∪ LOST terminal list
# ---------------------------------------------------------------------------

class TestSoqlQueriesUseFrozensets:

    @pytest.mark.asyncio
    async def test_load_historical_query_includes_all_terminal_stages(self, mock_mcp_client):
        engine = ForecastingEngine(mock_mcp_client)
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        await engine._load_historical_data()

        query_str = mock_mcp_client.salesforce.query.call_args.args[0]
        assert "StageName IN (" in query_str
        assert "NOT IN" not in query_str
        for stage in TERMINAL_STAGES:
            assert f"'{stage}'" in query_str, f"missing {stage!r} in historical query"

    @pytest.mark.asyncio
    async def test_payment_forecasts_query_excludes_all_terminal_stages(
        self, forecasting_engine, mock_mcp_client
    ):
        forecasting_engine.last_cache_update = datetime.now()
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        await forecasting_engine.generate_payment_forecasts(days_ahead=90)

        query_str = mock_mcp_client.salesforce.query.call_args.args[0]
        assert "StageName NOT IN (" in query_str
        for stage in TERMINAL_STAGES:
            assert f"'{stage}'" in query_str, f"missing {stage!r} in payment-forecasts query"

    @pytest.mark.asyncio
    async def test_metrics_pipeline_query_excludes_all_terminal_stages(
        self, forecasting_engine, mock_mcp_client
    ):
        forecasting_engine.last_cache_update = datetime.now()
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        await forecasting_engine.calculate_forecasting_metrics()

        query_str = mock_mcp_client.salesforce.query.call_args.args[0]
        assert "StageName NOT IN (" in query_str
        for stage in TERMINAL_STAGES:
            assert f"'{stage}'" in query_str, f"missing {stage!r} in metrics pipeline query"


# ---------------------------------------------------------------------------
# 4. Account win rate counts Closed Won as a win
# ---------------------------------------------------------------------------

class TestAccountWinRateBucket:

    def test_account_win_rate_counts_closed_won(self):
        engine = ForecastingEngine(mcp_client=None)
        engine.historical_data_cache = {
            "closed_opportunities": [
                {"AccountId": "ACC001", "StageName": "Closed Won", "Amount": 10000},
                {"AccountId": "ACC001", "StageName": "Closed Won", "Amount": 20000},
                {"AccountId": "ACC001", "StageName": "Closed Lost", "Amount": 5000},
            ],
            "invoices": [],
            "payments": [],
        }

        rate = engine._get_account_historical_win_rate("ACC001")
        assert rate == pytest.approx(2 / 3)


# ---------------------------------------------------------------------------
# 5-6. Metrics win_rate + avg_deal_size use WON_STAGES_SET
# ---------------------------------------------------------------------------

class TestMetricsWonBucket:

    @pytest.mark.asyncio
    async def test_metrics_win_rate_counts_won_bucket(
        self, forecasting_engine, mock_mcp_client
    ):
        forecasting_engine.last_cache_update = datetime.now()
        forecasting_engine.historical_data_cache = {
            "closed_opportunities": [
                {"StageName": "Closed Won", "Amount": 10000, "CreatedDate": "2025-01-01", "CloseDate": "2025-03-01"},
                {"StageName": "Collecting / In Effect", "Amount": 20000, "CreatedDate": "2025-02-01", "CloseDate": "2025-04-01"},
                {"StageName": "Closed Lost", "Amount": 50000, "CreatedDate": "2025-03-01", "CloseDate": "2025-05-01"},
            ],
            "invoices": [],
            "payments": [],
        }
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        metrics = await forecasting_engine.calculate_forecasting_metrics()

        assert metrics.win_rate == pytest.approx(2 / 3)

    @pytest.mark.asyncio
    async def test_metrics_avg_deal_size_includes_won_bucket(
        self, forecasting_engine, mock_mcp_client
    ):
        forecasting_engine.last_cache_update = datetime.now()
        forecasting_engine.historical_data_cache = {
            "closed_opportunities": [
                {"StageName": "Closed Won", "Amount": 10000, "CreatedDate": "2025-01-01", "CloseDate": "2025-03-01"},
                {"StageName": "Collecting / In Effect", "Amount": 20000, "CreatedDate": "2025-02-01", "CloseDate": "2025-04-01"},
                {"StageName": "Closed Lost", "Amount": 50000, "CreatedDate": "2025-03-01", "CloseDate": "2025-05-01"},
            ],
            "invoices": [],
            "payments": [],
        }
        mock_mcp_client.salesforce.query = AsyncMock(return_value={"records": []})

        metrics = await forecasting_engine.calculate_forecasting_metrics()

        assert metrics.average_deal_size == Decimal('15000')


# ---------------------------------------------------------------------------
# 7. main.VALID_STAGES admits the out-of-enum stage values
# ---------------------------------------------------------------------------

class TestMainValidStagesWidening:

    def test_valid_stages_admits_closed_won_and_collecting(self):
        from main import VALID_STAGES

        assert "Closed Won" in VALID_STAGES
        assert "Collecting / In Effect" in VALID_STAGES
        assert "Closed / Completed" in VALID_STAGES
        assert "Closed Lost" in VALID_STAGES
        assert "Withdrawn" in VALID_STAGES
        assert "Closed / Did not Fulfill" in VALID_STAGES
