"""Round-trip tests for DataSyncService.sync_activities + SF Task/Event mappers.

Pins the 5 canonical cases from tasks/objects-production-readiness-plan.md
PR #159: (1) email subtype → email type, (2) call type → call, (3) all-day
event → calendar-event vs meeting, (4) WhatId 006/001 routing, (5) soft-
delete preservation.

Also defends the sync loop's control flow: skip when no db_pool / no SF,
watermark-in-SOQL, per-row-error survival, history-entry shape, resilience
when query_all fails for one object type.

Complements tests/test_activities.py (HTTP routes) by targeting the service
layer directly.
"""

import sys
import os
from datetime import datetime, date, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from data_sync import DataSyncService
from conftest import make_sf_task, make_sf_event


# ===========================================================================
# Local fixtures — pool/conn mocking for the async context-manager pattern
# `async with self.db_pool.acquire() as conn:` used by sync_activities.
# ===========================================================================

def _make_pool(conn):
    """Wrap an AsyncMock conn into a MagicMock pool supporting
    `async with pool.acquire() as conn:`.

    asyncpg pools expose .acquire() as a context-manager (not an awaitable);
    inside the `async with` the __aenter__ returns the connection. MagicMock
    doesn't implement the async protocol by default, so we stitch it manually.
    """
    pool = MagicMock()
    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=False)
    pool.acquire = MagicMock(return_value=acquire_cm)
    return pool


@pytest.fixture
def mock_conn():
    """asyncpg-like connection mock.

    - fetchval returns None (empty table — watermark clause skipped).
    - execute returns 'INSERT 0 1' (upsert reports 'upserted').
    Tests override either to exercise other branches.
    """
    conn = AsyncMock()
    conn.fetchval = AsyncMock(return_value=None)
    conn.execute = AsyncMock(return_value="INSERT 0 1")
    return conn


@pytest.fixture
def mock_pool(mock_conn):
    return _make_pool(mock_conn)


@pytest.fixture
def mock_sf():
    """Salesforce service mock — query_all returns empty by default."""
    sf = AsyncMock()
    sf.query_all = AsyncMock(return_value={"records": []})
    return sf


@pytest.fixture
def mock_mcp(mock_sf):
    """Minimal UnifiedMCPClient shape sync_activities reaches into:
    `self.mcp_client.services["salesforce"]` and `.connected_services`."""
    client = MagicMock()
    client.services = {"salesforce": mock_sf}
    client.connected_services = {"salesforce"}
    return client


@pytest.fixture
def service(mock_mcp, mock_pool):
    return DataSyncService(mock_mcp, db_pool=mock_pool)


@pytest.fixture
def service_no_pool(mock_mcp):
    return DataSyncService(mock_mcp, db_pool=None)


@pytest.fixture
def service_no_sf(mock_pool):
    client = MagicMock()
    client.services = {}
    client.connected_services = set()
    return DataSyncService(client, db_pool=mock_pool)


# ===========================================================================
# 1. TestParseSfDatetime — DataSyncService._parse_sf_datetime
# Pure static method; pins the Salesforce date/datetime parsing semantics
# the mappers rely on. `asyncpg` TIMESTAMPTZ columns require tz-aware values,
# so tz-assignment is an invariant worth pinning.
# ===========================================================================

class TestParseSfDatetime:

    def test_iso_datetime_with_tz_parsed_as_utc(self):
        result = DataSyncService._parse_sf_datetime("2026-03-15T14:30:00+00:00")
        assert result is not None
        assert result.tzinfo is not None
        assert result.utcoffset().total_seconds() == 0

    def test_iso_datetime_naive_gets_utc(self):
        """Naive ISO string (no tz) is promoted to UTC so asyncpg doesn't choke."""
        result = DataSyncService._parse_sf_datetime("2026-03-15T14:30:00")
        assert result is not None
        assert result.tzinfo is not None
        assert result == datetime(2026, 3, 15, 14, 30, tzinfo=timezone.utc)

    def test_date_only_string_becomes_utc_midnight(self):
        result = DataSyncService._parse_sf_datetime("2026-03-15")
        assert result == datetime(2026, 3, 15, 0, 0, tzinfo=timezone.utc)

    def test_none_stays_none(self):
        assert DataSyncService._parse_sf_datetime(None) is None

    def test_datetime_with_tz_passes_through(self):
        src = datetime(2026, 3, 15, 14, 30, tzinfo=timezone.utc)
        assert DataSyncService._parse_sf_datetime(src) is src

    def test_datetime_without_tz_gets_utc(self):
        src = datetime(2026, 3, 15, 14, 30)
        result = DataSyncService._parse_sf_datetime(src)
        assert result.tzinfo == timezone.utc

    def test_date_object_becomes_utc_midnight(self):
        src = date(2026, 3, 15)
        result = DataSyncService._parse_sf_datetime(src)
        assert result == datetime(2026, 3, 15, 0, 0, tzinfo=timezone.utc)

    def test_invalid_string_returns_none(self):
        assert DataSyncService._parse_sf_datetime("not-a-date") is None


# ===========================================================================
# 2. TestMapSfTask — DataSyncService._map_sf_task
# Pins the 5 decision branches (type-from-subtype, type-from-Type, WhatId
# routing, WhoId routing, call-duration conversion) plus identity/ownership
# preservation.
# ===========================================================================

class TestMapSfTask:

    def setup_method(self):
        self.service = DataSyncService(mcp_client=None)

    # --- type decision ---

    def test_email_subtype_maps_to_email_type(self):
        """Plan case 1: TaskSubtype="Email" → row["type"] == "email"."""
        row = self.service._map_sf_task(make_sf_task({"TaskSubtype": "Email", "Type": "Other"}))
        assert row["type"] == "email"

    def test_call_subtype_maps_to_call_type(self):
        row = self.service._map_sf_task(make_sf_task({"TaskSubtype": "Call", "Type": None}))
        assert row["type"] == "call"

    def test_type_field_call_maps_to_call(self):
        """Plan case 2: TaskSubtype=None, Type="Call" → row["type"] == "call"."""
        row = self.service._map_sf_task(make_sf_task({"TaskSubtype": None, "Type": "Call"}))
        assert row["type"] == "call"

    def test_no_type_signals_maps_to_note(self):
        row = self.service._map_sf_task(make_sf_task({"TaskSubtype": None, "Type": None}))
        assert row["type"] == "note"

    def test_type_decision_is_case_insensitive(self):
        """The impl .lower()s both subtype and Type — pin that contract."""
        row = self.service._map_sf_task(make_sf_task({"TaskSubtype": "EMAIL", "Type": None}))
        assert row["type"] == "email"

    # --- WhatId routing ---

    def test_whatid_006_routes_to_opportunity_id(self):
        """Plan case 4: WhatId starting with 006 → opportunity_id, account_id None."""
        row = self.service._map_sf_task(make_sf_task({"WhatId": "006ABCDEFGHIJ12"}))
        assert row["opportunity_id"] == "006ABCDEFGHIJ12"
        assert row["account_id"] is None

    def test_whatid_001_routes_to_account_id(self):
        """Plan case 4: WhatId starting with 001 → account_id, opportunity_id None."""
        row = self.service._map_sf_task(make_sf_task({"WhatId": "001ABCDEFGHIJ12"}))
        assert row["account_id"] == "001ABCDEFGHIJ12"
        assert row["opportunity_id"] is None

    def test_whatid_other_prefix_drops_both_routes_silently(self):
        """WhatId with an unknown prefix (e.g. a05..., 500...) is silently
        dropped — current behavior. Pin so any future change is explicit."""
        row = self.service._map_sf_task(make_sf_task({"WhatId": "a05ABCDEFGHIJ12"}))
        assert row["opportunity_id"] is None
        assert row["account_id"] is None

    def test_whatid_missing_yields_no_routing(self):
        row = self.service._map_sf_task(make_sf_task({"WhatId": None}))
        assert row["opportunity_id"] is None
        assert row["account_id"] is None

    # --- WhoId routing ---

    def test_whoid_003_populates_contact_ids(self):
        row = self.service._map_sf_task(make_sf_task({"WhoId": "003ABCDEFGHIJ12"}))
        assert row["contact_ids"] == ["003ABCDEFGHIJ12"]

    def test_whoid_missing_yields_empty_contact_ids(self):
        row = self.service._map_sf_task(make_sf_task({"WhoId": None}))
        assert row["contact_ids"] == []

    def test_whoid_non_contact_prefix_yields_empty_contact_ids(self):
        """Lead WhoIds start with 00Q — the impl only maps 003 (Contact)
        to contact_ids, so Lead-linked Tasks currently drop the WhoId."""
        row = self.service._map_sf_task(make_sf_task({"WhoId": "00QABCDEFGHIJ12"}))
        assert row["contact_ids"] == []

    # --- call duration ---

    def test_call_duration_seconds_to_minutes(self):
        """CallDurationInSeconds=1800 → meeting_duration_minutes=30."""
        row = self.service._map_sf_task(make_sf_task({"CallDurationInSeconds": 1800}))
        assert row["meeting_duration_minutes"] == 30

    def test_call_duration_none_stays_none(self):
        row = self.service._map_sf_task(make_sf_task({"CallDurationInSeconds": None}))
        assert row["meeting_duration_minutes"] is None

    def test_call_duration_zero_becomes_none(self):
        """0 seconds → the `if call_duration_sec` branch fails → None (not 0).
        Pin this quirk so any future change is explicit."""
        row = self.service._map_sf_task(make_sf_task({"CallDurationInSeconds": 0}))
        assert row["meeting_duration_minutes"] is None

    # --- identity + fallbacks ---

    def test_missing_subject_defaults_to_placeholder(self):
        row = self.service._map_sf_task(make_sf_task({"Subject": None}))
        assert row["subject"] == "(No subject)"

    def test_preserves_sf_id_and_owner_and_logged_by(self):
        row = self.service._map_sf_task(make_sf_task({
            "Id": "00T0000000UNIQUE",
            "OwnerId": "005ABCDEFGHIJ11",
            "CreatedById": "005ABCDEFGHIJ22",
        }))
        assert row["sf_id"] == "00T0000000UNIQUE"
        assert row["sf_type"] == "Task"
        assert row["owner_id"] == "005ABCDEFGHIJ11"
        assert row["logged_by"] == "005ABCDEFGHIJ22"
        assert row["source"] == "salesforce"

    def test_activity_date_uses_activity_date_when_present(self):
        row = self.service._map_sf_task(make_sf_task({
            "ActivityDate": "2026-05-01",
            "CreatedDate": "2026-01-01T10:00:00.000+0000",
        }))
        assert row["activity_date"] == datetime(2026, 5, 1, 0, 0, tzinfo=timezone.utc)

    def test_activity_date_falls_back_to_created_date(self):
        """ActivityDate=None → CreatedDate used. Guards the `or` fallback."""
        row = self.service._map_sf_task(make_sf_task({
            "ActivityDate": None,
            "CreatedDate": "2026-01-15T10:30:00+00:00",
        }))
        assert row["activity_date"] == datetime(2026, 1, 15, 10, 30, tzinfo=timezone.utc)


# ===========================================================================
# 3. TestMapSfEvent — DataSyncService._map_sf_event
# ===========================================================================

class TestMapSfEvent:

    def setup_method(self):
        self.service = DataSyncService(mcp_client=None)

    def test_all_day_event_maps_to_calendar_event(self):
        """Plan case 3: IsAllDayEvent=True → calendar-event."""
        row = self.service._map_sf_event(make_sf_event({"IsAllDayEvent": True}))
        assert row["type"] == "calendar-event"

    def test_non_all_day_event_maps_to_meeting(self):
        """Plan case 3: IsAllDayEvent=False → meeting."""
        row = self.service._map_sf_event(make_sf_event({"IsAllDayEvent": False}))
        assert row["type"] == "meeting"

    def test_missing_is_all_day_defaults_to_meeting(self):
        """IsAllDayEvent missing → .get("IsAllDayEvent", False) → meeting."""
        task_without_flag = make_sf_event()
        task_without_flag.pop("IsAllDayEvent", None)
        row = self.service._map_sf_event(task_without_flag)
        assert row["type"] == "meeting"

    def test_event_whatid_006_routes_to_opportunity_id(self):
        row = self.service._map_sf_event(make_sf_event({"WhatId": "006XYZ0000ABCDE"}))
        assert row["opportunity_id"] == "006XYZ0000ABCDE"
        assert row["account_id"] is None

    def test_event_whatid_001_routes_to_account_id(self):
        row = self.service._map_sf_event(make_sf_event({"WhatId": "001XYZ0000ABCDE"}))
        assert row["account_id"] == "001XYZ0000ABCDE"
        assert row["opportunity_id"] is None

    def test_event_whoid_003_populates_contact_ids(self):
        row = self.service._map_sf_event(make_sf_event({"WhoId": "003XYZ0000ABCDE"}))
        assert row["contact_ids"] == ["003XYZ0000ABCDE"]

    def test_event_location_propagates_to_meeting_location(self):
        row = self.service._map_sf_event(make_sf_event({"Location": "Conference Room A"}))
        assert row["meeting_location"] == "Conference Room A"

    def test_event_duration_minutes_direct_not_divided(self):
        """DurationInMinutes=60 → meeting_duration_minutes=60 (NOT divided
        by 60 like Task's CallDurationInSeconds — pin the unit difference)."""
        row = self.service._map_sf_event(make_sf_event({"DurationInMinutes": 60}))
        assert row["meeting_duration_minutes"] == 60

    def test_event_activity_date_uses_start_datetime(self):
        row = self.service._map_sf_event(make_sf_event({
            "StartDateTime": "2026-06-01T09:00:00+00:00",
        }))
        assert row["activity_date"] == datetime(2026, 6, 1, 9, 0, tzinfo=timezone.utc)

    def test_event_activity_date_falls_back_to_created_date(self):
        row = self.service._map_sf_event(make_sf_event({
            "StartDateTime": None,
            "CreatedDate": "2026-02-15T10:30:00+00:00",
        }))
        assert row["activity_date"] == datetime(2026, 2, 15, 10, 30, tzinfo=timezone.utc)

    def test_event_preserves_identity_fields(self):
        row = self.service._map_sf_event(make_sf_event({
            "Id": "00U0000000UNIQUE",
            "OwnerId": "005ABCDEFGHIJ11",
        }))
        assert row["sf_id"] == "00U0000000UNIQUE"
        assert row["sf_type"] == "Event"
        assert row["owner_id"] == "005ABCDEFGHIJ11"
        assert row["source"] == "salesforce"


# ===========================================================================
# 4. TestUpsertActivity — DataSyncService._upsert_activity
# ===========================================================================

class TestUpsertActivity:

    @pytest.fixture
    def sample_row(self):
        """A minimal row matching what _map_sf_task emits."""
        return {
            "sf_id": "00T0000000TEST01",
            "sf_type": "Task",
            "type": "call",
            "subject": "Test call",
            "description": None,
            "activity_date": datetime(2026, 3, 15, 14, 30, tzinfo=timezone.utc),
            "opportunity_id": "006TESTOPPORT01",
            "account_id": None,
            "contact_ids": ["003CONTACT0012345"],
            "source": "salesforce",
            "owner_id": "005OWNER0012345",
            "logged_by": "005OWNER0012345",
            "sf_last_modified": datetime(2026, 3, 15, 15, 0, tzinfo=timezone.utc),
            "meeting_duration_minutes": 30,
            "meeting_location": None,
        }

    @pytest.mark.asyncio
    async def test_upsert_insert_returns_upserted(self, mock_conn, sample_row):
        """`INSERT 0 1` return tag → method returns 'upserted'."""
        mock_conn.execute = AsyncMock(return_value="INSERT 0 1")
        service = DataSyncService(mcp_client=None)
        result = await service._upsert_activity(mock_conn, sample_row)
        assert result == "upserted"

    @pytest.mark.asyncio
    async def test_upsert_conflict_skipped_returns_skipped_deleted(self, mock_conn, sample_row):
        """Plan case 5: `INSERT 0 0` return tag (ON CONFLICT's DO UPDATE WHERE
        deleted_at IS NULL was false — soft-deleted row stayed dead) → method
        returns 'skipped_deleted'."""
        mock_conn.execute = AsyncMock(return_value="INSERT 0 0")
        service = DataSyncService(mcp_client=None)
        result = await service._upsert_activity(mock_conn, sample_row)
        assert result == "skipped_deleted"

    @pytest.mark.asyncio
    async def test_upsert_sql_includes_deleted_at_guard(self, mock_conn, sample_row):
        """Plan case 5: the upsert's DO UPDATE branch must be gated on
        `bedrock.activity.deleted_at IS NULL` so soft-deleted rows aren't
        resurrected. This assertion pins the guard in place."""
        service = DataSyncService(mcp_client=None)
        await service._upsert_activity(mock_conn, sample_row)
        sql = mock_conn.execute.call_args[0][0]
        assert "deleted_at IS NULL" in sql
        assert "ON CONFLICT (sf_id) DO UPDATE" in sql

    @pytest.mark.asyncio
    async def test_upsert_passes_15_positional_params_in_order(self, mock_conn, sample_row):
        """The upsert statement declares $1..$15; verify the mapper-row fields
        reach asyncpg in the same order the SQL expects. Any reordering of
        column list vs. params should fail this test loudly."""
        service = DataSyncService(mcp_client=None)
        await service._upsert_activity(mock_conn, sample_row)
        args = mock_conn.execute.call_args[0]
        sql = args[0]
        params = args[1:]
        assert "$15" in sql  # 15 positional params declared
        assert len(params) == 15
        assert params[0] == "00T0000000TEST01"  # sf_id
        assert params[1] == "Task"  # sf_type
        assert params[2] == "call"  # type
        assert params[3] == "Test call"  # subject


# ===========================================================================
# 5. TestSyncActivitiesRoundTrip — full sync_activities() integration
# ===========================================================================

class TestSyncActivitiesRoundTrip:

    @pytest.mark.asyncio
    async def test_skips_when_no_db_pool(self, service_no_pool, mock_mcp):
        """db_pool=None → return immediately, no SF calls."""
        await service_no_pool.sync_activities()
        mock_mcp.services["salesforce"].query_all.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_when_sf_not_connected(self, service_no_sf, mock_pool):
        """connected_services missing 'salesforce' → return immediately."""
        await service_no_sf.sync_activities()
        # mock_pool.acquire should NOT have been called because we exit
        # before reaching the `async with pool.acquire()` block.
        mock_pool.acquire.assert_not_called()

    @pytest.mark.asyncio
    async def test_queries_both_tasks_and_events(self, service, mock_sf):
        """query_all called twice — once per Task/Event SOQL — with correct FROM."""
        await service.sync_activities()
        assert mock_sf.query_all.call_count == 2
        soqls = [call.args[0] for call in mock_sf.query_all.call_args_list]
        assert any("FROM Task" in s for s in soqls)
        assert any("FROM Event" in s for s in soqls)

    @pytest.mark.asyncio
    async def test_processes_mixed_batch_three_tasks_two_events(
        self, service, mock_sf, mock_conn
    ):
        """3 Tasks + 2 Events → 5 upserts; history reports upserted=5."""
        tasks = [make_sf_task({"Id": f"00T{i:013d}"}) for i in range(3)]
        events = [make_sf_event({"Id": f"00U{i:013d}"}) for i in range(2)]
        mock_sf.query_all = AsyncMock(side_effect=[
            {"records": tasks},
            {"records": events},
        ])
        await service.sync_activities()
        assert mock_conn.execute.call_count == 5
        history = service.sync_history[-1]
        assert history["upserted"] == 5
        assert history["errors"] == 0
        assert history["skipped_deleted"] == 0

    @pytest.mark.asyncio
    async def test_watermark_in_soql_when_prior_rows_exist(
        self, service, mock_sf, mock_conn
    ):
        """conn.fetchval returns a datetime → both SOQL queries include
        `LastModifiedDate > <watermark>` clause (incremental sync)."""
        mock_conn.fetchval = AsyncMock(
            return_value=datetime(2026, 3, 15, 14, 30, tzinfo=timezone.utc)
        )
        await service.sync_activities()
        soqls = [call.args[0] for call in mock_sf.query_all.call_args_list]
        for soql in soqls:
            assert "LastModifiedDate > 2026-03-15T14:30:00Z" in soql

    @pytest.mark.asyncio
    async def test_no_watermark_clause_when_table_empty(
        self, service, mock_sf, mock_conn
    ):
        """conn.fetchval returns None → SOQL has no `LastModifiedDate >`
        predicate (full sync)."""
        mock_conn.fetchval = AsyncMock(return_value=None)
        await service.sync_activities()
        soqls = [call.args[0] for call in mock_sf.query_all.call_args_list]
        for soql in soqls:
            assert "LastModifiedDate >" not in soql

    @pytest.mark.asyncio
    async def test_soft_deleted_rows_counted_separately(
        self, service, mock_sf, mock_conn
    ):
        """Plan case 5 integration: among 3 upserts, if one returns
        'INSERT 0 0' (ON CONFLICT skipped because deleted_at was NOT NULL),
        history reports upserted=2 + skipped_deleted=1."""
        tasks = [make_sf_task({"Id": f"00T{i:013d}"}) for i in range(3)]
        mock_sf.query_all = AsyncMock(side_effect=[
            {"records": tasks},
            {"records": []},
        ])
        # First two upserts succeed; third is skipped_deleted.
        mock_conn.execute = AsyncMock(side_effect=[
            "INSERT 0 1",
            "INSERT 0 1",
            "INSERT 0 0",
        ])
        await service.sync_activities()
        history = service.sync_history[-1]
        assert history["upserted"] == 2
        assert history["skipped_deleted"] == 1
        assert history["errors"] == 0

    @pytest.mark.asyncio
    async def test_survives_task_query_failure(
        self, service, mock_sf, mock_conn
    ):
        """If query_all raises for Tasks, Events path still runs.
        Guards the try/except per-object-type in sync_activities."""
        mock_sf.query_all = AsyncMock(side_effect=[
            Exception("SF rate limit"),
            {"records": [make_sf_event()]},
        ])
        await service.sync_activities()
        # Event still upserted despite Task query failure
        assert mock_conn.execute.call_count == 1
        history = service.sync_history[-1]
        assert history["upserted"] == 1

    @pytest.mark.asyncio
    async def test_survives_event_query_failure(
        self, service, mock_sf, mock_conn
    ):
        mock_sf.query_all = AsyncMock(side_effect=[
            {"records": [make_sf_task()]},
            Exception("SF timeout"),
        ])
        await service.sync_activities()
        assert mock_conn.execute.call_count == 1
        history = service.sync_history[-1]
        assert history["upserted"] == 1

    @pytest.mark.asyncio
    async def test_survives_per_row_mapping_error(
        self, service, mock_sf, mock_conn
    ):
        """If one Task is malformed (e.g. missing required 'Id' key → KeyError
        in _map_sf_task), the loop catches and continues with next records.
        Pin the error counter."""
        good_task = make_sf_task({"Id": "00T0000000GOOD01"})
        bad_task = make_sf_task()
        bad_task.pop("Id")  # simulate malformed SF record
        mock_sf.query_all = AsyncMock(side_effect=[
            {"records": [good_task, bad_task]},
            {"records": []},
        ])
        await service.sync_activities()
        history = service.sync_history[-1]
        assert history["upserted"] == 1
        assert history["errors"] == 1
        assert history["status"] == "completed_with_errors"

    @pytest.mark.asyncio
    async def test_history_entry_shape_on_success(
        self, service, mock_sf, mock_conn
    ):
        """After a successful no-op sync (no SF records), history gets
        one entry with the canonical keys the UI reads."""
        await service.sync_activities()
        assert len(service.sync_history) == 1
        entry = service.sync_history[-1]
        assert entry["type"] == "activity_sync"
        assert entry["status"] == "completed"
        assert "timestamp" in entry
        assert "upserted" in entry
        assert "skipped_deleted" in entry
        assert "errors" in entry
        assert "details" in entry

    @pytest.mark.asyncio
    async def test_watermark_reads_from_activity_table_filtered_by_salesforce(
        self, service, mock_conn
    ):
        """The watermark query must scope to source='salesforce' so Gmail-
        synced / manual activities don't influence the SF incremental
        watermark. Guards the source filter."""
        await service.sync_activities()
        # fetchval was called with exactly the watermark SELECT
        args = mock_conn.fetchval.call_args[0]
        sql = args[0]
        assert "MAX(sf_last_modified)" in sql
        assert "bedrock.activity" in sql
        assert "source = 'salesforce'" in sql
