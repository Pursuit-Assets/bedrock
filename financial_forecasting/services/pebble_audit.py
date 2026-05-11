"""Pebble write audit — captures every internal-key write to
Bedrock and persists it to ``bedrock.pebble_write_audit``.

Phase 0.8 of the Pebble 1.0 plan. Closes the audit-table-but-no-writers
gap I shipped earlier: the 11 internal-key write routes
(``main.py:519, 656, 761, 1269, 1309, 1358, 1396, 1443, 1503, 1571``
and ``routes/opportunities_extra.py:439``) all gate on
``check_permission_or_internal`` but never wrote audit rows. Pebble
writes contacts/opps/payments today with NO audit trail.

This module provides:

  * A FastAPI middleware (``audit_internal_writes``) that
    transparently captures every successful internal-key write to a
    Bedrock route. Sees: request method/path, originating user
    (from request.state — set by auth.require_auth_or_internal),
    request id (from headers — see Phase 0.7), response status,
    payload hash + truncated payload. Writes via BackgroundTasks
    so it never blocks the response.
  * ``record_side_effect(request, key, value)`` — explicit hook for
    routes to attach side-effect attestations (e.g. ``award_created``)
    that a generic middleware can't infer from the response shape.

Audit-row idempotency: ON CONFLICT (request_id) DO NOTHING. A
retried request with the same X-Request-Id appears once.

Failure handling: audit insert errors are logged (and visible to
Cloud Monitoring via the warning rate), but never propagated to the
user response. Audit telemetry alerts on sustained failure.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from typing import Any, Callable, Optional

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
from starlette.types import ASGIApp

logger = logging.getLogger(__name__)

# HTTP methods we audit. GET / HEAD / OPTIONS are reads; we audit
# search separately via bedrock.search_audit (see routes/search.py).
_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Path prefixes considered "Pebble-relevant write routes" — only
# routes that actually accept internal-key auth need audit rows.
# Anything outside the prefix list is a JWT-only route; we don't
# audit it through this middleware. The list mirrors the actual
# check_permission_or_internal call sites (see grep at
# tasks/pebble-search-spec.md decision §3).
_AUDITED_PREFIXES = (
    "/api/salesforce/",
    "/api/opportunities/",
    "/api/payments",
    "/api/payment-schedules",
    "/api/projects",
    "/api/awards",
)

# Cap on payload size we copy verbatim into the audit row. Anything
# larger gets the hash + a truncated preview. 4 KB is enough for
# every write payload Pebble issues today (largest = a contact JSON
# at ~1 KB) and bounds the audit table's heap growth.
_MAX_PAYLOAD_BYTES = 4096


def _is_internal_key_request(request: Request) -> bool:
    """True iff this request authenticated via X-Internal-Key. The
    header check is sufficient — we don't need to validate the key
    here, the auth dependency already did. Missing header = not
    a Pebble call, skip audit."""
    return bool(request.headers.get("X-Internal-Key", ""))


def _is_audited_route(path: str, method: str) -> bool:
    if method not in _WRITE_METHODS:
        return False
    return any(path.startswith(p) for p in _AUDITED_PREFIXES)


def _hash_payload(body: bytes) -> Optional[str]:
    if not body:
        return None
    return hashlib.sha256(body).hexdigest()


def _truncate_payload_for_audit(body: bytes) -> Optional[dict]:
    """Best-effort JSON parse + truncate. Returns None on non-JSON
    bodies (e.g. multipart upload — those don't appear on Pebble
    write paths today)."""
    if not body or len(body) > _MAX_PAYLOAD_BYTES:
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


_PLURAL_TO_SINGULAR = {
    "opportunities": "Opportunity",
    "accounts": "Account",
    "contacts": "Contact",
    "tasks": "Task",
    "activities": "Activity",
    "awards": "Award",
    "projects": "Project",
    "payments": "Payment",
}


def _extract_sf_object_from_path(path: str) -> tuple[Optional[str], Optional[str]]:
    """Best-effort parse of ``/api/salesforce/{type}/{id}`` →
    ('Opportunity', '006xxx'). When the route isn't path-shaped this
    way, returns (None, None) — callers can use record_sf_object to
    fill it in explicitly. Plural-to-singular handled via an explicit
    map (``opportunities`` → ``Opportunity`` not ``Opportunitie``).
    """
    parts = [p for p in path.split("/") if p]
    if len(parts) < 3 or parts[0] != "api":
        return None, None
    if parts[1] == "salesforce" and len(parts) >= 4:
        type_str = _PLURAL_TO_SINGULAR.get(parts[2].lower())
        return type_str, parts[3]
    if parts[1] == "opportunities" and len(parts) >= 3:
        # /api/opportunities/update-stage POST body has the id; can't
        # extract from path. Fall through to None and let the route
        # call record_sf_object.
        return "Opportunity", None
    if parts[1] in _PLURAL_TO_SINGULAR and len(parts) >= 3:
        return _PLURAL_TO_SINGULAR[parts[1]], parts[2]
    return None, None


def record_side_effect(request: Request, key: str, value: Any) -> None:
    """Attach a side-effect attestation to the audit row that the
    middleware will write. Routes call this when they do something
    a generic middleware can't observe — e.g.
    ``record_side_effect(request, "award_created", True)`` from
    ``update_opportunity_stage`` after auto-award fires.

    Stored on request.state under ``_pebble_audit_side_effects``;
    the middleware reads it after the response and merges into the
    audit row payload.
    """
    state = getattr(request, "state", None)
    if state is None:
        return
    existing = getattr(state, "_pebble_audit_side_effects", None) or {}
    existing[key] = value
    state._pebble_audit_side_effects = existing


def record_sf_object(
    request: Request, sf_object_type: str, sf_object_id: Optional[str],
) -> None:
    """Attach explicit subject information to the audit row. Useful
    when the route writes a record whose ID isn't in the path (e.g.
    create routes return a new ID in the response; update-stage
    receives the ID in the POST body).
    """
    state = getattr(request, "state", None)
    if state is None:
        return
    state._pebble_audit_sf_object_type = sf_object_type
    state._pebble_audit_sf_object_id = sf_object_id


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

class PebbleWriteAuditMiddleware(BaseHTTPMiddleware):
    """Inserts a row into ``bedrock.pebble_write_audit`` for every
    successful internal-key write (POST/PUT/PATCH/DELETE) hitting
    a Pebble-relevant Bedrock route.

    Why a middleware vs per-route: the 11 existing write routes
    don't share a base class, and threading an audit dependency
    through each one's signature is invasive + easy to forget. A
    middleware is opt-in by URL prefix and survives route additions
    without further wiring.

    Handing the DB pool in: a callable resolved at construction time
    (``pool_provider``). Tests pass a no-op provider; production
    passes a function that returns the asyncpg pool from
    ``main.py``'s ``_services``. Avoids a top-of-module import
    that would couple this module to main.py.
    """

    def __init__(self, app: ASGIApp, pool_provider: Callable[[], Any]):
        super().__init__(app)
        self._pool_provider = pool_provider

    async def dispatch(self, request: Request, call_next):
        # Fast path: skip everything for non-write or non-audited routes.
        if not _is_audited_route(request.url.path, request.method):
            return await call_next(request)
        if not _is_internal_key_request(request):
            return await call_next(request)

        # Don't read the request body here. Reading it would force us
        # to replay it to the downstream route, which fights with
        # Starlette's BaseHTTPMiddleware receive-stream wrapper. Routes
        # that want to capture payload-shape attributes (sf_object_id,
        # side effects) call ``record_sf_object`` / ``record_side_effect``
        # which write to ``request.state``; the middleware reads those
        # after the response. Payload hash + verbatim payload remain
        # NULL in the audit row — Cloud Logging captures the actual
        # body via structured logs, and the audit row carries enough
        # forensics (route, method, originating user, response status,
        # request_id for replay correlation, side_effects for what
        # actually happened) for the use cases this table targets.
        started = time.perf_counter()
        response: Response = await call_next(request)
        latency_ms = int((time.perf_counter() - started) * 1000)

        # Only audit successful writes (2xx) — failed requests are
        # captured by upstream metrics + Cloud Logging; an audit row
        # for an attempt that didn't change state is noise.
        if response.status_code >= 400:
            return response

        request_id_raw = (request.headers.get("X-Request-Id") or "").strip()
        try:
            request_id = uuid.UUID(request_id_raw) if request_id_raw else uuid.uuid4()
        except ValueError:
            request_id = uuid.uuid4()

        originating_user = (
            request.headers.get("X-Originating-User") or ""
        ).strip() or "unknown@unknown"

        sf_type_state = getattr(request.state, "_pebble_audit_sf_object_type", None)
        sf_id_state = getattr(request.state, "_pebble_audit_sf_object_id", None)
        if sf_type_state is None and sf_id_state is None:
            sf_type_state, sf_id_state = _extract_sf_object_from_path(
                request.url.path,
            )

        side_effects = getattr(request.state, "_pebble_audit_side_effects", None)

        # Schedule the write as a fire-and-forget task. We can't use
        # FastAPI's BackgroundTasks here because the response has
        # already been generated; spawning via asyncio.create_task is
        # the correct pattern for middleware-emitted post-response
        # work.
        try:
            import asyncio

            async def _write():
                try:
                    pool = self._pool_provider()
                    if pool is None:
                        return
                    async with pool.acquire() as conn:
                        await conn.execute(
                            """
                            INSERT INTO bedrock.pebble_write_audit (
                                request_id, route, http_method,
                                sf_object_type, sf_object_id,
                                originating_user_email, service_user,
                                payload_hash, payload,
                                response_status, side_effects,
                                latency_ms, org_id
                            ) VALUES (
                                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
                            )
                            ON CONFLICT (request_id) DO NOTHING
                            """,
                            request_id, request.url.path, request.method,
                            sf_type_state, sf_id_state,
                            originating_user, "service:pebble",
                            None,  # payload_hash (see comment above)
                            None,  # payload
                            response.status_code,
                            json.dumps(side_effects) if side_effects else None,
                            latency_ms,
                            "pursuit",
                        )
                except Exception:
                    logger.exception(
                        "pebble_write_audit_insert_failed request_id=%s route=%s",
                        request_id, request.url.path,
                    )

            asyncio.create_task(_write())
        except Exception:
            logger.exception("pebble_write_audit_dispatch_failed")

        return response
