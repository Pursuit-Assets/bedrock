"""Evals for GET /accounts — the account-hub status derivation.

Status vocabulary: Pursuing (any open opp) > Stewarding (won, none open) >
Re-activating (all stale but recent) / Dormant (all stale, old) > Prospect
(prospects only, no opps). Plus owner + sf_account_id overrides from
bedrock.jobs_account, and the deal_type filter.
"""
from datetime import datetime, timezone

import pytest

from tests.jobs_fakes import FakeConn, make_jobs_client

OPP_SQL = "FROM bedrock.jobs_opportunity"
PROSPECT_SQL = "coalesce(trim(current_company)"
JA_SQL = "account_key, owner_email, status_override, sf_account_id"  # the override-record SELECT (not jobs_account_task)

RECENT = datetime(2026, 6, 1, tzinfo=timezone.utc)   # within 90d of 2026-06-21
OLD = datetime(2025, 1, 1, tzinfo=timezone.utc)      # > 90d


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


def _opp(account_name, stage, **ov):
    row = {"id": "o1", "account_id": None, "account_name": account_name, "stage": stage,
           "deal_type": "ft", "title": "Eng", "owner_email": "a@p.org", "priority": None,
           "num_roles": 1, "likelihood": None, "updated_at": RECENT}
    row.update(ov)
    return row


def _conn(opps=None, prospects=None, ja=None):
    return FakeConn(lists={OPP_SQL: opps or [], PROSPECT_SQL: prospects or [], JA_SQL: ja or []})


def _find(data, name):
    return next(a for a in data if a["account"] == name)


def _accounts(conn):
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/accounts")
    assert r.status_code == 200, r.text
    return r.json()["data"]


@pytest.mark.parametrize("stage,expected", [
    ("active_in_discussions", "Pursuing"),
    ("initial_outreach", "Pursuing"),
    ("active_builder_interview", "Pursuing"),
    ("closed_won", "Stewarding"),
])
def test_status_open_and_won(stage, expected):
    data = _accounts(_conn(opps=[_opp("Acme", stage)]))
    assert _find(data, "Acme")["account_status"] == expected


def test_status_reactivating_when_recent_stale():
    data = _accounts(_conn(opps=[_opp("Acme", "closed_lost", updated_at=RECENT)]))
    assert _find(data, "Acme")["account_status"] == "Re-activating"


def test_status_dormant_when_old_stale():
    data = _accounts(_conn(opps=[_opp("Acme", "on_hold_not_responsive", updated_at=OLD)]))
    assert _find(data, "Acme")["account_status"] == "Dormant"


def test_status_prospect_when_only_contacts():
    prospects = [{"contact_id": 1, "full_name": "Jo", "email": "j@x.com", "current_title": "PM",
                  "current_company": "Acme", "contact_stage": "lead", "linkedin_url": None,
                  "updated_at": RECENT}]
    data = _accounts(_conn(prospects=prospects))
    acc = _find(data, "Acme")
    assert acc["account_status"] == "Prospect"
    assert acc["prospect_count"] == 1 and acc["opp_count"] == 0


def test_status_override_wins():
    ja = [{"account_key": "acme", "owner_email": None, "status_override": "Dormant", "sf_account_id": None}]
    data = _accounts(_conn(opps=[_opp("Acme", "active_in_discussions")], ja=ja))
    assert _find(data, "Acme")["account_status"] == "Dormant"   # override beats derived "Pursuing"


def test_owner_and_sf_account_overrides():
    ja = [{"account_key": "acme", "owner_email": "boss@p.org", "status_override": None, "sf_account_id": "001PIN"}]
    data = _accounts(_conn(opps=[_opp("Acme", "active_in_discussions", owner_email="a@p.org")], ja=ja))
    acc = _find(data, "Acme")
    assert acc["owner_email"] == "boss@p.org"     # stored owner wins over derived
    assert acc["account_id"] == "001PIN"          # explicit SF link wins


def test_account_id_derived_from_sf_opp():
    data = _accounts(_conn(opps=[_opp("Acme", "active_in_discussions", account_id="001REAL")]))
    assert _find(data, "Acme")["account_id"] == "001REAL"


def test_deal_type_filter_excludes_nonmatching():
    conn = _conn(opps=[_opp("Acme", "active_in_discussions", deal_type="capstone")])
    c = make_jobs_client(conn)
    r = c.get("/api/jobs/accounts?deal_type=ft")
    assert r.status_code == 200, r.text
    assert all(a["account"] != "Acme" for a in r.json()["data"])   # capstone-only account filtered out
