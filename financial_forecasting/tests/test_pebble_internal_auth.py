"""Tests for Phase 0.2 / 0.4 of the Pebble 1.0 plan — mandatory
``X-Originating-User`` + ``X-Request-Id`` headers and the optional
``X-Pebble-Scopes`` grant on internal-key requests.

Plan ref: tasks/pebble-search-spec.md decisions §3, §4
Adversary refs: pebble-adversary-security.md H1, H3, M3, S1
                pebble-adversary-architecture.md #6
                pebble-adversary-ux.md #4

Invariants locked in:

A. Internal-key + valid headers → synthetic user dict carries
   ``originating_user_email``, ``request_id``, ``scopes``.
B. Internal-key + missing X-Originating-User → 401 ``originating_user_required``.
C. Internal-key + malformed X-Originating-User → 401.
D. Internal-key + missing X-Request-Id → 401 ``request_id_required``.
E. Wrong internal key + missing originating user → fall through to JWT auth
   (we never leak the new contract to unauthenticated callers).
F. JWT auth path is unaffected by the new headers.
G. Custom scope grant via X-Pebble-Scopes parses correctly.
H. Empty / whitespace-only X-Pebble-Scopes falls back to default ``("*",)``.
I. Originating-user shape: long emails, embedded whitespace, missing @ all
   reject; weird-but-valid (subdomains, plus-addressing) accept.
"""

import os
import sys
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import auth


_TEST_KEY = "test-internal-key-abcdef0123456789"
_USER = "rm@pursuit.org"
_REQ = "01993b8d-2c9a-7c4f-8b0e-000000000001"


def _req(
    method: str = "POST",
    *,
    internal_key: str = _TEST_KEY,
    originating_user: str = _USER,
    request_id: str = _REQ,
    scopes: str | None = None,
) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if internal_key:
        headers.append((b"x-internal-key", internal_key.encode()))
    if originating_user:
        headers.append((b"x-originating-user", originating_user.encode()))
    if request_id:
        headers.append((b"x-request-id", request_id.encode()))
    if scopes is not None:
        headers.append((b"x-pebble-scopes", scopes.encode()))
    return Request({
        "type": "http",
        "method": method,
        "headers": headers,
        "path": "/api/pebble-test",
        "query_string": b"",
    })


@pytest.fixture(autouse=True)
def _pin_key(monkeypatch):
    monkeypatch.setattr(auth, "_BEDROCK_INTERNAL_API_KEY", _TEST_KEY)
    monkeypatch.delenv("PEBBLE_WRITES_DISABLED", raising=False)


# ---------------------------------------------------------------------------
# A. Happy path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_synthetic_user_carries_full_contract():
    user = await auth.require_auth_or_internal(_req())
    assert user["is_service"] is True
    assert user["user_id"] == "service:pebble"
    assert user["email"] == "pebble@internal"
    assert user["originating_user_email"] == _USER
    assert user["request_id"] == _REQ
    assert user["scopes"] == ("*",)


# ---------------------------------------------------------------------------
# B. Missing X-Originating-User → 401
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_missing_originating_user_rejected_for_writes():
    with pytest.raises(HTTPException) as exc:
        await auth.require_auth_or_internal(_req(originating_user=""))
    assert exc.value.status_code == 401
    assert exc.value.detail["error"] == "originating_user_required"


@pytest.mark.asyncio
async def test_missing_originating_user_rejected_for_reads_too():
    """Reads via internal key are also gated. Pebble must always carry
    its delegated principal — silent reads on behalf of a phantom user
    are an audit hole."""
    with pytest.raises(HTTPException) as exc:
        await auth.require_auth_or_internal(_req(method="GET", originating_user=""))
    assert exc.value.status_code == 401
    assert exc.value.detail["error"] == "originating_user_required"


# ---------------------------------------------------------------------------
# C. Malformed X-Originating-User → 401
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("bad_email", [
    "no-at-sign",
    "@leading.at",
    "trailing.at@",
    "spaces in the middle@pursuit.org",
    "tabs\tare\tinvalid@pursuit.org",
    "x" * 250 + "@pursuit.org",   # > 254 chars total
])
@pytest.mark.asyncio
async def test_malformed_originating_user_rejected(bad_email):
    with pytest.raises(HTTPException) as exc:
        await auth.require_auth_or_internal(_req(originating_user=bad_email))
    assert exc.value.status_code == 401
    assert exc.value.detail["error"] == "originating_user_required"


@pytest.mark.parametrize("good_email", [
    "rm@pursuit.org",
    "exec.user@pursuit.org",
    "user+tag@pursuit.org",
    "deep.sub.domain@mail.staff.pursuit.org",
    "x@y.co",  # short but valid
])
@pytest.mark.asyncio
async def test_well_formed_originating_user_accepted(good_email):
    user = await auth.require_auth_or_internal(_req(originating_user=good_email))
    assert user["originating_user_email"] == good_email


# ---------------------------------------------------------------------------
# D. Missing X-Request-Id → 401
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_missing_request_id_rejected():
    with pytest.raises(HTTPException) as exc:
        await auth.require_auth_or_internal(_req(request_id=""))
    assert exc.value.status_code == 401
    assert exc.value.detail["error"] == "request_id_required"


# ---------------------------------------------------------------------------
# E. Wrong internal key → fall through to JWT (never leak the new contract)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_wrong_internal_key_falls_through_even_without_originating_user(monkeypatch):
    """A wrong internal key with no originating user must NOT 401 with
    'originating_user_required' — that would leak the contract shape to
    unauthenticated traffic. Behavior is identical to no-internal-key:
    fall through to require_auth.
    """
    fake_user = {"user_id": "u-jwt", "email": "real@pursuit.org", "is_service": False}
    monkeypatch.setattr(auth, "require_auth", AsyncMock(return_value=fake_user))
    request = _req(internal_key="not-the-real-key", originating_user="", request_id="")
    user = await auth.require_auth_or_internal(request)
    assert user is fake_user


# ---------------------------------------------------------------------------
# F. JWT path unaffected
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_jwt_path_unaffected_by_new_headers(monkeypatch):
    fake_user = {"user_id": "u-jwt", "email": "real@pursuit.org", "is_service": False}
    monkeypatch.setattr(auth, "require_auth", AsyncMock(return_value=fake_user))
    # No internal key — falls through to require_auth.
    request = _req(internal_key="", originating_user="", request_id="")
    user = await auth.require_auth_or_internal(request)
    assert user is fake_user
    assert "originating_user_email" not in user


# ---------------------------------------------------------------------------
# G + H. X-Pebble-Scopes parsing
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_explicit_scopes_parsed():
    user = await auth.require_auth_or_internal(_req(scopes="opp.write,account.read,task.write"))
    assert user["scopes"] == ("opp.write", "account.read", "task.write")


@pytest.mark.parametrize("scopes_header", ["", "   ", ",", " , , "])
@pytest.mark.asyncio
async def test_empty_scopes_falls_back_to_default(scopes_header):
    user = await auth.require_auth_or_internal(_req(scopes=scopes_header))
    assert user["scopes"] == ("*",)


@pytest.mark.asyncio
async def test_scopes_strip_whitespace():
    user = await auth.require_auth_or_internal(_req(scopes="  opp.write , account.read  "))
    assert user["scopes"] == ("opp.write", "account.read")


# ---------------------------------------------------------------------------
# Helper-function unit tests
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("email,expected", [
    ("rm@pursuit.org", True),
    ("a@b.co", True),
    ("user+tag@sub.pursuit.org", True),
    ("", False),
    ("no-at", False),
    ("@x.org", False),
    ("x@", False),
    ("x@y" + ".z" * 130, False),  # > 254 chars triggers length check
    ("space middle@x.org", False),
])
def test_is_valid_originating_user_email(email, expected):
    assert auth._is_valid_originating_user_email(email) is expected


def test_parse_scopes_default():
    assert auth._parse_scopes("") == ("*",)
    assert auth._parse_scopes(None) == ("*",)


def test_parse_scopes_explicit():
    assert auth._parse_scopes("a,b,c") == ("a", "b", "c")
    assert auth._parse_scopes("a, b , c") == ("a", "b", "c")
    assert auth._parse_scopes(" only ") == ("only",)
