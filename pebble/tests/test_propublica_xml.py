"""Tests for ProPublica 990 XML download and officer parsing."""

import os
from pathlib import Path
from unittest.mock import patch, MagicMock, AsyncMock

import pytest

from pebble.data_sources.propublica import (
    parse_officers_from_xml,
    download_990_xml,
    get_latest_object_id,
)

FIXTURES = Path(__file__).parent / "fixtures"


class TestParseOfficersFromXml:
    """Tests for parse_officers_from_xml()."""

    def test_namespaced_xml(self):
        """Parse officers from namespaced 990 XML (http://www.irs.gov/efile)."""
        xml = (FIXTURES / "sample_990.xml").read_text()
        officers = parse_officers_from_xml(xml)

        assert len(officers) == 3

        # First officer
        assert officers[0]["name"] == "JANE DOE"
        assert officers[0]["title"] == "Executive Director"
        assert officers[0]["hours_per_week"] == 40.0
        assert officers[0]["compensation"] == 250000.0
        assert officers[0]["other_compensation"] == 15000.0

        # Board member with zero comp
        assert officers[1]["name"] == "JOHN SMITH"
        assert officers[1]["title"] == "Board Chair"
        assert officers[1]["compensation"] == 0.0

        # CFO
        assert officers[2]["name"] == "MARIA GARCIA"
        assert officers[2]["title"] == "CFO"
        assert officers[2]["compensation"] == 185000.0

    def test_bare_xml(self):
        """Parse officers from bare (no namespace) 990 XML."""
        xml = (FIXTURES / "sample_990_bare.xml").read_text()
        officers = parse_officers_from_xml(xml)

        assert len(officers) == 1
        assert officers[0]["name"] == "ALICE JOHNSON"
        assert officers[0]["title"] == "President"
        assert officers[0]["compensation"] == 300000.0

    def test_empty_xml(self):
        """Valid XML with no Part VII elements returns empty list."""
        xml = '<?xml version="1.0"?><Return><ReturnData><IRS990></IRS990></ReturnData></Return>'
        officers = parse_officers_from_xml(xml)
        assert officers == []

    def test_invalid_xml(self):
        """Malformed XML returns empty list (no crash)."""
        officers = parse_officers_from_xml("not xml at all")
        assert officers == []

    def test_empty_string(self):
        """Empty input returns empty list."""
        assert parse_officers_from_xml("") == []
        assert parse_officers_from_xml(None) == []

    def test_officer_without_name_skipped(self):
        """Officers missing PersonNm are excluded."""
        xml = """<?xml version="1.0"?>
        <Return>
          <ReturnData><IRS990>
            <Form990PartVIISectionAGrp>
              <TitleTxt>Ghost</TitleTxt>
              <ReportableCompFromOrgAmt>100000</ReportableCompFromOrgAmt>
            </Form990PartVIISectionAGrp>
            <Form990PartVIISectionAGrp>
              <PersonNm>REAL PERSON</PersonNm>
              <TitleTxt>Director</TitleTxt>
              <ReportableCompFromOrgAmt>50000</ReportableCompFromOrgAmt>
            </Form990PartVIISectionAGrp>
          </IRS990></ReturnData>
        </Return>"""
        officers = parse_officers_from_xml(xml)
        assert len(officers) == 1
        assert officers[0]["name"] == "REAL PERSON"


class TestGetLatestObjectId:
    """Tests for get_latest_object_id()."""

    def test_extracts_object_id(self):
        org_data = {
            "organization": {"name": "Test Org", "latest_object_id": "202630309349300223"}
        }
        assert get_latest_object_id(org_data) == "202630309349300223"

    def test_missing_field(self):
        org_data = {"organization": {"name": "Test Org"}}
        assert get_latest_object_id(org_data) is None

    def test_missing_organization(self):
        assert get_latest_object_id({}) is None

    def test_none_input(self):
        assert get_latest_object_id(None) is None


class TestDownload990Xml:
    """Tests for download_990_xml() — mocked HTTP + cache.

    Patches updated post-P1: download_990_xml is async and the HTTP
    layer moved to pebble.data_sources._http.get_with_retry.
    """

    @pytest.mark.asyncio
    @patch("pebble.storage.cache.get_cached")
    async def test_cache_hit(self, mock_get_cached):
        """Cache hit returns stored XML without HTTP call."""
        mock_get_cached.return_value = {"xml": "<Return>cached</Return>"}

        result = await download_990_xml("12345")
        assert result == "<Return>cached</Return>"
        mock_get_cached.assert_called_once_with("propublica_990_xml", "12345")

    @pytest.mark.asyncio
    @patch("pebble.storage.cache.set_cached")
    @patch("pebble.data_sources.propublica.get_with_retry", new_callable=AsyncMock)
    @patch("pebble.storage.cache.get_cached", return_value=None)
    async def test_cache_miss_downloads(self, mock_get_cached, mock_get, mock_set_cached):
        """Cache miss triggers HTTP download and caches result."""
        mock_response = MagicMock()
        mock_response.text = "<Return>fresh</Return>"
        mock_get.return_value = mock_response

        result = await download_990_xml("67890")
        assert result == "<Return>fresh</Return>"

        # Verify correct IRS S3 URL
        mock_get.assert_awaited_once_with(
            "https://s3.amazonaws.com/irs-form-990/67890_public.xml"
        )

        # Verify 30-day cache TTL
        mock_set_cached.assert_called_once_with(
            "propublica_990_xml", "67890",
            {"xml": "<Return>fresh</Return>"},
            ttl_seconds=2_592_000,
        )

    @pytest.mark.asyncio
    @patch("pebble.data_sources.propublica.get_with_retry", new_callable=AsyncMock,
           return_value=None)
    @patch("pebble.storage.cache.get_cached", return_value=None)
    async def test_download_failure(self, mock_get_cached, mock_get):
        """HTTP failure returns None."""
        assert await download_990_xml("bad_id") is None
