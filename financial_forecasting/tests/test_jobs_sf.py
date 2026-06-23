"""Validation evals for the jobs → Salesforce bridge (routes/jobs_sf.py).

We can't hit the live SF org from CI/dev, so these tests mock Salesforce with
a recorder and the DB with a query-aware fake. They assert the two things that
actually matter for correctness:

  1. the exact Salesforce payload/SOQL we send (field mapping, RecordType
     lookup, dedup queries, Amount-only-when-set), and
  2. the local→SF link-back we persist (sf_contact_link / jobs_account /
     jobs_opportunity.sf_opportunity_id).

Pure helpers (_split_name, _soql_str) are tested directly.
"""

import pytest
from fastapi.testclient import TestClient

from main import app, get_current_user
from auth import require_auth
from db import get_db
from dependencies import require_sf_mcp_client as deps_require_sf_mcp_client

import routes.jobs_sf as jobs_sf


# ── pure helpers ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("row,expected", [
    ({"first_name": "Abigal", "last_name": "Spigarelli", "full_name": "Abigal Spigarelli"}, ("Abigal", "Spigarelli")),
    ({"first_name": None, "last_name": None, "full_name": "Abigal Spigarelli"}, ("Abigal", "Spigarelli")),
    ({"first_name": None, "last_name": None, "full_name": "Mary Anne Van Der Berg"}, ("Mary Anne Van Der", "Berg")),
    ({"first_name": None, "last_name": None, "full_name": "Cher"}, (None, "Cher")),
    ({"first_name": "", "last_name": "", "full_name": ""}, (None, None)),
])
def test_split_name(row, expected):
    assert jobs_sf._split_name(row) == expected


@pytest.mark.parametrize("raw,expected", [
    ("O'Brien", "O\\'Brien"),
    ("Plastic Labs", "Plastic Labs"),
    ("a\\b", "a\\\\b"),
])
def test_soql_escaping(raw, expected):
    assert jobs_sf._soql_str(raw) == expected


# ── fakes ─────────────────────────────────────────────────────────────────────

class FakeSalesforce:
    """Records every query/create and returns scripted results."""
    def __init__(self, query_results=None, create_ids=None):
        self.queries: list[str] = []
        self.creates: list[tuple[str, dict]] = []
        self._query_results = query_results or {}   # substring -> {"records": [...]}
        self._create_ids = create_ids or {}         # sobject -> id

    async def query(self, soql):
        self.queries.append(soql)
        for needle, res in self._query_results.items():
            if needle in soql:
                return res
        return {"records": []}

    async def query_all(self, soql):
        return await self.query(soql)

    async def create_record(self, sobject, data):
        self.creates.append((sobject, data))
        return {"id": self._create_ids.get(sobject, f"NEW{sobject}")}


class FakeClient:
    def __init__(self, sf):
        self.salesforce = sf


class FakeTxn:
    async def __aenter__(self): return None
    async def __aexit__(self, *a): return False


class FakeConn:
    """Query-aware fake asyncpg connection. fetchrow dispatches on SQL text;
    execute() calls are recorded so we can assert the link-back."""
    def __init__(self, rows=None):
        self.rows = rows or {}          # substring -> row dict (or None)
        self.executes: list[tuple] = []

    def transaction(self):
        return FakeTxn()

    async def fetchrow(self, query, *args):
        for needle, row in self.rows.items():
            if needle in query:
                return row
        return None

    async def fetch(self, query, *args):
        return []

    async def fetchval(self, query, *args):
        return None

    async def execute(self, query, *args):
        self.executes.append((query, args))
        return "OK"


def make_client(sf_conn, sf):
    """Build a TestClient with auth + db + SF overridden."""
    user = {"email": "tester@pursuit.org", "user_id": "tester@pursuit.org"}
    app.dependency_overrides[require_auth] = lambda: user
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: sf_conn
    app.dependency_overrides[deps_require_sf_mcp_client] = lambda: FakeClient(sf)
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _clear_overrides():
    yield
    app.dependency_overrides.clear()


CONTACT_SQL = "FROM public.contacts WHERE contact_id"
LINK_SQL = "FROM bedrock.sf_contact_link WHERE public_contact_id"


# ── contact: status ───────────────────────────────────────────────────────────

def test_contact_status_local_only_derives_first_name():
    conn = FakeConn({
        CONTACT_SQL: {"contact_id": 1, "first_name": None, "last_name": None,
                      "full_name": "Abigal Spigarelli", "email": None, "current_title": "Eng",
                      "current_company": "Plastic Labs", "linkedin_url": "u", "airtable_id": "a"},
        LINK_SQL: None,
    })
    c = make_client(conn, FakeSalesforce())
    r = c.get("/api/jobs/sf/contact/1")
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["linked"] is False
    assert d["proposed"]["FirstName"] == "Abigal"
    assert d["proposed"]["LastName"] == "Spigarelli"
    assert d["company"] == "Plastic Labs"


# ── contact: promote (create) ──────────────────────────────────────────────────

def test_promote_contact_create_with_new_account():
    conn = FakeConn({
        CONTACT_SQL: {"contact_id": 1, "first_name": None, "last_name": None,
                      "full_name": "Abigal Spigarelli", "email": "a@x.com", "current_title": "Eng",
                      "current_company": "Plastic Labs", "linkedin_url": "https://li/abi", "airtable_id": "a"},
        LINK_SQL: None,
    })
    sf = FakeSalesforce(create_ids={"Account": "001ACC", "Contact": "003CON"})
    c = make_client(conn, sf)
    r = c.post("/api/jobs/sf/promote-contact", json={
        "contact_id": 1, "mode": "create",
        "account": {"mode": "create", "name": "Plastic Labs"},
    })
    assert r.status_code == 200, r.text
    assert r.json()["data"] == {"sf_contact_id": "003CON", "sf_account_id": "001ACC", "linked": True}

    # account created first, then contact with the right field mapping + AccountId
    assert sf.creates[0] == ("Account", {"Name": "Plastic Labs"})
    sobj, data = sf.creates[1]
    assert sobj == "Contact"
    assert data["FirstName"] == "Abigal" and data["LastName"] == "Spigarelli"
    assert data["Email"] == "a@x.com" and data["Title"] == "Eng"
    assert data["LinkedIn_URL__c"] == "https://li/abi"
    assert data["AccountId"] == "001ACC"

    # link-back persisted (DELETE then INSERT into sf_contact_link)
    inserts = [e for e in conn.executes if "INSERT INTO bedrock.sf_contact_link" in e[0]]
    assert len(inserts) == 1
    assert inserts[0][1][0] == "003CON" and inserts[0][1][1] == 1 and inserts[0][1][2] == "001ACC"


def test_promote_contact_create_omits_empty_fields():
    conn = FakeConn({
        CONTACT_SQL: {"contact_id": 2, "first_name": "Jo", "last_name": "Lee",
                      "full_name": "Jo Lee", "email": None, "current_title": None,
                      "current_company": None, "linkedin_url": None, "airtable_id": "a"},
        LINK_SQL: None,
    })
    sf = FakeSalesforce(create_ids={"Contact": "003CON2"})
    c = make_client(conn, sf)
    r = c.post("/api/jobs/sf/promote-contact", json={"contact_id": 2, "mode": "create", "account": {"mode": "none"}})
    assert r.status_code == 200, r.text
    sobj, data = sf.creates[0]
    assert sobj == "Contact"
    # None/empty fields must NOT be sent to SF
    assert data == {"FirstName": "Jo", "LastName": "Lee"}


# ── contact: promote (link existing) ────────────────────────────────────────────

def test_promote_contact_link_existing_no_create():
    conn = FakeConn({CONTACT_SQL: {"contact_id": 3, "first_name": "A", "last_name": "B",
                                   "full_name": "A B", "email": None, "current_title": None,
                                   "current_company": None, "linkedin_url": None, "airtable_id": "a"},
                     LINK_SQL: None})
    sf = FakeSalesforce(query_results={"FROM Contact WHERE Id": {"records": [{"AccountId": "001EXIST"}]}})
    c = make_client(conn, sf)
    r = c.post("/api/jobs/sf/promote-contact", json={
        "contact_id": 3, "mode": "link", "sf_contact_id": "003LINKED", "account": {"mode": "none"},
    })
    assert r.status_code == 200, r.text
    assert sf.creates == []   # linking never creates
    inserts = [e for e in conn.executes if "INSERT INTO bedrock.sf_contact_link" in e[0]]
    assert inserts[0][1][0] == "003LINKED"
    assert inserts[0][1][2] == "001EXIST"   # adopts the existing contact's account


def test_promote_contact_already_linked_409():
    conn = FakeConn({CONTACT_SQL: {"contact_id": 4, "first_name": "A", "last_name": "B",
                                   "full_name": "A B", "email": None, "current_title": None,
                                   "current_company": None, "linkedin_url": None, "airtable_id": "a"},
                     LINK_SQL: {"sf_contact_id": "003OLD", "sf_account_id": None,
                                "matched_by": "x", "matched_at": None}})
    c = make_client(conn, FakeSalesforce())
    r = c.post("/api/jobs/sf/promote-contact", json={"contact_id": 4, "mode": "create", "account": {"mode": "none"}})
    assert r.status_code == 409


# ── dedup search ────────────────────────────────────────────────────────────────

def test_search_contacts_email_then_name():
    sf = FakeSalesforce(query_results={"Email = ": {"records": [
        {"Id": "003A", "Name": "Sam Roe", "Email": "s@x.com", "Title": "PM",
         "AccountId": "001A", "Account": {"Name": "Acme"}}]}})
    c = make_client(FakeConn(), sf)
    r = c.get("/api/jobs/sf/search-contacts?email=s@x.com&name=Sam&company=Acme")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["exact_email_match"] is True
    assert d["candidates"][0]["account_name"] == "Acme"
    # both an email query and a name+company query were issued
    assert any("Email = " in q for q in sf.queries)
    assert any("Name LIKE" in q and "Account.Name LIKE" in q for q in sf.queries)


# ── account promote ─────────────────────────────────────────────────────────────

def test_promote_account_create_and_link_back():
    conn = FakeConn()
    sf = FakeSalesforce(create_ids={"Account": "001NEWACC"})
    c = make_client(conn, sf)
    r = c.post("/api/jobs/sf/promote-account", json={
        "account_key": "plastic-labs", "display_name": "Plastic Labs", "mode": "create"})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["sf_account_id"] == "001NEWACC"
    assert sf.creates[0] == ("Account", {"Name": "Plastic Labs"})
    upserts = [e for e in conn.executes if "INSERT INTO bedrock.jobs_account" in e[0]]
    assert upserts and upserts[0][1] == ("plastic-labs", "Plastic Labs", "001NEWACC")


def test_promote_account_link_no_create():
    conn = FakeConn()
    sf = FakeSalesforce()
    c = make_client(conn, sf)
    r = c.post("/api/jobs/sf/promote-account", json={
        "account_key": "acme", "display_name": "Acme", "mode": "link", "sf_account_id": "001EXIST"})
    assert r.status_code == 200, r.text
    assert sf.creates == []
    upserts = [e for e in conn.executes if "INSERT INTO bedrock.jobs_account" in e[0]]
    assert upserts[0][1][2] == "001EXIST"


# ── opportunity → PBC handoff ────────────────────────────────────────────────────

OPP_SQL = "FROM bedrock.jobs_opportunity WHERE id"
RT_SQL = "FROM RecordType WHERE SobjectType = 'Opportunity'"


def _opp_conn(sf_opp_id=None):
    return FakeConn({OPP_SQL: {"id": "o1", "account_name": "Acme", "sf_opportunity_id": sf_opp_id}})


def test_handoff_creates_pbc_opp_and_links_back():
    conn = _opp_conn()
    sf = FakeSalesforce(
        query_results={RT_SQL: {"records": [{"Id": "012PBC"}]}},
        create_ids={"Opportunity": "006NEWOPP"},
    )
    c = make_client(conn, sf)
    r = c.post("/api/jobs/sf/handoff-opportunity", json={
        "opp_id": "o1", "name": "Acme — PBC", "stage": "Qualifying",
        "amount": 50000, "close_date": "2026-09-01", "account_sf_id": "001ACC",
    })
    assert r.status_code == 200, r.text
    assert r.json()["data"]["sf_opportunity_id"] == "006NEWOPP"
    sobj, data = sf.creates[0]
    assert sobj == "Opportunity"
    assert data["RecordTypeId"] == "012PBC"          # looked up by name, not hardcoded
    assert data["AccountId"] == "001ACC"
    assert data["StageName"] == "Qualifying"
    assert data["CloseDate"] == "2026-09-01"
    assert data["Amount"] == 50000
    # link-back onto the jobs opp
    ups = [e for e in conn.executes if "SET sf_opportunity_id" in e[0]]
    assert ups and ups[0][1] == ("006NEWOPP", "o1")


def test_handoff_omits_amount_when_absent():
    conn = _opp_conn()
    sf = FakeSalesforce(query_results={RT_SQL: {"records": [{"Id": "012PBC"}]}},
                        create_ids={"Opportunity": "006X"})
    c = make_client(conn, sf)
    r = c.post("/api/jobs/sf/handoff-opportunity", json={
        "opp_id": "o1", "name": "Acme", "stage": "New Lead",
        "close_date": "2026-09-01", "account_sf_id": "001ACC"})
    assert r.status_code == 200, r.text
    _, data = sf.creates[0]
    assert "Amount" not in data            # don't send a salary-less Amount


def test_handoff_requires_account():
    conn = _opp_conn()
    sf = FakeSalesforce(query_results={RT_SQL: {"records": [{"Id": "012PBC"}]}})
    c = make_client(conn, sf)
    r = c.post("/api/jobs/sf/handoff-opportunity", json={
        "opp_id": "o1", "name": "Acme", "stage": "New Lead", "close_date": "2026-09-01"})
    assert r.status_code == 400


def test_handoff_missing_pbc_record_type_502():
    conn = _opp_conn()
    sf = FakeSalesforce(query_results={RT_SQL: {"records": []}})  # no PBC record type
    c = make_client(conn, sf)
    r = c.post("/api/jobs/sf/handoff-opportunity", json={
        "opp_id": "o1", "name": "Acme", "stage": "New Lead",
        "close_date": "2026-09-01", "account_sf_id": "001ACC"})
    assert r.status_code == 502
    assert sf.creates == []          # never created an opp without a record type


def test_handoff_already_done_409():
    conn = _opp_conn(sf_opp_id="006ALREADY")
    c = make_client(conn, FakeSalesforce())
    r = c.post("/api/jobs/sf/handoff-opportunity", json={
        "opp_id": "o1", "name": "Acme", "stage": "New Lead",
        "close_date": "2026-09-01", "account_sf_id": "001ACC"})
    assert r.status_code == 409
