"""Shared fakes for jobs eval modules.

No live DB / SF / network. A FakeConn dispatches SQL by substring and records
every call; FakeSalesforce records queries/creates. make_jobs_client() wires
the FastAPI dependency overrides used across the jobs endpoints.

This is NOT a test module (no test_ prefix) so pytest imports it as a helper.
"""

from main import app, get_current_user
from auth import require_auth
from db import get_db
from dependencies import require_sf_mcp_client as deps_require_sf_mcp_client
from fastapi.testclient import TestClient


class FakeTxn:
    async def __aenter__(self): return None
    async def __aexit__(self, *a): return False


class FakeConn:
    """Query-aware fake asyncpg connection.

    rows/lists/vals are {sql_substring: result} maps consulted in insertion
    order; the first substring found in the query wins. Every call is recorded
    in .calls as (kind, query, args) so tests can assert what SQL ran.
    """
    def __init__(self, rows=None, lists=None, vals=None):
        self.rows = rows or {}      # fetchrow dispatch
        self.lists = lists or {}    # fetch dispatch
        self.vals = vals or {}      # fetchval dispatch
        self.calls: list[tuple] = []

    def transaction(self):
        return FakeTxn()

    def _match(self, table, query, default):
        for needle, val in table.items():
            if needle in query:
                return val
        return default

    async def fetchrow(self, query, *args):
        self.calls.append(("fetchrow", query, args))
        return self._match(self.rows, query, None)

    async def fetch(self, query, *args):
        self.calls.append(("fetch", query, args))
        return self._match(self.lists, query, [])

    async def fetchval(self, query, *args):
        self.calls.append(("fetchval", query, args))
        return self._match(self.vals, query, None)

    async def execute(self, query, *args):
        self.calls.append(("execute", query, args))
        return self._match(self.vals, query, "OK")

    # helpers for assertions
    def queries(self, kind=None):
        return [c[1] for c in self.calls if kind is None or c[0] == kind]

    def executed(self, needle):
        return [c for c in self.calls if c[0] == "execute" and needle in c[1]]

    def ran(self, needle):
        return any(needle in c[1] for c in self.calls)


class FakeSalesforce:
    def __init__(self, query_results=None, create_ids=None):
        self.queries: list[str] = []
        self.creates: list[tuple] = []
        self._qr = query_results or {}
        self._ids = create_ids or {}

    async def query(self, soql):
        self.queries.append(soql)
        for needle, res in self._qr.items():
            if needle in soql:
                return res
        return {"records": []}

    async def query_all(self, soql):
        return await self.query(soql)

    async def create_record(self, sobject, data):
        self.creates.append((sobject, data))
        return {"id": self._ids.get(sobject, f"NEW{sobject}")}


class FakeClient:
    def __init__(self, sf):
        self.salesforce = sf


DEFAULT_USER = {"email": "tester@pursuit.org", "user_id": "tester@pursuit.org"}


def make_jobs_client(conn, sf=None, user=None):
    """TestClient with require_auth + get_db (+ SF) overridden. Caller should
    clear app.dependency_overrides afterward (the autouse fixture does)."""
    u = user or DEFAULT_USER
    app.dependency_overrides[require_auth] = lambda: u
    app.dependency_overrides[get_current_user] = lambda: u
    app.dependency_overrides[get_db] = lambda: conn
    app.dependency_overrides[deps_require_sf_mcp_client] = lambda: FakeClient(sf or FakeSalesforce())
    return TestClient(app, raise_server_exceptions=False)
