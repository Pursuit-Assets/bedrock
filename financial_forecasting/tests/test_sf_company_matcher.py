"""Tests for services/sf_company_matcher.py.

Mocks the asyncpg DB and the Salesforce client. Pure unit tests — no real
DB connection, no real SF API.
"""

from unittest.mock import AsyncMock

import pytest

from services.sf_company_matcher import (
    _extract_domain,
    _normalize_name,
    delete_match,
    get_unmatched_accounts,
    list_matches,
    match_account,
    match_all_accounts,
    upsert_manual_match,
)


# ---------------------------------------------------------------------------
# _normalize_name
# ---------------------------------------------------------------------------


class TestNormalizeName:
    def test_strips_leading_the(self):
        assert _normalize_name("The Ford Foundation") == "ford"
        assert _normalize_name("the Robin Hood Foundation") == "robin hood"

    def test_strips_trailing_inc(self):
        assert _normalize_name("Acme Inc.") == "acme"
        assert _normalize_name("Acme Inc") == "acme"
        assert _normalize_name("Acme, Inc.") == "acme"

    def test_strips_trailing_foundation(self):
        assert _normalize_name("Ford Foundation") == "ford"
        assert _normalize_name("Robin Hood Foundation") == "robin hood"

    def test_strips_corporate_suffixes(self):
        assert _normalize_name("Acme Corp") == "acme"
        assert _normalize_name("Acme LLC") == "acme"
        assert _normalize_name("Acme LLP") == "acme"
        assert _normalize_name("Acme Ltd.") == "acme"
        assert _normalize_name("Acme Corporation") == "acme"

    def test_collapses_whitespace(self):
        assert _normalize_name("  Ford   Foundation  ") == "ford"
        assert _normalize_name("Robin\tHood   Foundation") == "robin hood"

    def test_lowercase(self):
        assert _normalize_name("FORD FOUNDATION") == "ford"
        assert _normalize_name("Ford FOUNDATION") == "ford"

    def test_strips_punctuation(self):
        assert _normalize_name("Goldman, Sachs & Co.") == "goldman sachs"
        assert _normalize_name("AT&T") == "at t"

    def test_empty_input(self):
        assert _normalize_name("") == ""
        assert _normalize_name("   ") == ""

    def test_complex_real_world_example(self):
        # The kind of name that motivated the normalization
        assert _normalize_name("The Robin Hood Foundation, Inc.") == "robin hood"


# ---------------------------------------------------------------------------
# _extract_domain
# ---------------------------------------------------------------------------


class TestExtractDomain:
    def test_full_https_url(self):
        assert _extract_domain("https://www.fordfoundation.org/about") == "fordfoundation.org"

    def test_http_url(self):
        assert _extract_domain("http://acme.com") == "acme.com"

    def test_bare_domain(self):
        assert _extract_domain("fordfoundation.org") == "fordfoundation.org"

    def test_strips_www(self):
        assert _extract_domain("www.acme.com") == "acme.com"
        assert _extract_domain("https://www.acme.com") == "acme.com"

    def test_strips_path(self):
        assert _extract_domain("acme.com/about/team") == "acme.com"

    def test_strips_query_string(self):
        assert _extract_domain("acme.com?ref=foo") == "acme.com"

    def test_lowercases(self):
        assert _extract_domain("HTTPS://ACME.COM") == "acme.com"

    def test_none_returns_none(self):
        assert _extract_domain(None) is None
        assert _extract_domain("") is None


# ---------------------------------------------------------------------------
# match_account
# ---------------------------------------------------------------------------


class TestMatchAccount:
    @pytest.mark.asyncio
    async def test_exact_name_match(self):
        db = AsyncMock()
        # First fetchrow: exact match query returns a company
        # Second fetchrow: insert returns the new row
        db.fetchrow = AsyncMock(side_effect=[
            {"company_id": 42},  # exact name lookup
            {  # insert returning row
                "sf_account_id": "001ABC",
                "public_company_id": 42,
                "confidence": "exact_name",
                "matched_at": "2026-04-08T10:00:00Z",
            },
        ])

        result = await match_account("001ABC", "Ford Foundation", None, db)

        assert result is not None
        assert result["sf_account_id"] == "001ABC"
        assert result["public_company_id"] == 42
        assert result["confidence"] == "exact_name"

    @pytest.mark.asyncio
    async def test_no_match(self):
        db = AsyncMock()
        # All three lookups (exact, normalized, domain) return None
        db.fetchrow = AsyncMock(return_value=None)

        result = await match_account("001XYZ", "Some Random Org", None, db)

        assert result is None

    @pytest.mark.asyncio
    async def test_empty_name_returns_none(self):
        db = AsyncMock()
        db.fetchrow = AsyncMock()

        result = await match_account("001ABC", "", None, db)

        assert result is None
        # Should not even query the DB
        db.fetchrow.assert_not_called()

    @pytest.mark.asyncio
    async def test_already_matched_returns_none(self):
        """ON CONFLICT DO NOTHING means a re-run returns None for an existing match."""
        db = AsyncMock()
        db.fetchrow = AsyncMock(side_effect=[
            {"company_id": 42},  # exact name lookup succeeds
            None,                # but insert hits ON CONFLICT, returns nothing
        ])

        result = await match_account("001ABC", "Ford Foundation", None, db)

        assert result is None  # caller can interpret this as "already mapped"


# ---------------------------------------------------------------------------
# match_all_accounts
# ---------------------------------------------------------------------------


class TestMatchAllAccounts:
    @pytest.mark.asyncio
    async def test_summary_counts(self):
        sf_client = AsyncMock()
        sf_client.query = AsyncMock(return_value={"records": [
            {"Id": "001A", "Name": "Ford Foundation", "Website": None},
            {"Id": "001B", "Name": "Random Org", "Website": None},
            {"Id": "001C", "Name": "Acme Inc.", "Website": None},
        ]})

        db = AsyncMock()
        # Pattern: for each account, return exact_match | None | exact_match,
        # and the corresponding insert results.
        db.fetchrow = AsyncMock(side_effect=[
            # 001A: exact match → 42
            {"company_id": 42},
            {"sf_account_id": "001A", "public_company_id": 42, "confidence": "exact_name", "matched_at": "x"},
            # 001B: no match anywhere
            None, None, None,
            # 001C: exact match → 99
            {"company_id": 99},
            {"sf_account_id": "001C", "public_company_id": 99, "confidence": "exact_name", "matched_at": "y"},
        ])

        summary = await match_all_accounts(sf_client, db, dry_run=False)

        assert summary["total"] == 3
        assert summary["matched"] == 2
        assert summary["unmatched"] == 1
        assert summary["errors"] == 0
        assert summary["by_confidence"]["exact_name"] == 2

    @pytest.mark.asyncio
    async def test_dry_run_does_not_insert(self):
        sf_client = AsyncMock()
        sf_client.query = AsyncMock(return_value={"records": [
            {"Id": "001A", "Name": "Ford Foundation", "Website": None},
        ]})

        db = AsyncMock()
        db.fetchrow = AsyncMock(return_value={"company_id": 42})

        summary = await match_all_accounts(sf_client, db, dry_run=True)

        assert summary["matched"] == 1
        # In dry_run, only ONE fetchrow per account (the lookup), no insert
        assert db.fetchrow.call_count == 1

    @pytest.mark.asyncio
    async def test_sf_query_failure_returns_error_summary(self):
        sf_client = AsyncMock()
        sf_client.query = AsyncMock(side_effect=Exception("SF down"))

        db = AsyncMock()

        summary = await match_all_accounts(sf_client, db)

        assert summary["errors"] >= 1
        assert summary["total"] == 0


# ---------------------------------------------------------------------------
# get_unmatched_accounts / list_matches / upsert_manual_match / delete_match
# ---------------------------------------------------------------------------


class TestListingHelpers:
    @pytest.mark.asyncio
    async def test_get_unmatched_accounts_filters_matched(self):
        sf_client = AsyncMock()
        sf_client.query = AsyncMock(return_value={"records": [
            {"Id": "001A", "Name": "Ford", "Website": "ford.org"},
            {"Id": "001B", "Name": "Acme", "Website": None},
            {"Id": "001C", "Name": "Robin Hood", "Website": None},
        ]})

        db = AsyncMock()
        db.fetch = AsyncMock(return_value=[
            {"sf_account_id": "001B"},  # 001B is already matched
        ])

        unmatched = await get_unmatched_accounts(sf_client, db)

        assert len(unmatched) == 2
        assert {u["sf_account_id"] for u in unmatched} == {"001A", "001C"}

    @pytest.mark.asyncio
    async def test_upsert_manual_match_returns_row(self):
        db = AsyncMock()
        db.fetchrow = AsyncMock(return_value={
            "sf_account_id": "001A",
            "public_company_id": 42,
            "confidence": "manual",
            "matched_by": "admin@pursuit.org",
            "matched_at": "2026-04-08T10:00:00Z",
            "notes": "verified by JP",
        })

        result = await upsert_manual_match(
            "001A", 42, "admin@pursuit.org", "verified by JP", db,
        )

        assert result["confidence"] == "manual"
        assert result["matched_by"] == "admin@pursuit.org"

    @pytest.mark.asyncio
    async def test_delete_match_true_when_row_deleted(self):
        db = AsyncMock()
        db.execute = AsyncMock(return_value="DELETE 1")

        deleted = await delete_match("001A", db)
        assert deleted is True

    @pytest.mark.asyncio
    async def test_delete_match_false_when_no_row(self):
        db = AsyncMock()
        db.execute = AsyncMock(return_value="DELETE 0")

        deleted = await delete_match("001A", db)
        assert deleted is False
