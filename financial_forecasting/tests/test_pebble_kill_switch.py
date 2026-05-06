"""Tests for the Pebble write kill switch in ``require_auth_or_internal``.

Plan v1 §0.5 — a runtime flag that blocks Pebble's internal-key write paths
during incidents without requiring a redeploy. Reads via the same internal
key, and all JWT-authenticated requests, are unaffected.

Invariants locked in here:
1. Switch off → POST with valid internal key returns the synthetic service user.
2. Switch on  → POST/PUT/PATCH/DELETE with valid internal key raises 503.
3. Switch on  → GET with valid internal key still returns the service user.
4. Switch on  → request without internal key falls through to ``require_auth``.
5. Switch on  → request with WRONG internal key falls through to ``require_auth``
   (we don't 503 a JWT-authed user just because their cookie happened to ride
   alongside a stray header).
"""

import os
import sys
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import auth


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TEST_KEY = "test-internal-key-1234567890abcdef"


def _make_request(method: str, internal_key: str = "") -> Request:
    """Build a minimal Starlette Request scope with the given method and
    optional X-Internal-Key header. Avoids the TestClient round-trip — we're
    unit-testing a dependency, not an endpoint.
    """
    headers = []
    if internal_key:
        headers.append((b"x-internal-key", internal_key.encode()))
    scope = {
        "type": "http",
        "method": method,
        "headers": headers,
        "path": "/api/pebble-test",
        "query_string": b"",
    }
    return Request(scope)


@pytest.fixture
def fixed_internal_key(monkeypatch):
    """Pin the module-level ``_BEDROCK_INTERNAL_API_KEY`` to a known value so
    the hmac.compare_digest path is exercised. Module-level constants in
    ``auth.py`` read os.environ at import time, so we patch the symbol
    directly rather than the env var.
    """
    monkeypatch.setattr(auth, "_BEDROCK_INTERNAL_API_KEY", _TEST_KEY)
    return _TEST_KEY


@pytest.fixture
def switch_off(monkeypatch):
    monkeypatch.delenv("PEBBLE_WRITES_DISABLED", raising=False)


@pytest.fixture
def switch_on(monkeypatch):
    monkeypatch.setenv("PEBBLE_WRITES_DISABLED", "true")


# ---------------------------------------------------------------------------
# Helper-function unit tests
# ---------------------------------------------------------------------------

def test_pebble_writes_disabled_default_off(monkeypatch):
    monkeypatch.delenv("PEBBLE_WRITES_DISABLED", raising=False)
    assert auth._pebble_writes_disabled() is False


@pytest.mark.parametrize("value", ["true", "TRUE", "True", "1", "yes", "  true  "])
def test_pebble_writes_disabled_truthy_values(monkeypatch, value):
    monkeypatch.setenv("PEBBLE_WRITES_DISABLED", value)
    assert auth._pebble_writes_disabled() is True


@pytest.mark.parametrize("value", ["false", "0", "no", "", "off", "disabled"])
def test_pebble_writes_disabled_falsy_values(monkeypatch, value):
    monkeypatch.setenv("PEBBLE_WRITES_DISABLED", value)
    assert auth._pebble_writes_disabled() is False


# ---------------------------------------------------------------------------
# Behavior tests for require_auth_or_internal
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_internal_key_write_succeeds_when_switch_off(fixed_internal_key, switch_off):
    """Invariant 1: switch off → POST with valid key returns the service user."""
    request = _make_request("POST", fixed_internal_key)
    user = await auth.require_auth_or_internal(request)
    assert user["is_service"] is True
    assert user["user_id"] == "service:pebble"
    assert user["email"] == "pebble@internal"


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
@pytest.mark.asyncio
async def test_internal_key_writes_blocked_when_switch_on(
    fixed_internal_key, switch_on, method,
):
    """Invariant 2: switch on → all write methods 503 with the structured
    error payload that callers (e.g. crm_bridge.py) can branch on."""
    request = _make_request(method, fixed_internal_key)
    with pytest.raises(HTTPException) as exc_info:
        await auth.require_auth_or_internal(request)
    assert exc_info.value.status_code == 503
    assert exc_info.value.detail["error"] == "pebble_writes_disabled"


@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS"])
@pytest.mark.asyncio
async def test_internal_key_reads_succeed_when_switch_on(
    fixed_internal_key, switch_on, method,
):
    """Invariant 3: switch on → reads via internal key still work, so
    Pebble's research/lookup paths keep functioning during write incidents.
    """
    request = _make_request(method, fixed_internal_key)
    user = await auth.require_auth_or_internal(request)
    assert user["is_service"] is True


@pytest.mark.asyncio
async def test_jwt_write_unaffected_by_switch(fixed_internal_key, switch_on, monkeypatch):
    """Invariant 4: switch on but no internal key → falls through to
    ``require_auth``. JWT-authed users still write normally.
    """
    fake_user = {"user_id": "u-1", "email": "real-user@pursuit.org", "is_service": False}
    monkeypatch.setattr(auth, "require_auth", AsyncMock(return_value=fake_user))
    request = _make_request("POST")  # no X-Internal-Key
    user = await auth.require_auth_or_internal(request)
    assert user is fake_user


@pytest.mark.asyncio
async def test_wrong_internal_key_falls_through_when_switch_on(
    fixed_internal_key, switch_on, monkeypatch,
):
    """Invariant 5: switch on but key is wrong → don't 503, fall through to
    ``require_auth``. A 503 here would leak that the kill switch is on to
    unauthenticated callers and would penalize JWT users whose client
    happened to send a stale header.
    """
    fake_user = {"user_id": "u-2", "email": "another@pursuit.org", "is_service": False}
    monkeypatch.setattr(auth, "require_auth", AsyncMock(return_value=fake_user))
    request = _make_request("POST", "wrong-key-not-the-real-one")
    user = await auth.require_auth_or_internal(request)
    assert user is fake_user
