"""Tests for Wall of Progress endpoint additions:
- GET /api/salesforce/opportunities/stage-history now includes Opportunity.OwnerId
- POST /api/ai/pipeline-analysis accepts owner_ids and scopes the analysis
- POST /api/ai/pipeline-analysis accepts optional start/end date range
"""

import sys
import os
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from main import app, get_current_user, get_forecasting_engine, get_data_sync_service
from main import get_mcp_client as main_get_mcp_client
from main import require_sf_mcp_client as main_require_sf_mcp_client
from dependencies import get_mcp_client as deps_get_mcp_client
from dependencies import require_sf_mcp_client as deps_require_sf_mcp_client
from auth import require_auth
from db import get_db

app.router.on_startup.clear()
app.router.on_shutdown.clear()


TEST_USER = {"user_id": "test", "name": "Test", "email": "test@test.org"}
VALID_SF_USER_ID = "005A0000001IJKLM34"  # 18 chars


def _admin_db():
    admin_row = {
        "id": "test-id",
        "sf_user_id": "005TESTOWNER00001",
        "email": "test@test.org",
        "name": "Test",
        "is_active": True,
        "permissions": json.dumps({}),
        "profile_name": "Admin",
        "org_user_id": None,
    }
    db = AsyncMock()

    async def fetchrow(query, *args):
        if "FROM bedrock.app_user" in query:
            return admin_row
        return None

    db.fetch = AsyncMock(return_value=[])
    db.fetchrow = AsyncMock(side_effect=fetchrow)
    db.fetchval = AsyncMock(return_value=1)
    db.execute = AsyncMock(return_value="OK")
    return db


@pytest.fixture
def mock_salesforce():
    sf = AsyncMock()
    sf.query = AsyncMock(return_value={"records": []})
    sf.query_all = AsyncMock(return_value={"records": []})
    return sf


@pytest.fixture
def mock_client(mock_salesforce):
    client = MagicMock()
    client.salesforce = mock_salesforce
    client.services = {"salesforce": mock_salesforce}
    client._connected_services = {"salesforce"}
    client.connected_services = {"salesforce"}  # public alias — see conftest.py:326-333
    return client


@pytest.fixture
def authed_client(mock_client):
    app.dependency_overrides[get_current_user] = lambda: TEST_USER
    app.dependency_overrides[require_auth] = lambda: TEST_USER
    app.dependency_overrides[get_db] = lambda: _admin_db()
    # Routes import get_mcp_client / require_sf_mcp_client from dependencies (not main), so override both
    app.dependency_overrides[main_get_mcp_client] = lambda: mock_client
    app.dependency_overrides[deps_get_mcp_client] = lambda: mock_client
    app.dependency_overrides[main_require_sf_mcp_client] = lambda: mock_client
    app.dependency_overrides[deps_require_sf_mcp_client] = lambda: mock_client
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def reset_cache():
    from services.cache import cache
    cache.invalidate_prefix("stage_history")
    yield
    cache.invalidate_prefix("stage_history")


class TestStageHistoryOwnerId:
    """Stage history must include OwnerId so the funnel can filter by owner."""

    def test_stage_history_includes_owner_id_in_response(self, authed_client, mock_salesforce):
        mock_salesforce.query_all.return_value = {
            "records": [
                {
                    "OpportunityId": "006abcdef0000001",
                    "Opportunity": {
                        "Name": "Test Grant",
                        "Amount": 50000,
                        "StageName": "Qualifying",
                        "OwnerId": VALID_SF_USER_ID,
                    },
                    "OldValue": "Lead Gen",
                    "NewValue": "Qualifying",
                    "CreatedDate": "2026-04-01T10:00:00.000+0000",
                },
            ],
        }
        response = authed_client.get(
            "/api/salesforce/opportunities/stage-history", params={"days": 30}
        )
        assert response.status_code == 200
        records = response.json()
        assert len(records) == 1
        assert records[0]["OwnerId"] == VALID_SF_USER_ID
        # Sanity-check that the SOQL passed to query_all selects Opportunity.OwnerId
        call_args = mock_salesforce.query_all.call_args
        soql = call_args[0][0]
        assert "Opportunity.OwnerId" in soql

    def test_stage_history_handles_missing_owner_id(self, authed_client, mock_salesforce):
        """If a record's Opportunity has no OwnerId (defensive), response field is None."""
        mock_salesforce.query_all.return_value = {
            "records": [
                {
                    "OpportunityId": "006abcdef0000001",
                    "Opportunity": {"Name": "X", "Amount": 1000, "StageName": "Lead Gen"},
                    "OldValue": "New Lead",
                    "NewValue": "Lead Gen",
                    "CreatedDate": "2026-04-01T10:00:00.000+0000",
                },
            ],
        }
        response = authed_client.get(
            "/api/salesforce/opportunities/stage-history", params={"days": 7}
        )
        assert response.status_code == 200
        assert response.json()[0]["OwnerId"] is None


class TestPipelineAnalysisOwnerFilter:
    """POST /api/ai/pipeline-analysis with owner_ids must scope SOQL to those owners."""

    @patch("routes.ai.ANTHROPIC_API_KEY", "test-key")
    def test_owner_ids_filter_added_to_soql(self, authed_client, mock_salesforce):
        with patch("anthropic.Anthropic") as mock_anthropic:
            mock_msg = MagicMock()
            mock_msg.content = [MagicMock(text="analysis result")]
            mock_anthropic.return_value.messages.create.return_value = mock_msg

            mock_salesforce.query.return_value = {"records": [
                {"Id": VALID_SF_USER_ID, "Name": "Erica RM"},
            ]}
            mock_salesforce.query_all.return_value = {"records": []}

            response = authed_client.post(
                "/api/ai/pipeline-analysis",
                json={"days": 30, "owner_ids": [VALID_SF_USER_ID]},
            )
            assert response.status_code == 200
            body = response.json()
            assert body["owner_ids"] == [VALID_SF_USER_ID]
            assert "Erica RM" in body["owner_names"]

            # Verify SOQL filtering — both queries should have the WHERE OwnerId IN clause
            soql_calls = [c[0][0] for c in mock_salesforce.query_all.call_args_list]
            assert any(f"Opportunity.OwnerId IN ('{VALID_SF_USER_ID}')" in s for s in soql_calls)
            assert any(f"OwnerId IN ('{VALID_SF_USER_ID}')" in s and "IsClosed = false" in s for s in soql_calls)

    @patch("routes.ai.ANTHROPIC_API_KEY", "test-key")
    def test_no_owner_ids_means_team_wide(self, authed_client, mock_salesforce):
        with patch("anthropic.Anthropic") as mock_anthropic:
            mock_msg = MagicMock()
            mock_msg.content = [MagicMock(text="team analysis")]
            mock_anthropic.return_value.messages.create.return_value = mock_msg

            mock_salesforce.query_all.return_value = {"records": []}

            response = authed_client.post(
                "/api/ai/pipeline-analysis",
                json={"days": 30},
            )
            assert response.status_code == 200
            assert response.json()["owner_ids"] == []
            # No OwnerId filter in either SOQL
            soql_calls = [c[0][0] for c in mock_salesforce.query_all.call_args_list]
            assert not any("OwnerId IN" in s for s in soql_calls)

    @patch("routes.ai.ANTHROPIC_API_KEY", "test-key")
    def test_invalid_owner_id_returns_400(self, authed_client):
        response = authed_client.post(
            "/api/ai/pipeline-analysis",
            json={"days": 30, "owner_ids": ["notvalid"]},
        )
        assert response.status_code == 400

    @patch("routes.ai.ANTHROPIC_API_KEY", "test-key")
    def test_owner_ids_must_be_list(self, authed_client):
        response = authed_client.post(
            "/api/ai/pipeline-analysis",
            json={"days": 30, "owner_ids": "not-a-list"},
        )
        assert response.status_code == 400


class TestPipelineAnalysisDateRange:
    """POST /api/ai/pipeline-analysis accepts explicit start/end date range.

    start/end are mutually exclusive with days and must be YYYY-MM-DD strings
    bounded to the last 365 days. When provided, the SOQL history query uses
    a CreatedDate range literal instead of LAST_N_DAYS.
    """

    @staticmethod
    def _mock_anthropic(mock_anthropic, text="analysis result"):
        mock_msg = MagicMock()
        mock_msg.content = [MagicMock(text=text)]
        mock_anthropic.return_value.messages.create.return_value = mock_msg

    @patch("routes.ai.ANTHROPIC_API_KEY", "test-key")
    def test_custom_range_replaces_last_n_days_in_soql(
        self, authed_client, mock_salesforce
    ):
        with patch("anthropic.Anthropic") as mock_anthropic:
            self._mock_anthropic(mock_anthropic)
            mock_salesforce.query.return_value = {
                "records": [{"Id": VALID_SF_USER_ID, "Name": "Erica RM"}]
            }
            mock_salesforce.query_all.return_value = {"records": []}

            response = authed_client.post(
                "/api/ai/pipeline-analysis",
                json={
                    "start": "2026-01-01",
                    "end": "2026-02-01",
                    "owner_ids": [VALID_SF_USER_ID],
                },
            )
            assert response.status_code == 200
            body = response.json()
            assert body["start"] == "2026-01-01"
            assert body["end"] == "2026-02-01"
            # days is computed as inclusive day span (Jan 1..Feb 1 = 32 days)
            assert body["days"] == 32

            soql_calls = [c[0][0] for c in mock_salesforce.query_all.call_args_list]
            # History SOQL must use the explicit range, not LAST_N_DAYS
            history_soqls = [s for s in soql_calls if "OpportunityFieldHistory" in s]
            assert len(history_soqls) == 1
            history_soql = history_soqls[0]
            assert "CreatedDate >= 2026-01-01T00:00:00Z" in history_soql
            assert "CreatedDate <= 2026-02-01T23:59:59Z" in history_soql
            assert "LAST_N_DAYS" not in history_soql

    @patch("routes.ai.ANTHROPIC_API_KEY", "test-key")
    def test_custom_range_with_owner_filter_preserves_both(
        self, authed_client, mock_salesforce
    ):
        with patch("anthropic.Anthropic") as mock_anthropic:
            self._mock_anthropic(mock_anthropic)
            mock_salesforce.query.return_value = {
                "records": [{"Id": VALID_SF_USER_ID, "Name": "Erica RM"}]
            }
            mock_salesforce.query_all.return_value = {"records": []}

            response = authed_client.post(
                "/api/ai/pipeline-analysis",
                json={
                    "start": "2026-01-01",
                    "end": "2026-02-01",
                    "owner_ids": [VALID_SF_USER_ID],
                },
            )
            assert response.status_code == 200

            soql_calls = [c[0][0] for c in mock_salesforce.query_all.call_args_list]
            history_soqls = [s for s in soql_calls if "OpportunityFieldHistory" in s]
            snapshot_soqls = [s for s in soql_calls if "IsClosed = false" in s]
            assert len(history_soqls) == 1
            assert len(snapshot_soqls) == 1

            # History: both date range AND owner filter present
            history_soql = history_soqls[0]
            assert "CreatedDate >= 2026-01-01T00:00:00Z" in history_soql
            assert f"Opportunity.OwnerId IN ('{VALID_SF_USER_ID}')" in history_soql

            # Snapshot: owner filter present, but NO date clause (snapshot is
            # always "open pipeline right now", time-independent)
            snapshot_soql = snapshot_soqls[0]
            assert f"OwnerId IN ('{VALID_SF_USER_ID}')" in snapshot_soql
            assert "CreatedDate" not in snapshot_soql
            assert "LAST_N_DAYS" not in snapshot_soql

    @patch("routes.ai.ANTHROPIC_API_KEY", "test-key")
    def test_both_days_and_range_rejected(self, authed_client):
        response = authed_client.post(
            "/api/ai/pipeline-analysis",
            json={"days": 30, "start": "2026-01-01", "end": "2026-02-01"},
        )
        assert response.status_code == 400
        assert "both" in response.json()["detail"].lower()

    @patch("routes.ai.ANTHROPIC_API_KEY", "test-key")
    def test_start_without_end_rejected(self, authed_client):
        response = authed_client.post(
            "/api/ai/pipeline-analysis", json={"start": "2026-01-01"}
        )
        assert response.status_code == 400
        assert "together" in response.json()["detail"].lower()

    @patch("routes.ai.ANTHROPIC_API_KEY", "test-key")
    def test_end_without_start_rejected(self, authed_client):
        response = authed_client.post(
            "/api/ai/pipeline-analysis", json={"end": "2026-02-01"}
        )
        assert response.status_code == 400

    @patch("routes.ai.ANTHROPIC_API_KEY", "test-key")
    @pytest.mark.parametrize(
        "bad_start,bad_end",
        [
            ("01/01/2026", "02/01/2026"),         # wrong separator
            ("2026-1-1", "2026-2-1"),              # unpadded
            ("2026-01-01'; DROP--", "2026-02-01"), # injection attempt
            ("2026-01-01 OR 1=1", "2026-02-01"),   # injection attempt
            ("2026-13-01", "2026-13-01"),          # invalid month
            ("not-a-date", "still-not"),           # gibberish
            ("", ""),                               # empty strings
        ],
    )
    def test_bad_date_format_rejected(self, authed_client, bad_start, bad_end):
        response = authed_client.post(
            "/api/ai/pipeline-analysis",
            json={"start": bad_start, "end": bad_end},
        )
        assert response.status_code == 400

    @patch("routes.ai.ANTHROPIC_API_KEY", "test-key")
    def test_start_after_end_rejected(self, authed_client):
        response = authed_client.post(
            "/api/ai/pipeline-analysis",
            json={"start": "2026-02-01", "end": "2026-01-01"},
        )
        assert response.status_code == 400
        assert "on or before" in response.json()["detail"].lower()

    @patch("routes.ai.ANTHROPIC_API_KEY", "test-key")
    def test_range_older_than_365_days_rejected(self, authed_client):
        # Compute a start guaranteed to be > 365 days ago regardless of when
        # the test runs — picks the 400-day mark relative to today.
        old_start = (datetime.now(timezone.utc) - timedelta(days=400)).strftime(
            "%Y-%m-%d"
        )
        old_end = (datetime.now(timezone.utc) - timedelta(days=370)).strftime(
            "%Y-%m-%d"
        )
        response = authed_client.post(
            "/api/ai/pipeline-analysis",
            json={"start": old_start, "end": old_end},
        )
        assert response.status_code == 400
        assert "365" in response.json()["detail"]

    @patch("routes.ai.ANTHROPIC_API_KEY", "test-key")
    def test_future_end_rejected(self, authed_client):
        future_end = (datetime.now(timezone.utc) + timedelta(days=30)).strftime(
            "%Y-%m-%d"
        )
        response = authed_client.post(
            "/api/ai/pipeline-analysis",
            json={"start": "2026-01-01", "end": future_end},
        )
        assert response.status_code == 400
        assert "future" in response.json()["detail"].lower()

    @patch("routes.ai.ANTHROPIC_API_KEY", "test-key")
    def test_days_only_still_works(self, authed_client, mock_salesforce):
        """Backward-compat: days-only payloads keep using LAST_N_DAYS."""
        with patch("anthropic.Anthropic") as mock_anthropic:
            self._mock_anthropic(mock_anthropic)
            mock_salesforce.query_all.return_value = {"records": []}

            response = authed_client.post(
                "/api/ai/pipeline-analysis", json={"days": 30}
            )
            assert response.status_code == 200
            body = response.json()
            assert body["days"] == 30
            assert body["start"] is None
            assert body["end"] is None

            soql_calls = [c[0][0] for c in mock_salesforce.query_all.call_args_list]
            history_soqls = [s for s in soql_calls if "OpportunityFieldHistory" in s]
            assert len(history_soqls) == 1
            assert "LAST_N_DAYS:30" in history_soqls[0]
