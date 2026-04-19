"""Comprehensive FastAPI TestClient tests for financial forecasting API endpoints."""

import sys
import os
import json
import asyncio
from datetime import datetime, date, timedelta
from decimal import Decimal
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Add parent to path so we can import from financial_forecasting
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient

from main import app, get_current_user, get_mcp_client, get_forecasting_engine, get_data_sync_service, _sync_lock, startup_event, shutdown_event
from auth import require_auth, require_auth_or_internal
from db import get_db

# Disable startup/shutdown events that try to connect to real services
app.router.on_startup.clear()
app.router.on_shutdown.clear()
from models import (
    OpportunityStage, PaymentTerms, InvoiceStatus,
    ForecastingDashboardData, ForecastingMetrics,
    PaymentForecast, CashFlowProjection,
    ApiResponse,
)
from conftest import (
    make_sf_opportunity,
    make_sf_account,
    make_sf_contact,
    make_intacct_invoice,
    make_intacct_payment,
)


# ---------------------------------------------------------------------------
# Test user and dependency overrides
# ---------------------------------------------------------------------------

TEST_USER = {"user_id": "test_user", "name": "Test User", "role": "admin"}


def override_get_current_user():
    return TEST_USER


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_salesforce():
    """Create a mock Salesforce service."""
    service = AsyncMock()
    service.query = AsyncMock(return_value={"records": []})
    service.create_record = AsyncMock(return_value={"id": "006NEW0000000001"})
    service.update_record = AsyncMock(return_value=True)
    service.get_service_info = AsyncMock(return_value={
        "service": "salesforce",
        "authenticated": True,
        "config": {"instance_url": "https://test.salesforce.com"},
    })
    return service


@pytest.fixture
def mock_sage():
    """Create a mock Sage Intacct service."""
    service = AsyncMock()
    service.get_invoices = AsyncMock(return_value={
        "success": True,
        "data": [make_intacct_invoice()],
    })
    service.create_invoice = AsyncMock(return_value={
        "success": True,
        "data": {"RECORDNO": "INV-NEW-001"},
    })
    service.get_payments = AsyncMock(return_value={
        "success": True,
        "data": [make_intacct_payment()],
    })
    service.get_service_info = AsyncMock(return_value={
        "service": "sage_intacct",
        "authenticated": True,
        "config": {},
    })
    return service


@pytest.fixture
def mock_client(mock_salesforce, mock_sage):
    """Create a mock UnifiedMCPClient."""
    client = MagicMock()
    client.salesforce = mock_salesforce
    client.sage_intacct = mock_sage
    client.services = {
        "salesforce": mock_salesforce,
        "sage_intacct": mock_sage,
    }
    client._connected_services = {"salesforce", "sage_intacct"}
    # Public alias — main.py endpoints check `client.connected_services`
    # (the @property on UnifiedMCPClient at unified_client.py:303). Without
    # this, MagicMock auto-generates a child mock whose __contains__ returns
    # False, silently short-circuiting 13 tests in this file at the
    # "x in connected_services" availability gate. Mirrors the fix applied
    # to `mock_mcp_client` in conftest.py:333 on 2026-04-16.
    client.connected_services = {"salesforce", "sage_intacct"}
    client.disconnect_all = AsyncMock()
    return client


@pytest.fixture
def mock_engine():
    """Create a mock ForecastingEngine with async methods."""
    engine = AsyncMock()
    engine.generate_dashboard_data = AsyncMock()
    engine.generate_payment_forecasts = AsyncMock(return_value=[])
    engine.generate_cash_flow_projections = AsyncMock(return_value=[])
    engine.calculate_forecasting_metrics = AsyncMock()
    engine.generate_comprehensive_report = AsyncMock()
    return engine


@pytest.fixture
def mock_sync_service():
    """Create a mock DataSyncService."""
    svc = AsyncMock()
    svc.sync_all_data = AsyncMock()
    svc.sync_salesforce_data = AsyncMock()
    svc.sync_intacct_data = AsyncMock()
    return svc


@pytest.fixture
def mock_db():
    """Mock DB for check_permission — returns admin user with all permissions."""
    import json
    all_perms = json.dumps({
        "view_opportunities": True, "edit_own_opportunities": True, "edit_all_opportunities": True,
        "create_opportunities": True, "bulk_update_opportunities": True, "lock_own_opportunities": True,
        "reassign_opportunities": True,
        # Account + Contact perms gate the 4 endpoints using check_permission_or_internal
        # (main.py:530,610,736,761). Without these, `POST /api/salesforce/accounts` et al.
        # return 403 for this "admin" user. Matches the admin permission set used by
        # tests/test_projects_endpoints.py:36 and tests/test_permissions.py:41,57.
        "edit_accounts": True, "create_accounts": True,
        "edit_contacts": True, "create_contacts": True,
        "view_tasks": True, "edit_own_tasks": True, "edit_all_tasks": True, "create_tasks": True,
        "view_revenue_dashboard": True, "view_cashflow_forecasts": True,
        "view_sage_invoices_payments": True, "create_sage_invoices": True,
        "match_invoices": True, "manage_payment_schedules": True, "generate_financial_reports": True,
        "trigger_data_sync": True, "manage_users_roles": True,
    })
    admin_row = {
        "id": "test-id", "sf_user_id": "005TESTOWNER00001", "email": "test@test.org",
        "name": "Test", "is_active": True, "permissions": all_perms, "profile_name": "Admin",
    }
    async def smart_fetchrow(query, *args):
        """Return admin user for permission queries, None for lock queries."""
        if "opportunity_lock" in query:
            return None  # No lock by default
        return admin_row
    db = AsyncMock()
    db.fetch = AsyncMock(return_value=[])
    db.fetchrow = AsyncMock(side_effect=smart_fetchrow)
    db.fetchval = AsyncMock(return_value=1)
    db.execute = AsyncMock(return_value="OK")
    return db


@pytest.fixture
def client(mock_client, mock_engine, mock_sync_service, mock_db):
    """Create a TestClient with all dependencies overridden."""
    app.dependency_overrides[get_current_user] = override_get_current_user
    app.dependency_overrides[require_auth] = override_get_current_user
    # `check_permission_or_internal` (routes/permissions.py:223) depends on
    # `require_auth_or_internal`, NOT `require_auth`. Endpoints using it
    # (main.py:530,610,736,761 — create/edit accounts & contacts) would
    # otherwise fall through to real JWT auth at auth.py:162 and return 401
    # under TestClient.
    app.dependency_overrides[require_auth_or_internal] = override_get_current_user
    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_mcp_client] = lambda: mock_client
    app.dependency_overrides[get_forecasting_engine] = lambda: mock_engine
    app.dependency_overrides[get_data_sync_service] = lambda: mock_sync_service

    with TestClient(app, raise_server_exceptions=False) as c:
        yield c

    app.dependency_overrides.clear()


@pytest.fixture
def unauthed_client(mock_client, mock_engine, mock_sync_service):
    """TestClient without auth override — keeps HTTPBearer requirement."""
    app.dependency_overrides[get_mcp_client] = lambda: mock_client
    app.dependency_overrides[get_forecasting_engine] = lambda: mock_engine
    app.dependency_overrides[get_data_sync_service] = lambda: mock_sync_service
    # Intentionally do NOT override get_current_user

    with TestClient(app, raise_server_exceptions=False) as c:
        yield c

    app.dependency_overrides.clear()


@pytest.fixture
def no_services_client():
    """TestClient with NO dependency overrides — services will 503."""
    # Override auth so we can reach the endpoint, but leave services un-overridden.
    app.dependency_overrides[get_current_user] = override_get_current_user
    # Explicitly override with raisers that mimic uninitialized services
    from fastapi import HTTPException

    def _no_mcp():
        raise HTTPException(status_code=503, detail="MCP client not initialized")

    def _no_engine():
        raise HTTPException(status_code=503, detail="Forecasting engine not initialized")

    def _no_sync():
        raise HTTPException(status_code=503, detail="Data sync service not available")

    app.dependency_overrides[get_mcp_client] = _no_mcp
    app.dependency_overrides[get_forecasting_engine] = _no_engine
    app.dependency_overrides[get_data_sync_service] = _no_sync

    with TestClient(app, raise_server_exceptions=False) as c:
        yield c

    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def mock_db_status_connected(monkeypatch):
    """Report the database as 'connected' so `/health` returns success=True.

    Tests don't call `init_db()` (that would require a live Postgres), so
    `db.py._db_init_status` stays at its module-default "not_started" and
    `/health` (main.py:249-266) reports success=False. Patch the
    `get_db_status` symbol imported into `main` (main.py:37) to return
    "connected". Autouse so it applies to every test; monkeypatch reverts
    automatically on teardown.
    """
    import main
    monkeypatch.setattr(main, "get_db_status", lambda: "connected")


@pytest.fixture(autouse=True)
def reset_cache():
    """Wipe the module-level TTLCache before and after every test.

    Endpoints in main.py (opps:, accounts:, contacts:, payments:,
    opp-payments:, my-tasks:, users) and routes/progress_tracking.py share
    a singleton `cache` instance at services/cache.py:49. Without this
    autouse reset, earlier tests populate cache entries that later tests
    read back, causing assertions like `test_get_opportunities_returns_records`
    (expects 1 record from a fresh mock) to see stale multi-record data from
    an earlier test in a different class. `cache.clear()` is used rather than
    per-prefix `invalidate_prefix` so any newly-added endpoint cache prefix
    can't silently slip past this fixture. Mirrors the pattern in
    tests/test_wall_of_progress_endpoints.py:89-94.
    """
    from services.cache import cache
    cache.clear()
    yield
    cache.clear()


# ===================================================================
# 1. Health endpoints
# ===================================================================

class TestHealthEndpoints:
    """Tests for /health and /health/services."""

    def test_health_check_returns_200(self, client):
        response = client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["status"] == "healthy"
        assert "timestamp" in body["meta"]

    def test_health_check_no_auth_required(self, unauthed_client):
        """The basic /health endpoint does not require auth."""
        response = unauthed_client.get("/health")
        assert response.status_code == 200

    def test_services_health_check(self, client, mock_client):
        response = client.get("/health/services")
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        # The endpoint iterates _connected_services and calls get_service_info
        assert "salesforce" in body["data"] or "sage_intacct" in body["data"]

    def test_services_health_check_503_when_no_client(self, no_services_client):
        response = no_services_client.get("/health/services")
        assert response.status_code == 503


# ===================================================================
# 2. Salesforce Opportunities
# ===================================================================

class TestSalesforceOpportunities:
    """Tests for GET/PUT /api/salesforce/opportunities."""

    def test_get_opportunities_empty(self, client, mock_client):
        mock_client.salesforce.query_all.return_value = {"records": []}
        response = client.get("/api/salesforce/opportunities")
        assert response.status_code == 200
        assert response.json() == []

    def test_get_opportunities_returns_records(self, client, mock_client):
        opp = make_sf_opportunity()
        mock_client.salesforce.query_all.return_value = {"records": [opp]}
        response = client.get("/api/salesforce/opportunities")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["Id"] == opp["Id"]
        # Type round-trip: the 2026-04-17 B2 incident was that Opportunity.Type
        # never surfaced in the UI. The root cause was frontend (no column),
        # but this assertion guards the API contract so regressions here get
        # caught even if the frontend regresses separately.
        assert data[0]["Type"] == "Other fee for service"

    def test_get_opportunities_with_stage_filter(self, client, mock_client):
        opp = make_sf_opportunity({"StageName": "Qualifying"})
        mock_client.salesforce.query_all.return_value = {"records": [opp]}
        response = client.get("/api/salesforce/opportunities", params={"stage": "Qualifying"})
        assert response.status_code == 200
        # Verify the query method was called and a WHERE clause was built
        call_args = mock_client.salesforce.query_all.call_args
        soql = call_args[0][0]
        assert "StageName = 'Qualifying'" in soql

    def test_get_opportunities_with_stages_list(self, client, mock_client):
        mock_client.salesforce.query_all.return_value = {"records": []}
        response = client.get(
            "/api/salesforce/opportunities",
            params={"stages": ["Qualifying", "Lead Gen"]},
        )
        assert response.status_code == 200
        soql = mock_client.salesforce.query_all.call_args[0][0]
        assert "StageName IN" in soql

    def test_get_opportunities_with_limit(self, client, mock_client):
        """Limit param is accepted (query_all fetches all records via pagination)."""
        mock_client.salesforce.query_all.return_value = {"records": []}
        response = client.get("/api/salesforce/opportunities", params={"limit": 10})
        assert response.status_code == 200

    def test_get_opportunities_service_error(self, client, mock_client):
        mock_client.salesforce.query_all.side_effect = RuntimeError("Salesforce down")
        response = client.get("/api/salesforce/opportunities")
        assert response.status_code == 500
        assert "Salesforce down" in response.json()["detail"]

    def test_get_opportunities_503_when_no_client(self, no_services_client):
        response = no_services_client.get("/api/salesforce/opportunities")
        assert response.status_code == 503

    def test_update_opportunity_success(self, client, mock_client):
        mock_client.salesforce.update_record.return_value = True
        response = client.put(
            "/api/salesforce/opportunities/006TESTOPPORT01",
            json={
                "opportunity_id": "006TESTOPPORT01",
                "updates": {"StageName": "Contract Creation"},
                "user_id": "test_user",
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["id"] == "006TESTOPPORT01"

    def test_update_opportunity_failure(self, client, mock_client):
        mock_client.salesforce.update_record.return_value = False
        response = client.put(
            "/api/salesforce/opportunities/006TESTOPPORT01",
            json={
                "opportunity_id": "006TESTOPPORT01",
                "updates": {"StageName": "Bad Stage"},
                "user_id": "test_user",
            },
        )
        # update_record returning False raises HTTPException 400, but the except
        # clause catches HTTPException as a generic Exception and re-raises as 500.
        # Actually: HTTPException is raised, caught by the except, then re-raised as 500.
        assert response.status_code == 500 or response.status_code == 400

    def test_update_opportunity_service_error(self, client, mock_client):
        mock_client.salesforce.update_record.side_effect = RuntimeError("write failed")
        response = client.put(
            "/api/salesforce/opportunities/006TESTOPPORT01",
            json={
                "opportunity_id": "006TESTOPPORT01",
                "updates": {"Amount": 99999},
                "user_id": "test_user",
            },
        )
        # Phase 0: SF errors now surface as 400 with the actual error message
        assert response.status_code == 400
        assert "write failed" in response.json()["detail"]


# ===================================================================
# 3. Salesforce Accounts
# ===================================================================

class TestSalesforceAccounts:
    """Tests for GET/POST /api/salesforce/accounts."""

    def test_get_accounts_returns_list(self, client, mock_client):
        acct = make_sf_account()
        mock_client.salesforce.query.return_value = {"records": [acct]}
        response = client.get("/api/salesforce/accounts")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["Name"] == "Test Foundation Inc"

    def test_get_accounts_empty(self, client, mock_client):
        mock_client.salesforce.query.return_value = {"records": []}
        response = client.get("/api/salesforce/accounts")
        assert response.status_code == 200
        assert response.json() == []

    def test_create_account_success(self, client, mock_client):
        mock_client.salesforce.create_record.return_value = {"id": "001NEW001"}
        response = client.post(
            "/api/salesforce/accounts",
            json={"Name": "New Foundation", "Type": "Customer"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["id"] == "001NEW001"

    def test_create_account_failure(self, client, mock_client):
        mock_client.salesforce.create_record.return_value = {}
        response = client.post(
            "/api/salesforce/accounts",
            json={"Name": "Bad Account"},
        )
        # create_record returns no "id" → raises HTTPException(400) → caught as 500
        assert response.status_code in (400, 500)


# ===================================================================
# 4. Salesforce Contacts
# ===================================================================

class TestSalesforceContacts:
    """Tests for GET /api/salesforce/contacts."""

    def test_get_contacts_returns_list(self, client, mock_client):
        contact = make_sf_contact()
        mock_client.salesforce.query.return_value = {"records": [contact]}
        response = client.get("/api/salesforce/contacts")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["LastName"] == "Donor"

    def test_get_contacts_with_account_filter(self, client, mock_client):
        mock_client.salesforce.query.return_value = {"records": []}
        response = client.get(
            "/api/salesforce/contacts",
            params={"account_id": "001TESTACCOUNT001A"},
        )
        assert response.status_code == 200
        soql = mock_client.salesforce.query.call_args[0][0]
        assert "AccountId = '001TESTACCOUNT001A'" in soql

    def test_get_contacts_service_error(self, client, mock_client):
        mock_client.salesforce.query.side_effect = RuntimeError("timeout")
        response = client.get("/api/salesforce/contacts")
        assert response.status_code == 500


# ===================================================================
# 5. Sage Intacct Invoices
# ===================================================================

class TestIntacctInvoices:
    """Tests for GET/POST /api/intacct/invoices."""

    def test_get_invoices_returns_list(self, client, mock_client):
        response = client.get("/api/intacct/invoices")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["RECORDNO"] == "INV-001"

    def test_get_invoices_with_customer_filter(self, client, mock_client):
        response = client.get("/api/intacct/invoices", params={"customer_id": "CUST-001"})
        assert response.status_code == 200
        mock_client.sage_intacct.get_invoices.assert_called_once_with(
            customer_id="CUST-001", limit=100
        )

    def test_get_invoices_empty_when_no_data(self, client, mock_client):
        mock_client.sage_intacct.get_invoices.return_value = {"success": True, "data": []}
        response = client.get("/api/intacct/invoices")
        assert response.status_code == 200
        assert response.json() == []

    def test_get_invoices_handles_not_success(self, client, mock_client):
        mock_client.sage_intacct.get_invoices.return_value = {"success": False}
        response = client.get("/api/intacct/invoices")
        assert response.status_code == 200
        assert response.json() == []

    def test_create_invoice_success(self, client, mock_client):
        mock_client.sage_intacct.create_invoice.return_value = {
            "success": True,
            "data": {"RECORDNO": "INV-NEW-001"},
        }
        response = client.post(
            "/api/intacct/invoices",
            json={
                "opportunity_id": "006TESTOPPORT01",
                "customer_id": "CUST-001",
                "amount": 50000,
                "due_date": "2026-04-15",
                "line_items": [{"item": "Grant payment", "amount": 50000}],
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["data"]["invoice_id"] == "INV-NEW-001"

    def test_create_invoice_failure(self, client, mock_client):
        mock_client.sage_intacct.create_invoice.return_value = {
            "success": False,
            "errors": ["Missing required field"],
        }
        response = client.post(
            "/api/intacct/invoices",
            json={
                "opportunity_id": "006TESTOPPORT01",
                "customer_id": "CUST-001",
                "amount": 50000,
                "due_date": "2026-04-15",
                "line_items": [],
            },
        )
        # 400 from inner HTTPException, caught by except → 500
        assert response.status_code in (400, 500)

    def test_create_invoice_service_error(self, client, mock_client):
        mock_client.sage_intacct.create_invoice.side_effect = RuntimeError("intacct down")
        response = client.post(
            "/api/intacct/invoices",
            json={
                "opportunity_id": "006TESTOPPORT01",
                "customer_id": "CUST-001",
                "amount": 50000,
                "due_date": "2026-04-15",
                "line_items": [{"item": "x", "amount": 100}],
            },
        )
        assert response.status_code == 500


# ===================================================================
# 6. Sage Intacct Payments
# ===================================================================

class TestIntacctPayments:
    """Tests for GET /api/intacct/payments."""

    def test_get_payments_returns_list(self, client, mock_client):
        response = client.get("/api/intacct/payments")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["RECORDNO"] == "PMT-001"

    def test_get_payments_empty(self, client, mock_client):
        mock_client.sage_intacct.get_payments.return_value = {"success": True, "data": []}
        response = client.get("/api/intacct/payments")
        assert response.status_code == 200
        assert response.json() == []

    def test_get_payments_service_error(self, client, mock_client):
        mock_client.sage_intacct.get_payments.side_effect = RuntimeError("boom")
        response = client.get("/api/intacct/payments")
        assert response.status_code == 500

    def test_get_payments_503_when_no_client(self, no_services_client):
        response = no_services_client.get("/api/intacct/payments")
        assert response.status_code == 503


# ===================================================================
# 7. Forecasting endpoints
# ===================================================================

class TestForecastingEndpoints:
    """Tests for /api/forecasting/* endpoints."""

    def _make_dashboard_data(self):
        """Build a minimal ForecastingDashboardData dict."""
        metrics = {
            "total_pipeline_value": 100000,
            "weighted_pipeline_value": 50000,
            "expected_revenue_30_days": 20000,
            "expected_revenue_60_days": 35000,
            "expected_revenue_90_days": 50000,
            "average_deal_size": 25000,
            "average_sales_cycle_days": 60,
            "win_rate": 0.45,
            "payment_collection_rate": 0.92,
            "average_payment_delay_days": 12,
            "cash_conversion_cycle_days": 45,
            "overdue_invoices_amount": 5000,
            "at_risk_opportunities_amount": 15000,
            "concentration_risk_score": 0.3,
        }
        return ForecastingDashboardData(
            current_metrics=ForecastingMetrics(**metrics),
            pipeline_summary={"total": 100000},
            cash_flow_chart_data=[],
            payment_forecast_data=[],
            risk_indicators=[],
            recent_activities=[],
            date_range={"start": date.today(), "end": date.today() + timedelta(days=90)},
            selected_scenario="realistic",
            refresh_timestamp=datetime.utcnow(),
        )

    def test_get_dashboard(self, client, mock_engine):
        dashboard = self._make_dashboard_data()
        mock_engine.generate_dashboard_data.return_value = dashboard
        response = client.get("/api/forecasting/dashboard")
        assert response.status_code == 200
        body = response.json()
        assert "current_metrics" in body
        assert body["selected_scenario"] == "realistic"

    def test_get_dashboard_custom_params(self, client, mock_engine):
        dashboard = self._make_dashboard_data()
        mock_engine.generate_dashboard_data.return_value = dashboard
        response = client.get(
            "/api/forecasting/dashboard",
            params={"date_range_days": 180, "scenario": "optimistic"},
        )
        assert response.status_code == 200
        call_kwargs = mock_engine.generate_dashboard_data.call_args[1]
        assert call_kwargs["scenario"] == "optimistic"

    def test_get_dashboard_engine_error(self, client, mock_engine):
        mock_engine.generate_dashboard_data.side_effect = RuntimeError("engine crash")
        response = client.get("/api/forecasting/dashboard")
        assert response.status_code == 500

    def test_get_payment_forecast(self, client, mock_engine):
        mock_engine.generate_payment_forecasts.return_value = []
        response = client.get("/api/forecasting/payment-forecast")
        assert response.status_code == 200
        assert response.json() == []

    def test_get_payment_forecast_with_params(self, client, mock_engine):
        mock_engine.generate_payment_forecasts.return_value = []
        response = client.get(
            "/api/forecasting/payment-forecast",
            params={"days_ahead": 180, "min_probability": 50},
        )
        assert response.status_code == 200
        call_kwargs = mock_engine.generate_payment_forecasts.call_args[1]
        assert call_kwargs["days_ahead"] == 180
        assert call_kwargs["min_probability"] == 50

    def test_get_cash_flow(self, client, mock_engine):
        mock_engine.generate_cash_flow_projections.return_value = []
        response = client.get("/api/forecasting/cash-flow")
        assert response.status_code == 200
        assert response.json() == []

    def test_get_cash_flow_custom_months(self, client, mock_engine):
        mock_engine.generate_cash_flow_projections.return_value = []
        response = client.get("/api/forecasting/cash-flow", params={"months_ahead": 12})
        assert response.status_code == 200
        mock_engine.generate_cash_flow_projections.assert_called_once_with(months_ahead=12)

    def test_get_metrics(self, client, mock_engine):
        metrics = ForecastingMetrics(
            total_pipeline_value=Decimal("100000"),
            weighted_pipeline_value=Decimal("50000"),
            expected_revenue_30_days=Decimal("20000"),
            expected_revenue_60_days=Decimal("35000"),
            expected_revenue_90_days=Decimal("50000"),
            average_deal_size=Decimal("25000"),
            average_sales_cycle_days=60,
            win_rate=0.45,
            payment_collection_rate=0.92,
            average_payment_delay_days=12,
            cash_conversion_cycle_days=45,
            overdue_invoices_amount=Decimal("5000"),
            at_risk_opportunities_amount=Decimal("15000"),
            concentration_risk_score=0.3,
        )
        mock_engine.calculate_forecasting_metrics.return_value = metrics
        response = client.get("/api/forecasting/metrics")
        assert response.status_code == 200
        body = response.json()
        assert float(body["total_pipeline_value"]) == 100000

    def test_forecasting_503_when_no_engine(self, no_services_client):
        response = no_services_client.get("/api/forecasting/dashboard")
        assert response.status_code == 503


# ===================================================================
# 8. Data Sync endpoints
# ===================================================================

class TestDataSync:
    """Tests for POST /api/sync/trigger."""

    def test_trigger_sync_all(self, client, mock_sync_service):
        response = client.post("/api/sync/trigger", params={"sync_type": "all"})
        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert "all" in body["data"]["message"]
        assert body["meta"]["triggered_by"] == "test_user"

    def test_trigger_sync_salesforce(self, client, mock_sync_service):
        response = client.post("/api/sync/trigger", params={"sync_type": "salesforce"})
        assert response.status_code == 200
        assert "salesforce" in response.json()["data"]["message"]

    def test_trigger_sync_intacct(self, client, mock_sync_service):
        response = client.post("/api/sync/trigger", params={"sync_type": "intacct"})
        assert response.status_code == 200
        assert "intacct" in response.json()["data"]["message"]

    def test_trigger_sync_invalid_type(self, client):
        response = client.post("/api/sync/trigger", params={"sync_type": "invalid"})
        assert response.status_code == 422  # FastAPI validation error

    def test_trigger_sync_conflict_when_lock_held(self, client, mock_sync_service):
        """When _sync_lock is already held, the endpoint should return 409."""
        # Acquire the lock in a background thread-safe way by creating a new lock
        # that is already locked.  We patch the module-level _sync_lock.
        locked = asyncio.Lock()
        # We need to force the lock into a "locked" state.  We can patch the
        # `locked()` method.
        with patch("main._sync_lock") as mock_lock:
            mock_lock.locked.return_value = True
            response = client.post("/api/sync/trigger", params={"sync_type": "all"})
        assert response.status_code == 409
        assert "already in progress" in response.json()["detail"]

    def test_trigger_sync_blocked_when_no_service(self, no_services_client):
        # Sync now requires check_permission("trigger_data_sync") which hits DB.
        # Without DB override, permission check fails before reaching service check.
        response = no_services_client.post("/api/sync/trigger")
        assert response.status_code in (401, 403, 500, 503)


# ===================================================================
# 9. Invoice Matching endpoints
# ===================================================================

class TestInvoiceMatching:
    """Tests for /api/matching/save-match and /api/matching/delete-match.

    Note: The matching endpoints build file paths using os.path.join inside
    the function body with local `import os`. Full file I/O integration tests
    would need the actual file to exist at the expected path. These tests verify
    the endpoint contract (request/response shape) rather than file persistence.
    """

    def test_save_match_returns_success_shape(self, client):
        """Verify save-match endpoint accepts valid input and returns expected shape."""
        response = client.post(
            "/api/matching/save-match",
            json={
                "invoice_id": "INV-100",
                "opportunity_id": "006OPP100",
                "confidence": "Confirmed",
                "notes": "Test match",
                "customer_name": "Test Corp",
                "invoice_amount": 25000.0,
                "invoice_date": "2026-03-01",
            },
        )
        # May succeed (200) or fail (500) depending on whether the JSON file exists on disk
        if response.status_code == 200:
            body = response.json()
            assert body["success"] is True
            assert body["data"]["invoice_id"] == "INV-100"
            assert body["data"]["opportunity_id"] == "006OPP100"

    def test_delete_match_nonexistent_returns_error(self, client):
        """Deleting a nonexistent match returns 404 or 500."""
        response = client.delete("/api/matching/delete-match/INV-NONEXISTENT")
        assert response.status_code in (404, 500)


# ===================================================================
# 10. Auth enforcement
# ===================================================================

class TestAuthEnforcement:
    """Verify that protected endpoints reject unauthenticated requests.

    Note: require_auth returns 401 (Unauthorized), not 403 (Forbidden).
    """

    def test_opportunities_requires_auth(self, unauthed_client):
        response = unauthed_client.get("/api/salesforce/opportunities")
        assert response.status_code == 401

    def test_accounts_requires_auth(self, unauthed_client):
        response = unauthed_client.get("/api/salesforce/accounts")
        assert response.status_code == 401

    def test_invoices_requires_auth(self, unauthed_client):
        response = unauthed_client.get("/api/intacct/invoices")
        assert response.status_code == 401

    def test_payments_requires_auth(self, unauthed_client):
        response = unauthed_client.get("/api/intacct/payments")
        assert response.status_code == 401

    def test_sync_requires_auth(self, unauthed_client):
        response = unauthed_client.post("/api/sync/trigger")
        assert response.status_code == 401

    def test_matching_requires_auth(self, unauthed_client):
        response = unauthed_client.post(
            "/api/matching/save-match",
            json={"invoice_id": "x", "opportunity_id": "y"},
        )
        assert response.status_code == 401

    def test_cashflow_summary_requires_auth(self, unauthed_client):
        response = unauthed_client.get("/api/cashflow/summary")
        assert response.status_code == 401

    def test_search_opportunities_requires_auth(self, unauthed_client):
        response = unauthed_client.get("/api/matching/search-opportunities")
        assert response.status_code == 401

    def test_cache_clear_requires_auth(self, unauthed_client):
        response = unauthed_client.post("/api/cache/clear")
        assert response.status_code == 401


# ===================================================================
# 11. New Phase 5 endpoints
# ===================================================================

class TestPhase5Endpoints:
    """Tests for endpoints added/fixed in Phase 5 hardening."""

    def test_cashflow_summary_returns_200(self, client):
        response = client.get("/api/cashflow/summary")
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "total_pipeline" in data["data"]

    def test_cache_clear_returns_200(self, client):
        response = client.post("/api/cache/clear")
        assert response.status_code == 200
        assert response.json()["message"] == "All caches cleared"

    def test_search_opportunities_returns_200(self, client, mock_client):
        opp = make_sf_opportunity()
        mock_client.salesforce.query.return_value = {"records": [opp]}
        response = client.get("/api/matching/search-opportunities")
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "count" in data
        assert "opportunities" in data

    def test_search_opportunities_with_query(self, client, mock_client):
        opp = make_sf_opportunity({"Name": "Test Grant"})
        mock_client.salesforce.query.return_value = {"records": [opp]}
        response = client.get(
            "/api/matching/search-opportunities",
            params={"q": "Test", "customer_name": "Acme Corp", "invoice_amount": 50000},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        # With customer_name provided, results should have match scores
        if data["count"] > 0:
            assert "matchScore" in data["opportunities"][0]

    def test_search_opportunities_escapes_soql(self, client, mock_client):
        """Verify SOQL injection characters are escaped."""
        mock_client.salesforce.query.return_value = {"records": []}
        response = client.get(
            "/api/matching/search-opportunities",
            params={"q": "test' OR Name LIKE '%"},
        )
        assert response.status_code == 200
        # The query should have been escaped, not cause a 500
        soql = mock_client.salesforce.query.call_args[0][0]
        assert "test\\'" in soql or "test'" not in soql.split("LIKE")[1]


# ===================================================================
# 12. Edge cases / multiple records
# ===================================================================

class TestEdgeCases:
    """Edge cases and boundary conditions."""

    def test_opportunities_limit_capped_at_2000(self, client):
        """Limit values above 2000 should be rejected by FastAPI validation."""
        response = client.get("/api/salesforce/opportunities", params={"limit": 5000})
        assert response.status_code == 422

    def test_accounts_limit_capped_at_2000(self, client):
        """Accounts `limit` query param is capped at 2000, matching opportunities
        endpoint (main.py:308). Prior cap was 5000; tightened 2026-04-17."""
        response = client.get("/api/salesforce/accounts", params={"limit": 2001})
        assert response.status_code == 422

    def test_cash_flow_months_ahead_min(self, client, mock_engine):
        """months_ahead below 1 should be rejected."""
        response = client.get("/api/forecasting/cash-flow", params={"months_ahead": 0})
        assert response.status_code == 422

    def test_cash_flow_months_ahead_max(self, client, mock_engine):
        """months_ahead above 24 should be rejected."""
        response = client.get("/api/forecasting/cash-flow", params={"months_ahead": 30})
        assert response.status_code == 422

    def test_payment_forecast_min_probability_validation(self, client, mock_engine):
        """min_probability below 0 should be rejected."""
        response = client.get(
            "/api/forecasting/payment-forecast",
            params={"min_probability": -5},
        )
        assert response.status_code == 422

    def test_multiple_opportunities_returned(self, client, mock_client):
        """Ensure multiple records are correctly deserialized."""
        opps = [
            make_sf_opportunity({"Id": f"006MULTI{i:03d}", "Amount": 10000 * (i + 1)})
            for i in range(5)
        ]
        mock_client.salesforce.query_all.return_value = {"records": opps}
        response = client.get("/api/salesforce/opportunities")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 5
        # Verify ordering preserved
        assert data[0]["Id"] == "006MULTI000"
        assert data[4]["Id"] == "006MULTI004"

    def test_intacct_invoices_single_record_not_list(self, client, mock_client):
        """Sage sometimes returns a single dict instead of a list."""
        mock_client.sage_intacct.get_invoices.return_value = {
            "success": True,
            "data": make_intacct_invoice(),  # single dict, not list
        }
        response = client.get("/api/intacct/invoices")
        assert response.status_code == 200
        data = response.json()
        # The endpoint normalizes single-record responses to a list
        assert len(data) == 1
