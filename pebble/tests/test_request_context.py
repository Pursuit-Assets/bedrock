"""Tests for ``pebble/request_context.py`` — attribution propagation
into ``crm_bridge`` outbound HTTP calls.

Asserts:

A. Default state: no user / request_id / trace_id set.
B. ``set_originating_user`` populates context-vars for the duration
   of the with-block and restores on exit.
C. Nested ``set_originating_user`` calls don't leak the inner value
   after the inner block exits.
D. ``attribution_headers`` produces the right header dict from the
   current context.
E. attribution_headers always sets X-Request-Id even when the context
   doesn't carry one (mints a UUID).
F. attribution_headers omits X-Originating-User when the user is unset
   so the warning path in crm_bridge fires.
G. AUTONOMOUS_USER sentinel is email-shaped and passes Bedrock's
   originating-user format check.
H. Concurrent contexts (asyncio.gather) don't cross-contaminate.
"""

import asyncio
import os
import re
import sys
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.request_context import (
    AUTONOMOUS_USER,
    attribution_headers,
    get_originating_user,
    get_request_id,
    get_trace_id,
    set_originating_user,
)


# ---------------------------------------------------------------------------
# A. Default state
# ---------------------------------------------------------------------------

def test_default_no_user_set():
    assert get_originating_user() is None
    assert get_request_id() is None
    assert get_trace_id() is None


# ---------------------------------------------------------------------------
# B. set_originating_user populates + restores
# ---------------------------------------------------------------------------

def test_set_originating_user_populates_then_restores():
    assert get_originating_user() is None
    with set_originating_user("rm@pursuit.org"):
        assert get_originating_user() == "rm@pursuit.org"
    assert get_originating_user() is None


def test_set_originating_user_with_ids():
    rid = "01993b8d-2c9a-7c4f-8b0e-000000000001"
    tid = "01993b8d-2c9a-7c4f-8b0e-000000000002"
    with set_originating_user("u@x.org", request_id=rid, trace_id=tid):
        assert get_originating_user() == "u@x.org"
        assert get_request_id() == rid
        assert get_trace_id() == tid
    # All three reset to None.
    assert get_originating_user() is None
    assert get_request_id() is None
    assert get_trace_id() is None


# ---------------------------------------------------------------------------
# C. Nested contexts
# ---------------------------------------------------------------------------

def test_nested_contexts_restore_outer_on_inner_exit():
    with set_originating_user("outer@x.org"):
        assert get_originating_user() == "outer@x.org"
        with set_originating_user("inner@x.org"):
            assert get_originating_user() == "inner@x.org"
        assert get_originating_user() == "outer@x.org"
    assert get_originating_user() is None


# ---------------------------------------------------------------------------
# D. attribution_headers shape
# ---------------------------------------------------------------------------

def test_attribution_headers_with_user_and_ids():
    rid = "01993b8d-2c9a-7c4f-8b0e-000000000001"
    tid = "01993b8d-2c9a-7c4f-8b0e-000000000002"
    with set_originating_user("u@x.org", request_id=rid, trace_id=tid):
        headers = attribution_headers()
    assert headers["X-Originating-User"] == "u@x.org"
    assert headers["X-Request-Id"] == rid
    assert headers["X-Trace-Id"] == tid


def test_attribution_headers_with_user_no_ids_mints_request_id():
    with set_originating_user("u@x.org"):
        headers = attribution_headers()
    assert headers["X-Originating-User"] == "u@x.org"
    # Minted UUID must parse.
    uuid.UUID(headers["X-Request-Id"])
    assert "X-Trace-Id" not in headers   # trace optional, not minted


# ---------------------------------------------------------------------------
# E. Always mint request id
# ---------------------------------------------------------------------------

def test_attribution_headers_unset_user_still_mints_request_id():
    headers = attribution_headers()
    assert "X-Originating-User" not in headers
    uuid.UUID(headers["X-Request-Id"])


# ---------------------------------------------------------------------------
# F. Two unrelated calls get different request ids
# ---------------------------------------------------------------------------

def test_attribution_headers_mints_unique_request_ids_each_call():
    h1 = attribution_headers()
    h2 = attribution_headers()
    assert h1["X-Request-Id"] != h2["X-Request-Id"]


# ---------------------------------------------------------------------------
# G. AUTONOMOUS_USER sentinel format
# ---------------------------------------------------------------------------

def test_autonomous_user_is_email_shaped():
    # Mirrors the validator in financial_forecasting/auth.py.
    email = AUTONOMOUS_USER
    assert "@" in email
    assert not email.startswith("@")
    assert not email.endswith("@")
    assert len(email) <= 254
    assert not re.search(r"\s", email)


def test_autonomous_user_clearly_identifies_as_system():
    """Audit dashboards must be able to distinguish autonomous from
    human activity. The sentinel must have a "system:" prefix."""
    assert AUTONOMOUS_USER.startswith("system:")


# ---------------------------------------------------------------------------
# H. Concurrent contexts don't leak across asyncio tasks
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_concurrent_contexts_do_not_cross_contaminate():
    """Run two coroutines in parallel that each set their own user
    and verify they don't see each other's value at any read point."""
    observed: list[tuple[str, str]] = []

    async def worker(label: str, email: str):
        with set_originating_user(email):
            await asyncio.sleep(0.01)
            observed.append((label, get_originating_user() or "<none>"))
            await asyncio.sleep(0.01)
            observed.append((label, get_originating_user() or "<none>"))

    await asyncio.gather(
        worker("A", "a@x.org"),
        worker("B", "b@x.org"),
        worker("C", "c@x.org"),
    )

    # Each worker must have observed only its own email.
    for label, observed_email in observed:
        assert observed_email == f"{label.lower()}@x.org", (
            f"worker {label} observed {observed_email}"
        )
