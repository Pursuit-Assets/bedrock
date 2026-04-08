"""Tests for Wall of Progress endpoint additions:
- GET /api/salesforce/opportunities/stage-history now includes Opportunity.OwnerId
- POST /api/ai/pipeline-analysis accepts owner_ids and scopes the analysis
"""

import sys
import os
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from main import app, get_current_user, get_forecasting_engine, get_data_sync_service
from main import get_mcp_client as main_get_mcp_client
from dependencies import get_mcp_client as deps_get_mcp_client
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
    return client


@pytest.fixture
def authed_client(mock_client):
    app.dependency_overrides[get_current_user] = lambda: TEST_USER
    app.dependency_overrides[require_auth] = lambda: TEST_USER
    app.dependency_overrides[get_db] = lambda: _admin_db()
    # Routes import get_mcp_client from dependencies (not main), so override both
    app.dependency_overrides[main_get_mcp_client] = lambda: mock_client
    app.dependency_overrides[deps_get_mcp_client] = lambda: mock_client
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
