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
    ) -> tuple[FastAPI, AsyncMock, _FakeClient]:
        # Reset module-level client so we don't leak between tests.
        pebble_proxy._client = None

        fake_client = _FakeClient(pebble_stream or _FakePebbleStream())

        def _fake_get_client():
            pebble_proxy._client = fake_client
            return fake_client

        monkeypatch.setattr(pebble_proxy, "_get_pebble_client", _fake_get_client)

        # Mock pool / conn for audit insert.
        mock_conn = AsyncMock()
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
    stream = _FakePebbleStream(
        status_code=500,
        chunks=[b'{"detail":"internal"}'],
    )
    app, _, _ = app_factory(pebble_stream=stream)
    with TestClient(app) as client:
        with client.stream("POST", "/api/pebble/ask", json={"query": "x"}) as r:
            body = b"".join(r.iter_bytes())
    assert b'"type":"error"' in body
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
    assert b'"type":"error"' in body
    assert b'"reason":"timeout"' in body


def test_other_http_error_returns_upstream_error(app_factory):
    stream = _FakePebbleStream(raise_exc=httpx.ConnectError("upstream down"))
    app, _, _ = app_factory(pebble_stream=stream)
    with TestClient(app) as client:
        with client.stream("POST", "/api/pebble/ask", json={"query": "x"}) as r:
            body = b"".join(r.iter_bytes())
    assert b'"type":"error"' in body
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

def test_service_caller_originating_user_propagated(app_factory):
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
    pebble_proxy._get_pebble_client = lambda: CaptureClient()

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
