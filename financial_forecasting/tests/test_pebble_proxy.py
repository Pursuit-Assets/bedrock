"""Tests for ``/api/pebble/ask`` proxy (Layer 3.1).

Asserts:
  A. Happy path: 200 + streamed content forwarded.
  B. Pebble error status surfaces via SSE error frame.
  C. Pebble timeout → 504-shaped error frame.
  D. Pydantic validation rejects empty/oversized query.
  E. Audit row written with mode='ask' via BackgroundTask.
  F. Trace id propagated: header in / out.
  G. Service caller's originating_user_email becomes Pebble's X-User-Email.
  H. close() shuts the singleton client.
"""

import asyncio
import os
import sys
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient

import httpx

from db import get_db
from routes import pebble_proxy


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _FakePebbleStream:
    """Mimics ``httpx.AsyncClient.stream`` async-context manager."""
    def __init__(self, status_code: int = 200, chunks: list[bytes] | None = None,
                 raise_exc: BaseException | None = None):
        self.status_code = status_code
        self._chunks = chunks or [b'data: {"type":"token","text":"hi"}\n\n']
        self._raise = raise_exc

    async def __aenter__(self):
        if self._raise:
            raise self._raise
        return self

    async def __aexit__(self, *_a):
        return None

    async def aiter_bytes(self):
        for chunk in self._chunks:
            yield chunk

    async def aread(self):
        return b"".join(self._chunks)


class _FakeClient:
    def __init__(self, stream_response: _FakePebbleStream):
        self._stream = stream_response
        self.is_closed = False

    def stream(self, method, url, **kwargs):
        return self._stream

    async def aclose(self):
        self.is_closed = True


@pytest.fixture
def app_factory(monkeypatch):
    def _build(
        *,
        pebble_stream: _FakePebbleStream | None = None,
        user: dict | None = None,
        today_cost: float = 0.0,
        today_count: int = 0,
    ) -> tuple[FastAPI, AsyncMock, _FakeClient]:
        # Reset module-level client so we don't leak between tests.
        pebble_proxy._client = None

        fake_client = _FakeClient(pebble_stream or _FakePebbleStream())

        def _fake_get_client():
            pebble_proxy._client = fake_client
            return fake_client

        monkeypatch.setattr(pebble_proxy, "_get_pebble_client", _fake_get_client)

        # Mock pool / conn — handles BOTH the cost-read SELECT and the
        # audit-insert. The fixture's today_cost / today_count drive
        # the SELECT response.
        mock_conn = AsyncMock()

        async def _fake_fetchrow(sql, *args):
            if "FROM bedrock.pebble_daily_usage" in sql:
                return {"cost": today_cost, "qcount": today_count}
            return None

        mock_conn.fetchrow = _fake_fetchrow
        mock_conn.execute = AsyncMock(return_value="INSERT 0 1")

        @asynccontextmanager
        async def _acquire():
            yield mock_conn

        mock_pool = MagicMock()
        mock_pool.acquire = lambda: _acquire()

        async def _override_db():
            return mock_pool

        async def _override_perm(request=None):
            return user or {
                "user_id": "u-1", "email": "rm@pursuit.org",
                "is_service": False,
            }

        app = FastAPI()
        app.include_router(pebble_proxy.router)
        app.dependency_overrides[get_db] = _override_db
        app.dependency_overrides[pebble_proxy.require_ask_perm] = _override_perm

        return app, mock_conn, fake_client

    return _build


# ---------------------------------------------------------------------------
# A. Happy path
# ---------------------------------------------------------------------------

def test_happy_path_streams_response(app_factory):
    stream = _FakePebbleStream(
        status_code=200,
        chunks=[
            b'data: {"type":"token","text":"hello"}\n\n',
            b'data: {"type":"token","text":" world"}\n\n',
            b'data: {"type":"done"}\n\n',
        ],
    )
    app, _, _ = app_factory(pebble_stream=stream)
    with TestClient(app) as client:
        with client.stream("POST", "/api/pebble/ask", json={"query": "find acme"}) as r:
            body = b"".join(r.iter_bytes())
    assert b'hello' in body
    assert b'done' in body


# ---------------------------------------------------------------------------
# B. Pebble error → SSE error frame
# ---------------------------------------------------------------------------

def test_pebble_error_status_surfaces_as_sse_error(app_factory):
    """Proxy emits {kind:'error', payload:{phase, reason, status}} per
    the canonical orchestrator event shape (post-2026-05-08 protocol switch)."""
    stream = _FakePebbleStream(
        status_code=500,
        chunks=[b'{"detail":"internal"}'],
    )
    app, _, _ = app_factory(pebble_stream=stream)
    with TestClient(app) as client:
        with client.stream("POST", "/api/pebble/ask", json={"query": "x"}) as r:
            body = b"".join(r.iter_bytes())
    assert b'"kind":"error"' in body
    assert b'"phase":"proxy"' in body
    assert b'"status":500' in body


# ---------------------------------------------------------------------------
# C. Timeout
# ---------------------------------------------------------------------------

def test_timeout_returns_sse_error_frame(app_factory):
    stream = _FakePebbleStream(raise_exc=httpx.TimeoutException("boom"))
    app, _, _ = app_factory(pebble_stream=stream)
    with TestClient(app) as client:
        with client.stream("POST", "/api/pebble/ask", json={"query": "x"}) as r:
            body = b"".join(r.iter_bytes())
    assert b'"kind":"error"' in body
    assert b'"reason":"timeout"' in body


def test_other_http_error_returns_upstream_error(app_factory):
    stream = _FakePebbleStream(raise_exc=httpx.ConnectError("upstream down"))
    app, _, _ = app_factory(pebble_stream=stream)
    with TestClient(app) as client:
        with client.stream("POST", "/api/pebble/ask", json={"query": "x"}) as r:
            body = b"".join(r.iter_bytes())
    assert b'"kind":"error"' in body
    assert b'"reason":"upstream"' in body


# ---------------------------------------------------------------------------
# D. Pydantic validation
# ---------------------------------------------------------------------------

def test_empty_query_returns_422(app_factory):
    app, _, _ = app_factory()
    with TestClient(app) as client:
        r = client.post("/api/pebble/ask", json={"query": ""})
    assert r.status_code == 422


def test_oversized_query_returns_422(app_factory):
    app, _, _ = app_factory()
    payload = {"query": "x" * 2001}
    with TestClient(app) as client:
        r = client.post("/api/pebble/ask", json=payload)
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# E. Audit row written
# ---------------------------------------------------------------------------

def test_audit_row_inserted_via_background_task(app_factory):
    app, mock_conn, _ = app_factory()
    with TestClient(app) as client:
        with client.stream("POST", "/api/pebble/ask", json={"query": "find acme"}) as r:
            for _ in r.iter_bytes():
                pass
    # BackgroundTask runs after response in TestClient.
    assert mock_conn.execute.await_count >= 1
    sent_sql = mock_conn.execute.call_args.args[0]
    assert "INSERT INTO bedrock.search_audit" in sent_sql
    assert "mode" in sent_sql.lower()
    assert "ON CONFLICT" in sent_sql


# ---------------------------------------------------------------------------
# F. Trace id propagation
# ---------------------------------------------------------------------------

def test_trace_id_in_response_header(app_factory):
    app, _, _ = app_factory()
    with TestClient(app) as client:
        with client.stream(
            "POST", "/api/pebble/ask",
            json={"query": "x"},
            headers={"X-Trace-Id": "01993b8d-2c9a-7c4f-8b0e-000000000001"},
        ) as r:
            assert r.headers.get("X-Trace-Id") == "01993b8d-2c9a-7c4f-8b0e-000000000001"


def test_invalid_trace_id_minted_fresh(app_factory):
    """Malformed X-Trace-Id is replaced with a fresh UUID, not echoed."""
    app, _, _ = app_factory()
    with TestClient(app) as client:
        with client.stream(
            "POST", "/api/pebble/ask",
            json={"query": "x"},
            headers={"X-Trace-Id": "not-a-uuid"},
        ) as r:
            trace = r.headers.get("X-Trace-Id")
            assert trace and trace != "not-a-uuid"
            import uuid as _uuid
            _uuid.UUID(trace)


# ---------------------------------------------------------------------------
# G. Service caller delegation
# ---------------------------------------------------------------------------

def test_service_caller_originating_user_propagated(app_factory, monkeypatch):
    """When Pebble (service) calls itself, the originating user's email
    becomes Pebble's X-User-Email — not pebble@internal."""
    captured_headers: dict = {}
    chunks = [b'data: {"type":"done"}\n\n']

    class CaptureStream(_FakePebbleStream):
        def __init__(self):
            super().__init__(status_code=200, chunks=chunks)

    captured = {}

    class CaptureClient:
        is_closed = False
        def stream(self, method, url, **kwargs):
            captured["headers"] = kwargs.get("headers", {})
            captured["body"] = kwargs.get("json", {})
            return CaptureStream()

    app, _, _ = app_factory(user={
        "user_id": "service:pebble", "email": "pebble@internal",
        "is_service": True,
        "originating_user_email": "rm@pursuit.org",
        "request_id": "01993b8d-2c9a-7c4f-8b0e-000000000001",
        "scopes": ("*",),
    })
    monkeypatch.setattr(pebble_proxy, "_get_pebble_client", lambda: CaptureClient())

    with TestClient(app) as client:
        with client.stream("POST", "/api/pebble/ask", json={"query": "x"}) as r:
            for _ in r.iter_bytes():
                pass

    assert captured["headers"]["X-User-Email"] == "rm@pursuit.org"


# ---------------------------------------------------------------------------
# H. Helpers
# ---------------------------------------------------------------------------

def test_new_trace_id_mints_when_absent():
    request = MagicMock()
    request.headers = {}
    trace = pebble_proxy._new_trace_id(request)
    import uuid as _uuid
    _uuid.UUID(trace)


def test_new_trace_id_keeps_valid():
    valid = "01993b8d-2c9a-7c4f-8b0e-000000000001"
    request = MagicMock()
    request.headers = {"X-Trace-Id": valid}
    assert pebble_proxy._new_trace_id(request) == valid


@pytest.mark.asyncio
async def test_close_resets_singleton(monkeypatch):
    fake = _FakeClient(_FakePebbleStream())
    pebble_proxy._client = fake
    await pebble_proxy.close()
    assert pebble_proxy._client is None
    assert fake.is_closed is True


# ---------------------------------------------------------------------------
# Cost cap + degraded mode
# ---------------------------------------------------------------------------

def test_cost_cap_exceeded_returns_429(app_factory):
    """User over the daily cap → 429 with structured payload + Retry-After."""
    app, _, _ = app_factory(today_cost=10.0, today_count=42)
    with TestClient(app) as client:
        r = client.post("/api/pebble/ask", json={"query": "x"})
    assert r.status_code == 429
    body = r.json()["detail"]
    assert body["error"] == "daily_cost_cap_exceeded"
    assert body["spent_usd"] == 10.0
    assert body["query_count_today"] == 42
    # Retry-After is positive integer seconds.
    retry = int(r.headers["Retry-After"])
    assert retry >= 60


def test_cost_cap_exceeded_at_exact_limit(app_factory):
    """today_cost == DAILY_COST_LIMIT (>= comparison) — 429."""
    app, _, _ = app_factory(today_cost=pebble_proxy._DAILY_COST_LIMIT_USD)
    with TestClient(app) as client:
        r = client.post("/api/pebble/ask", json={"query": "x"})
    assert r.status_code == 429


def test_cost_cap_below_threshold_passes(app_factory):
    """today_cost < cap → request goes through normally."""
    app, _, _ = app_factory(today_cost=1.50)
    with TestClient(app) as client:
        with client.stream("POST", "/api/pebble/ask", json={"query": "x"}) as r:
            assert r.status_code == 200
            for _ in r.iter_bytes():
                pass


def test_degrade_mode_at_80_percent_sets_force_tier(app_factory, monkeypatch):
    """At 80%+ of cap, proxy adds X-Pebble-Force-Tier: L0 to upstream
    headers + degradation hint headers in response."""
    captured: dict = {}

    class CaptureStream(_FakePebbleStream):
        def __init__(self):
            super().__init__(status_code=200, chunks=[b'data: {"type":"done"}\n\n'])

    class CaptureClient:
        is_closed = False
        def stream(self, method, url, **kwargs):
            captured["headers"] = dict(kwargs.get("headers", {}))
            return CaptureStream()

    app, _, _ = app_factory(
        today_cost=4.5,    # 4.5/5.0 = 90% — degrade
        today_count=20,
    )
    monkeypatch.setattr(pebble_proxy, "_get_pebble_client", lambda: CaptureClient())

    with TestClient(app) as client:
        with client.stream("POST", "/api/pebble/ask", json={"query": "x"}) as r:
            assert r.status_code == 200
            assert r.headers.get("X-Pebble-Degraded") == "true"
            assert r.headers.get("X-Pebble-Cost-Today") == "4.5000"
            assert r.headers.get("X-Pebble-Cost-Limit") == "5.00"
            for _ in r.iter_bytes():
                pass

    # Pebble received the force-tier hint.
    assert captured["headers"].get("X-Pebble-Force-Tier") == "L0"


def test_below_degrade_threshold_no_force_tier(app_factory, monkeypatch):
    """At < 80% of cap, no degrade headers in response or upstream."""
    captured: dict = {}

    class CaptureStream(_FakePebbleStream):
        def __init__(self):
            super().__init__(status_code=200, chunks=[b'data: {"type":"done"}\n\n'])

    class CaptureClient:
        is_closed = False
        def stream(self, method, url, **kwargs):
            captured["headers"] = dict(kwargs.get("headers", {}))
            return CaptureStream()

    app, _, _ = app_factory(today_cost=2.0)    # 40%
    monkeypatch.setattr(pebble_proxy, "_get_pebble_client", lambda: CaptureClient())

    with TestClient(app) as client:
        with client.stream("POST", "/api/pebble/ask", json={"query": "x"}) as r:
            assert r.status_code == 200
            assert "X-Pebble-Degraded" not in r.headers
            for _ in r.iter_bytes():
                pass

    assert "X-Pebble-Force-Tier" not in captured["headers"]


def test_cost_cap_429_emits_audit_row(app_factory):
    """A blocked request is still audited so we can spot anomalous
    spike patterns."""
    app, mock_conn, _ = app_factory(today_cost=99.0)
    with TestClient(app) as client:
        client.post("/api/pebble/ask", json={"query": "x"})
    asyncio.run(asyncio.sleep(0.05))
    # The execute call should be the audit insert.
    assert mock_conn.execute.await_count >= 1
    sent_sql = mock_conn.execute.call_args.args[0]
    assert "INSERT INTO bedrock.search_audit" in sent_sql


# ---------------------------------------------------------------------------
# DB read failure is fail-open
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_read_daily_cost_returns_zero_on_db_failure():
    """A DB error reading pebble_daily_usage must NOT lock users out.
    Fail-open semantics; sustained failures alert separately."""
    failing_conn = AsyncMock()
    failing_conn.fetchrow = AsyncMock(side_effect=RuntimeError("DB down"))

    @asynccontextmanager
    async def _acquire():
        yield failing_conn

    failing_pool = MagicMock()
    failing_pool.acquire = lambda: _acquire()

    cost, count = await pebble_proxy._read_daily_cost(failing_pool, "u@x.org")
    assert cost == 0.0
    assert count == 0


@pytest.mark.asyncio
async def test_read_daily_cost_returns_zero_for_no_row():
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value=None)

    @asynccontextmanager
    async def _acquire():
        yield conn

    pool = MagicMock()
    pool.acquire = lambda: _acquire()

    cost, count = await pebble_proxy._read_daily_cost(pool, "fresh@x.org")
    assert cost == 0.0
    assert count == 0


@pytest.mark.asyncio
async def test_read_daily_cost_returns_zero_for_empty_email():
    """No email = no user-scoped cost lookup; just return zero."""
    pool = MagicMock()
    cost, count = await pebble_proxy._read_daily_cost(pool, "")
    assert cost == 0.0
    assert count == 0


# ---------------------------------------------------------------------------
# Retry-After helper
# ---------------------------------------------------------------------------

def test_seconds_until_midnight_utc_positive_and_bounded():
    seconds = pebble_proxy._seconds_until_midnight_utc()
    assert 60 <= seconds <= 86400
