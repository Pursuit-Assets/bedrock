"""Full data sync cycle integration tests with mocked SF + Sage clients.

Exercises the DataSyncService through complete workflows:
  - sync_all_data (customer mapping -> invoicing -> payment update)
  - sync_customer_mappings (name matching, new customer creation)
  - sync_opportunity_invoicing (Closed Won -> Intacct invoice)
  - process_opportunity_for_invoicing (invoice creation + SF update)
  - update_payment_statuses (Paid, Partial, Pending states)
  - sync_customer_data_to_salesforce (financial data sync back)
  - Error handling: Intacct failures don't crash full sync
  - Sync history tracking

All async methods use mocked MCP clients from conftest.
"""

import sys
import os
from datetime import datetime, date, timedelta
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, call

import pytest

# Add parent to path so we can import from financial_forecasting
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from data_sync import DataSyncService
from models import OpportunityStage
from conftest import (
    make_sf_opportunity, make_sf_account, make_intacct_invoice,
    make_intacct_payment, make_intacct_customer,
)


@pytest.fixture(autouse=True)
def _enable_intacct_auto_invoice(monkeypatch):
    """These integration tests exercise the live Intacct invoice paths — flip
    the kill switch on for the file's duration. Production default is off
    (data_sync._intacct_auto_invoice_enabled reads the env var at call time).
    Individual tests can override via their own monkeypatch.setenv/delenv
    call (later calls win within the same fixture lifecycle)."""
    monkeypatch.setenv("INTACCT_AUTO_INVOICE_ENABLED", "true")


# ===========================================================================
# 1. Full sync cycle: customer mapping -> invoicing -> payment update
# ===========================================================================
class TestFullSyncCycle:

    @pytest.mark.asyncio
    async def test_sync_all_data_calls_all_three_phases(self, data_sync_service, mock_mcp_client):
        """sync_all_data should call sync_customer_mappings, sync_opportunity_invoicing,
        and update_payment_statuses in order."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        # Set up mocks for each phase to succeed with minimal data
        sf.query = AsyncMock(return_value={"records": []})
        intacct.get_customers = AsyncMock(return_value={"success": True, "data": []})
        intacct.get_payments = AsyncMock(return_value={"success": True, "data": []})
        intacct.get_invoices = AsyncMock(return_value={"success": True, "data": []})

        await data_sync_service.sync_all_data()

        # Verify SF was queried (at least for accounts, opps, and payment statuses)
        assert sf.query.call_count >= 3

    @pytest.mark.asyncio
    async def test_sync_all_data_records_completed_history(self, data_sync_service, mock_mcp_client):
        """Successful full sync should record a 'completed' entry in sync_history."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]
        sf.query = AsyncMock(return_value={"records": []})
        intacct.get_customers = AsyncMock(return_value={"success": True, "data": []})
        intacct.get_payments = AsyncMock(return_value={"success": True, "data": []})
        intacct.get_invoices = AsyncMock(return_value={"success": True, "data": []})

        await data_sync_service.sync_all_data()

        history = data_sync_service.get_sync_history()
        assert len(history) == 1
        assert history[0]["type"] == "full_sync"
        assert history[0]["status"] == "completed"

    @pytest.mark.asyncio
    async def test_sync_all_data_records_failed_history_on_error(
        self, data_sync_service, mock_mcp_client
    ):
        """If sync_all_data fails, it should record a 'failed' entry and re-raise."""
        sf = mock_mcp_client.services["salesforce"]
        sf.query = AsyncMock(side_effect=Exception("Network timeout"))

        with pytest.raises(Exception, match="Network timeout"):
            await data_sync_service.sync_all_data()

        history = data_sync_service.get_sync_history()
        assert len(history) == 1
        assert history[0]["status"] == "failed"
        assert "Network timeout" in history[0]["error"]


# ===========================================================================
# 2. Customer mapping: existing mapping preserved, name match, new customer
# ===========================================================================
class TestCustomerMapping:

    @pytest.mark.asyncio
    async def test_existing_intacct_id_preserved(self, data_sync_service, mock_mcp_client):
        """Accounts with an existing Intacct_Customer_ID__c should be preserved."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        account = make_sf_account({
            "Id": "001EXISTING01",
            "Name": "Already Mapped Corp",
            "Intacct_Customer_ID__c": "CUST-EXISTING",
        })
        sf.query = AsyncMock(return_value={"records": [account]})
        intacct.get_customers = AsyncMock(return_value={"success": True, "data": []})

        await data_sync_service.sync_customer_mappings()

        assert data_sync_service.customer_mappings["001EXISTING01"] == "CUST-EXISTING"
        # Should not update SF since mapping already exists
        sf.update_record.assert_not_called()

    @pytest.mark.asyncio
    async def test_name_match_creates_mapping(self, data_sync_service, mock_mcp_client):
        """Unmatched SF account should be matched to Intacct customer by name."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        account = make_sf_account({
            "Id": "001NAMEMATCH",
            "Name": "Test Foundation Inc",
            "Intacct_Customer_ID__c": None,
        })
        customer = make_intacct_customer({
            "CUSTOMERID": "CUST-MATCHED",
            "NAME": "Test Foundation Inc",
        })

        sf.query = AsyncMock(return_value={"records": [account]})
        intacct.get_customers = AsyncMock(return_value={"success": True, "data": [customer]})
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.sync_customer_mappings()

        # Mapping should be created
        assert data_sync_service.customer_mappings["001NAMEMATCH"] == "CUST-MATCHED"
        # SF should be updated with the Intacct customer ID
        sf.update_record.assert_called_with(
            "Account",
            "001NAMEMATCH",
            {"Intacct_Customer_ID__c": "CUST-MATCHED"},
        )

    @pytest.mark.asyncio
    async def test_case_insensitive_name_match(self, data_sync_service, mock_mcp_client):
        """Name matching should be case-insensitive."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        account = make_sf_account({
            "Id": "001CASETEST",
            "Name": "PURSUIT FOUNDATION",
            "Intacct_Customer_ID__c": None,
        })
        customer = make_intacct_customer({
            "CUSTOMERID": "CUST-CASE",
            "NAME": "pursuit foundation",
        })

        sf.query = AsyncMock(return_value={"records": [account]})
        intacct.get_customers = AsyncMock(return_value={"success": True, "data": [customer]})
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.sync_customer_mappings()

        assert data_sync_service.customer_mappings["001CASETEST"] == "CUST-CASE"

    @pytest.mark.asyncio
    async def test_unmatched_account_creates_new_intacct_customer(
        self, data_sync_service, mock_mcp_client
    ):
        """Accounts with no name match should trigger new Intacct customer creation."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        account = make_sf_account({
            "Id": "001NEWCUST01",
            "Name": "Brand New Donor Inc",
            "Intacct_Customer_ID__c": None,
        })
        sf.query = AsyncMock(return_value={"records": [account]})
        intacct.get_customers = AsyncMock(return_value={"success": True, "data": []})
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.sync_customer_mappings()

        # A new customer ID should be generated and mapped
        assert "001NEWCUST01" in data_sync_service.customer_mappings
        new_id = data_sync_service.customer_mappings["001NEWCUST01"]
        # ID format: SF_<first 8 chars of SF account ID>
        assert new_id.startswith("SF_")

    @pytest.mark.asyncio
    async def test_multiple_accounts_mixed_mapping(self, data_sync_service, mock_mcp_client):
        """Test a mix of existing, matched, and new accounts."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        accounts = [
            make_sf_account({
                "Id": "001EXISTS01",
                "Name": "Existing Corp",
                "Intacct_Customer_ID__c": "CUST-001",
            }),
            make_sf_account({
                "Id": "001MATCH001",
                "Name": "Match Corp",
                "Intacct_Customer_ID__c": None,
            }),
            make_sf_account({
                "Id": "001NEWONE01",
                "Name": "New Corp",
                "Intacct_Customer_ID__c": None,
            }),
        ]
        customers = [
            make_intacct_customer({"CUSTOMERID": "CUST-MATCH", "NAME": "Match Corp"}),
        ]

        sf.query = AsyncMock(return_value={"records": accounts})
        intacct.get_customers = AsyncMock(return_value={"success": True, "data": customers})
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.sync_customer_mappings()

        assert data_sync_service.customer_mappings["001EXISTS01"] == "CUST-001"
        assert data_sync_service.customer_mappings["001MATCH001"] == "CUST-MATCH"
        assert "001NEWONE01" in data_sync_service.customer_mappings


# ===========================================================================
# 3. Opportunity invoicing: creates invoice for Closed Won, updates SF
# ===========================================================================
class TestOpportunityInvoicing:

    @pytest.mark.asyncio
    async def test_creates_invoice_for_closed_won_opp(self, data_sync_service, mock_mcp_client):
        """Closed Won opportunity should result in an Intacct invoice."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        opp = make_sf_opportunity({
            "Id": "006INVOICE01",
            "AccountId": "001TESTACCOUNT001",
            "StageName": "Closed Won",
            "Amount": 75000,
            "Name": "Spring Grant 2026",
            "Invoice_Status__c": None,
            "Intacct_Invoice_ID__c": None,
        })

        # Pre-populate customer mapping
        data_sync_service.customer_mappings["001TESTACCOUNT001"] = "CUST-001"

        intacct.create_invoice = AsyncMock(return_value={
            "success": True,
            "data": {"RECORDNO": "INV-NEW-001"},
        })
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.process_opportunity_for_invoicing(opp)

        # Invoice should have been created in Intacct
        intacct.create_invoice.assert_called_once()
        call_args = intacct.create_invoice.call_args[0][0]
        assert call_args["customer_id"] == "CUST-001"
        assert call_args["line_items"][0]["amount"] == 75000.0

        # SF should be updated with invoice status
        sf.update_record.assert_called_once()
        update_args = sf.update_record.call_args
        assert update_args[0][0] == "Opportunity"
        assert update_args[0][1] == "006INVOICE01"
        assert update_args[0][2]["Invoice_Status__c"] == "Invoiced"
        assert update_args[0][2]["Intacct_Invoice_ID__c"] == "INV-NEW-001"

    @pytest.mark.asyncio
    async def test_updates_opportunity_mapping_after_invoicing(
        self, data_sync_service, mock_mcp_client
    ):
        """After successful invoicing, the opportunity mapping should be updated."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        opp = make_sf_opportunity({
            "Id": "006INVOICEMAP",
            "AccountId": "001TESTACCOUNT001",
            "StageName": "Closed Won",
            "Amount": 50000,
        })
        data_sync_service.customer_mappings["001TESTACCOUNT001"] = "CUST-001"

        intacct.create_invoice = AsyncMock(return_value={
            "success": True,
            "data": {"RECORDNO": "INV-MAP-001"},
        })
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.process_opportunity_for_invoicing(opp)

        mappings = data_sync_service.get_opportunity_mappings()
        assert "006INVOICEMAP" in mappings
        assert mappings["006INVOICEMAP"]["invoice_id"] == "INV-MAP-001"
        assert mappings["006INVOICEMAP"]["status"] == "invoiced"

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_invoice_creation_failure_sets_error_status(
        self, data_sync_service, mock_mcp_client
    ):
        """If Intacct invoice creation fails, SF opp should be set to 'Error' status."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        opp = make_sf_opportunity({
            "Id": "006INVOICEFAIL",
            "AccountId": "001TESTACCOUNT001",
            "StageName": "Closed Won",
            "Amount": 50000,
        })
        data_sync_service.customer_mappings["001TESTACCOUNT001"] = "CUST-001"

        intacct.create_invoice = AsyncMock(return_value={
            "success": False,
            "errors": "Insufficient credit",
        })
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.process_opportunity_for_invoicing(opp)

        # SF should be updated with error status
        sf.update_record.assert_called_once_with(
            "Opportunity",
            "006INVOICEFAIL",
            {"Invoice_Status__c": "Error"},
        )

    @pytest.mark.asyncio
    async def test_sync_opportunity_invoicing_processes_ready_opps(
        self, data_sync_service, mock_mcp_client
    ):
        """sync_opportunity_invoicing should query for Closed Won opps and process them."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        opps = [
            make_sf_opportunity({
                "Id": "006READY001",
                "AccountId": "001ACC001",
                "StageName": "Closed Won",
                "Amount": 30000,
                "Invoice_Status__c": None,
                "Intacct_Invoice_ID__c": None,
            }),
        ]
        data_sync_service.customer_mappings["001ACC001"] = "CUST-X1"

        sf.query = AsyncMock(return_value={"records": opps})
        intacct.create_invoice = AsyncMock(return_value={
            "success": True,
            "data": {"RECORDNO": "INV-R001"},
        })
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.sync_opportunity_invoicing()

        intacct.create_invoice.assert_called_once()
        assert "006READY001" in data_sync_service.opportunity_mappings


# ===========================================================================
# 4. Payment status: Paid, Partial, Pending states correctly determined
# ===========================================================================
class TestPaymentStatusUpdate:

    @pytest.mark.asyncio
    async def test_fully_paid_invoice_updates_opp_to_paid(
        self, data_sync_service, mock_mcp_client
    ):
        """Invoice with TOTALPAID >= TOTALAMOUNT should set opp to 'Paid'."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        invoice = make_intacct_invoice({
            "RECORDNO": "INV-PAID",
            "CUSTOMERID": "CUST-001",
            "TOTALAMOUNT": "50000.00",
            "TOTALPAID": "50000.00",
            "STATE": "Paid",
        })
        payment = make_intacct_payment({
            "CUSTOMERID": "CUST-001",
            "PAYMENTAMOUNT": "50000.00",
            "RECEIPTDATE": "2026-03-15",
        })
        opp = make_sf_opportunity({
            "Id": "006PAID001",
            "Intacct_Invoice_ID__c": "INV-PAID",
            "Payment_Status__c": "Pending",
        })

        intacct.get_payments = AsyncMock(return_value={"success": True, "data": [payment]})
        intacct.get_invoices = AsyncMock(return_value={"success": True, "data": [invoice]})
        sf.query = AsyncMock(return_value={"records": [opp]})
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.update_payment_statuses()

        sf.update_record.assert_called_once()
        update_data = sf.update_record.call_args[0][2]
        assert update_data["Payment_Status__c"] == "Paid"
        assert update_data.get("Payment_Date__c") == "2026-03-15"

    @pytest.mark.asyncio
    async def test_partial_payment_updates_opp_to_partial(
        self, data_sync_service, mock_mcp_client
    ):
        """Invoice with some payment but not full should set opp to 'Partial'."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        invoice = make_intacct_invoice({
            "RECORDNO": "INV-PART",
            "CUSTOMERID": "CUST-002",
            "TOTALAMOUNT": "50000.00",
            "TOTALPAID": "20000.00",
            "STATE": "Submitted",
        })
        opp = make_sf_opportunity({
            "Id": "006PART001",
            "Intacct_Invoice_ID__c": "INV-PART",
            "Payment_Status__c": "Pending",
        })

        intacct.get_payments = AsyncMock(return_value={"success": True, "data": []})
        intacct.get_invoices = AsyncMock(return_value={"success": True, "data": [invoice]})
        sf.query = AsyncMock(return_value={"records": [opp]})
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.update_payment_statuses()

        sf.update_record.assert_called_once()
        update_data = sf.update_record.call_args[0][2]
        assert update_data["Payment_Status__c"] == "Partial"
        assert update_data["Payment_Amount__c"] == 20000.0

    @pytest.mark.asyncio
    async def test_pending_payment_no_update_when_already_pending(
        self, data_sync_service, mock_mcp_client
    ):
        """If status hasn't changed (still Pending), no SF update should occur."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        invoice = make_intacct_invoice({
            "RECORDNO": "INV-PEND",
            "CUSTOMERID": "CUST-003",
            "TOTALAMOUNT": "50000.00",
            "TOTALPAID": "0.00",
            "STATE": "Submitted",
        })
        opp = make_sf_opportunity({
            "Id": "006PEND001",
            "Intacct_Invoice_ID__c": "INV-PEND",
            "Payment_Status__c": "Pending",
        })

        intacct.get_payments = AsyncMock(return_value={"success": True, "data": []})
        intacct.get_invoices = AsyncMock(return_value={"success": True, "data": [invoice]})
        sf.query = AsyncMock(return_value={"records": [opp]})
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.update_payment_statuses()

        # No update needed since status is the same
        sf.update_record.assert_not_called()

    @pytest.mark.asyncio
    async def test_paid_by_state_flag_even_with_zero_paid_amount(
        self, data_sync_service, mock_mcp_client
    ):
        """If Intacct state says 'Paid', treat as paid regardless of TOTALPAID."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        invoice = make_intacct_invoice({
            "RECORDNO": "INV-STATEFLAG",
            "CUSTOMERID": "CUST-004",
            "TOTALAMOUNT": "10000.00",
            "TOTALPAID": "0.00",
            "STATE": "Paid",
        })
        payment = make_intacct_payment({
            "CUSTOMERID": "CUST-004",
            "PAYMENTAMOUNT": "10000.00",
            "RECEIPTDATE": "2026-03-10",
        })
        opp = make_sf_opportunity({
            "Id": "006STATE01",
            "Intacct_Invoice_ID__c": "INV-STATEFLAG",
            "Payment_Status__c": "Pending",
        })

        intacct.get_payments = AsyncMock(return_value={"success": True, "data": [payment]})
        intacct.get_invoices = AsyncMock(return_value={"success": True, "data": [invoice]})
        sf.query = AsyncMock(return_value={"records": [opp]})
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.update_payment_statuses()

        update_data = sf.update_record.call_args[0][2]
        assert update_data["Payment_Status__c"] == "Paid"


# ===========================================================================
# 5. Conflict: opp without customer mapping skips invoicing
# ===========================================================================
class TestMissingCustomerMapping:

    @pytest.mark.asyncio
    async def test_opp_without_customer_mapping_skips_invoicing(
        self, data_sync_service, mock_mcp_client
    ):
        """Opportunity with no customer mapping should be skipped (no invoice created)."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        opp = make_sf_opportunity({
            "Id": "006NOMAP001",
            "AccountId": "001UNMAPPED",
            "StageName": "Closed Won",
            "Amount": 50000,
        })

        # No customer mapping exists for this account
        # get_record returns an account with no Intacct_Customer_ID__c
        sf.get_record = AsyncMock(return_value=make_sf_account({
            "Id": "001UNMAPPED",
            "Intacct_Customer_ID__c": None,
        }))

        await data_sync_service.process_opportunity_for_invoicing(opp)

        # Invoice should NOT have been created
        intacct.create_invoice.assert_not_called()
        # No opportunity mapping should exist
        assert "006NOMAP001" not in data_sync_service.opportunity_mappings

    @pytest.mark.asyncio
    async def test_opp_finds_mapping_from_sf_account_record(
        self, data_sync_service, mock_mcp_client
    ):
        """If mapping isn't cached, should look it up from the SF account record."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        opp = make_sf_opportunity({
            "Id": "006LOOKUP01",
            "AccountId": "001LOOKUP01",
            "StageName": "Closed Won",
            "Amount": 30000,
        })

        # Not in local mapping cache, but SF account has the Intacct ID
        sf.get_record = AsyncMock(return_value=make_sf_account({
            "Id": "001LOOKUP01",
            "Intacct_Customer_ID__c": "CUST-FOUND",
        }))
        intacct.create_invoice = AsyncMock(return_value={
            "success": True,
            "data": {"RECORDNO": "INV-LOOKUP"},
        })
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.process_opportunity_for_invoicing(opp)

        # Should have fetched the account to find the mapping
        sf.get_record.assert_called_with("Account", "001LOOKUP01")
        # And then created the invoice
        intacct.create_invoice.assert_called_once()
        # And cached the mapping
        assert data_sync_service.customer_mappings["001LOOKUP01"] == "CUST-FOUND"


# ===========================================================================
# 6. Error handling: Intacct failures don't crash full sync
# ===========================================================================
class TestErrorHandling:

    @pytest.mark.asyncio
    async def test_intacct_customer_fetch_failure_handled(
        self, data_sync_service, mock_mcp_client
    ):
        """If Intacct get_customers returns failure, sync_customer_mappings should return
        without crashing."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        sf.query = AsyncMock(return_value={"records": [make_sf_account()]})
        intacct.get_customers = AsyncMock(return_value={"success": False, "error": "auth expired"})

        # Should not raise
        await data_sync_service.sync_customer_mappings()

        # No mappings should have been created
        assert len(data_sync_service.customer_mappings) == 0

    @pytest.mark.asyncio
    async def test_intacct_payment_fetch_failure_handled(
        self, data_sync_service, mock_mcp_client
    ):
        """If Intacct get_payments returns failure, update_payment_statuses should return."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        intacct.get_payments = AsyncMock(return_value={"success": False, "error": "timeout"})

        # Should not raise
        await data_sync_service.update_payment_statuses()

        # No SF updates should have been attempted
        sf.update_record.assert_not_called()

    @pytest.mark.asyncio
    async def test_individual_opp_failure_doesnt_stop_batch(
        self, data_sync_service, mock_mcp_client
    ):
        """If one opportunity fails during invoicing, others should still be processed."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        opps = [
            make_sf_opportunity({
                "Id": "006FAIL001",
                "AccountId": "001ACC001",
                "StageName": "Closed Won",
                "Amount": 50000,
            }),
            make_sf_opportunity({
                "Id": "006OK001",
                "AccountId": "001ACC002",
                "StageName": "Closed Won",
                "Amount": 30000,
            }),
        ]
        data_sync_service.customer_mappings["001ACC001"] = "CUST-F1"
        data_sync_service.customer_mappings["001ACC002"] = "CUST-F2"

        # First invoice fails, second succeeds
        intacct.create_invoice = AsyncMock(side_effect=[
            Exception("Intacct connection lost"),
            {"success": True, "data": {"RECORDNO": "INV-OK001"}},
        ])
        sf.query = AsyncMock(return_value={"records": opps})
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.sync_opportunity_invoicing()

        # Second opp should still have been processed successfully
        assert "006OK001" in data_sync_service.opportunity_mappings

    @pytest.mark.asyncio
    async def test_sf_update_failure_during_payment_status_doesnt_crash(
        self, data_sync_service, mock_mcp_client
    ):
        """If SF update fails during payment status sync, the rest should continue."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        invoice = make_intacct_invoice({
            "RECORDNO": "INV-SFAIL",
            "CUSTOMERID": "CUST-SF",
            "TOTALAMOUNT": "50000.00",
            "TOTALPAID": "50000.00",
            "STATE": "Paid",
        })
        opp = make_sf_opportunity({
            "Id": "006SFAIL01",
            "Intacct_Invoice_ID__c": "INV-SFAIL",
            "Payment_Status__c": "Pending",
        })

        intacct.get_payments = AsyncMock(return_value={
            "success": True,
            "data": [make_intacct_payment({"CUSTOMERID": "CUST-SF"})],
        })
        intacct.get_invoices = AsyncMock(return_value={"success": True, "data": [invoice]})
        sf.query = AsyncMock(return_value={"records": [opp]})
        sf.update_record = AsyncMock(side_effect=Exception("SF API rate limit"))

        # Should not raise despite the SF update failure
        await data_sync_service.update_payment_statuses()


# ===========================================================================
# 7. Sync history records completed/failed syncs
# ===========================================================================
class TestSyncHistoryTracking:

    @pytest.mark.asyncio
    async def test_salesforce_sync_records_history(self, data_sync_service, mock_mcp_client):
        """sync_salesforce_data should record a completed entry."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]
        sf.query = AsyncMock(return_value={"records": []})
        intacct.get_customers = AsyncMock(return_value={"success": True, "data": []})

        await data_sync_service.sync_salesforce_data()

        history = data_sync_service.get_sync_history()
        assert any(h["type"] == "salesforce_sync" and h["status"] == "completed" for h in history)

    @pytest.mark.asyncio
    async def test_intacct_sync_records_history(self, data_sync_service, mock_mcp_client):
        """sync_intacct_data should record a completed entry."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]
        intacct.get_payments = AsyncMock(return_value={"success": True, "data": []})
        intacct.get_invoices = AsyncMock(return_value={"success": True, "data": []})
        intacct.get_customers = AsyncMock(return_value={"success": True, "data": []})
        sf.query = AsyncMock(return_value={"records": []})
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.sync_intacct_data()

        history = data_sync_service.get_sync_history()
        assert any(h["type"] == "intacct_sync" and h["status"] == "completed" for h in history)

    @pytest.mark.asyncio
    async def test_multiple_syncs_accumulate_history(self, data_sync_service, mock_mcp_client):
        """Multiple sync operations should accumulate in history."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]
        sf.query = AsyncMock(return_value={"records": []})
        intacct.get_customers = AsyncMock(return_value={"success": True, "data": []})
        intacct.get_payments = AsyncMock(return_value={"success": True, "data": []})
        intacct.get_invoices = AsyncMock(return_value={"success": True, "data": []})

        await data_sync_service.sync_all_data()
        await data_sync_service.sync_all_data()

        history = data_sync_service.get_sync_history()
        assert len(history) == 2

    @pytest.mark.asyncio
    async def test_history_limit_returns_most_recent(self, data_sync_service, mock_mcp_client):
        """get_sync_history(limit=N) should return the N most recent entries."""
        for i in range(5):
            data_sync_service.sync_history.append({
                "timestamp": datetime.now(),
                "type": f"test-{i}",
                "status": "completed",
            })

        history = data_sync_service.get_sync_history(limit=3)
        assert len(history) == 3
        assert history[-1]["type"] == "test-4"


# ===========================================================================
# Customer data sync back to Salesforce
# ===========================================================================
class TestCustomerDataSyncToSalesforce:

    @pytest.mark.asyncio
    async def test_syncs_financial_data_from_intacct_to_sf(
        self, data_sync_service, mock_mcp_client
    ):
        """Financial data from Intacct customers should update SF accounts."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        customer = make_intacct_customer({
            "CUSTOMERID": "CUST-SYNC",
            "NAME": "Synced Foundation",
            "TOTALDUE": "75000.00",
            "CREDITLIMIT": "200000.00",
            "WHENMODIFIED": "2026-03-10",
        })
        account = make_sf_account({
            "Id": "001SYNC001",
            "Intacct_Customer_ID__c": "CUST-SYNC",
            "Total_Outstanding__c": 50000.0,
            "Credit_Limit__c": 100000.0,
        })

        intacct.get_customers = AsyncMock(return_value={"success": True, "data": [customer]})
        sf.query = AsyncMock(return_value={"records": [account]})
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.sync_customer_data_to_salesforce()

        sf.update_record.assert_called_once()
        update_args = sf.update_record.call_args[0]
        assert update_args[0] == "Account"
        assert update_args[1] == "001SYNC001"
        update_data = update_args[2]
        assert update_data["Total_Outstanding__c"] == 75000.0
        assert update_data["Credit_Limit__c"] == 200000.0

    @pytest.mark.asyncio
    async def test_skips_update_when_values_unchanged(
        self, data_sync_service, mock_mcp_client
    ):
        """No SF update if Intacct values match current SF values."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        customer = make_intacct_customer({
            "CUSTOMERID": "CUST-SAME",
            "TOTALDUE": "50000.00",
            "CREDITLIMIT": "100000.00",
            "WHENMODIFIED": None,
        })
        account = make_sf_account({
            "Id": "001SAME001",
            "Intacct_Customer_ID__c": "CUST-SAME",
            "Total_Outstanding__c": 50000.0,
            "Credit_Limit__c": 100000.0,
        })

        intacct.get_customers = AsyncMock(return_value={"success": True, "data": [customer]})
        sf.query = AsyncMock(return_value={"records": [account]})
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.sync_customer_data_to_salesforce()

        sf.update_record.assert_not_called()

    @pytest.mark.asyncio
    async def test_intacct_failure_doesnt_crash_customer_sync(
        self, data_sync_service, mock_mcp_client
    ):
        """If Intacct returns failure, sync_customer_data_to_salesforce should return."""
        intacct = mock_mcp_client.services["sage_intacct"]
        intacct.get_customers = AsyncMock(return_value={"success": False, "error": "timeout"})

        # Should not raise
        await data_sync_service.sync_customer_data_to_salesforce()


# ===========================================================================
# Stage change handler
# ===========================================================================
class TestStageChangeHandler:

    @pytest.mark.asyncio
    async def test_closed_won_triggers_invoicing(self, data_sync_service, mock_mcp_client):
        """Stage change to 'Closed Won' should trigger the invoicing process."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        opp = make_sf_opportunity({
            "Id": "006STAGE01",
            "AccountId": "001STAGEACC",
            "StageName": "Closed Won",
            "Amount": 40000,
        })
        data_sync_service.customer_mappings["001STAGEACC"] = "CUST-STAGE"

        sf.get_record = AsyncMock(return_value=opp)
        intacct.create_invoice = AsyncMock(return_value={
            "success": True,
            "data": {"RECORDNO": "INV-STAGE"},
        })
        sf.update_record = AsyncMock(return_value=True)

        await data_sync_service.handle_opportunity_stage_change(
            "006STAGE01", "Closed Won", "Contract Creation"
        )

        intacct.create_invoice.assert_called_once()

    @pytest.mark.asyncio
    async def test_non_closed_won_change_does_nothing(self, data_sync_service, mock_mcp_client):
        """Stage changes that are not to 'Closed Won' should not trigger invoicing."""
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]

        await data_sync_service.handle_opportunity_stage_change(
            "006NOOP01", "Qualifying", "Lead Gen"
        )

        sf.get_record.assert_not_called()
        intacct.create_invoice.assert_not_called()


# ===========================================================================
# Kill switch: INTACCT_AUTO_INVOICE_ENABLED=false short-circuits gated paths
# ===========================================================================
class TestIntacctAutoInvoiceKillSwitch:
    """The autouse fixture sets INTACCT_AUTO_INVOICE_ENABLED=true for this file's
    duration. These tests re-patch to "false" to verify the kill-switch
    short-circuits both gated paths before any SF or Intacct writes happen."""

    @pytest.mark.asyncio
    async def test_sync_opportunity_invoicing_noop_when_disabled(
        self, data_sync_service, mock_mcp_client, monkeypatch, caplog
    ):
        import logging
        monkeypatch.setenv("INTACCT_AUTO_INVOICE_ENABLED", "false")
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]
        sf.query = AsyncMock()
        intacct.create_invoice = AsyncMock()

        with caplog.at_level(logging.INFO):
            await data_sync_service.sync_opportunity_invoicing()

        sf.query.assert_not_called()
        intacct.create_invoice.assert_not_called()
        assert any(
            "INTACCT_AUTO_INVOICE_ENABLED=false" in m
            for m in caplog.messages
        )

    @pytest.mark.asyncio
    async def test_handle_opportunity_stage_change_noop_when_disabled(
        self, data_sync_service, mock_mcp_client, monkeypatch, caplog
    ):
        import logging
        monkeypatch.setenv("INTACCT_AUTO_INVOICE_ENABLED", "false")
        sf = mock_mcp_client.services["salesforce"]
        intacct = mock_mcp_client.services["sage_intacct"]
        sf.get_record = AsyncMock()
        intacct.create_invoice = AsyncMock()

        with caplog.at_level(logging.INFO):
            await data_sync_service.handle_opportunity_stage_change(
                "006TESTOFF01", "Closed Won", "Contract Creation"
            )

        sf.get_record.assert_not_called()
        intacct.create_invoice.assert_not_called()
        assert any(
            "INTACCT_AUTO_INVOICE_ENABLED=false" in m
            for m in caplog.messages
        )
