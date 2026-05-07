"""Pebble request context — propagates the originating user through
Pebble's call stack into ``crm_bridge.py`` without threading it through
every function signature.

Bedrock's ``auth.require_auth_or_internal`` (commit f90099a) requires
``X-Originating-User`` on every internal-key call. Pebble must
attribute every CRM read/write to a specific human (or the explicit
autonomous sentinel). Plumbing ``user_email`` through every call site
is invasive — context vars are the standard async-safe way to carry
request-scoped state.

Usage at the Pebble request boundary::

    from pebble.request_context import set_originating_user

    @app.post("/api/v1/chat/query")
    async def chat_query(request: Request, user_email: str = Depends(...)):
        with set_originating_user(user_email):
            ...   # crm_bridge calls inside here auto-attribute

For autonomous flows (e.g. cron-triggered research with no human
session)::

    with set_originating_user(AUTONOMOUS_USER):
        await orchestrator.run_batch(...)

Anomaly detection alerts on a sustained rate of AUTONOMOUS_USER —
they're legitimate but should be rare and bounded.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator, Optional

# Sentinel for autonomous (no-human-in-the-loop) flows. Email-shaped
# so it passes Bedrock's lightweight format check; clearly labeled
# so audit dashboards can surface it.
AUTONOMOUS_USER = "system:pebble-autonomous@pursuit.org"

# Context variable. Default None means "not set" — crm_bridge can
# decide whether to refuse the request, pass the autonomous sentinel,
# or surface an error depending on configuration.
_originating_user: ContextVar[Optional[str]] = ContextVar(
    "pebble_originating_user", default=None,
)
_request_id: ContextVar[Optional[str]] = ContextVar(
    "pebble_request_id", default=None,
)
_trace_id: ContextVar[Optional[str]] = ContextVar(
    "pebble_trace_id", default=None,
)


def get_originating_user() -> Optional[str]:
    return _originating_user.get()


def get_request_id() -> Optional[str]:
    return _request_id.get()


def get_trace_id() -> Optional[str]:
    return _trace_id.get()


@contextmanager
def set_originating_user(
    email: str,
    *,
    request_id: Optional[str] = None,
    trace_id: Optional[str] = None,
) -> Iterator[None]:
    """Set the originating user (and optional request/trace ids) for
    the current async context. Restores prior state on exit so nested
    calls don't leak.

    Pebble's permission middleware should wrap each request handler
    in this; for autonomous flows, the orchestrator entry point does
    so explicitly with ``AUTONOMOUS_USER``.
    """
    prev_user = _originating_user.set(email)
    prev_req = _request_id.set(request_id) if request_id is not None else None
    prev_trace = _trace_id.set(trace_id) if trace_id is not None else None
    try:
        yield
    finally:
        _originating_user.reset(prev_user)
        if prev_req is not None:
            _request_id.reset(prev_req)
        if prev_trace is not None:
            _trace_id.reset(prev_trace)


def attribution_headers() -> dict[str, str]:
    """Compose the X-Originating-User / X-Request-Id / X-Trace-Id
    headers from the current context. Returns an empty dict when
    nothing is set — caller decides how to handle missing attribution.
    """
    import uuid

    headers: dict[str, str] = {}
    user = _originating_user.get()
    if user:
        headers["X-Originating-User"] = user

    rid = _request_id.get()
    if not rid:
        # crm_bridge calls within an autonomous loop won't have a
        # parent request id — mint one per call so Bedrock's
        # idempotency UNIQUE(request_id) constraint never collides
        # with a stale value.
        rid = str(uuid.uuid4())
    headers["X-Request-Id"] = rid

    tid = _trace_id.get()
    if tid:
        headers["X-Trace-Id"] = tid
    return headers
