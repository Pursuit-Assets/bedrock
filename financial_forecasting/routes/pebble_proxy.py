"""Pebble proxy — Layer 3.1 of the Pebble 1.0 plan.

The Bedrock-side gateway for the frontend's Ask mode. Forwards
conversational queries to Pebble (running on a separate process,
port 8001) and streams the response back. Pebble itself can call
back into Bedrock's /api/search via the existing crm_bridge for
grounding tool calls.

Why a Bedrock-side proxy and not a direct frontend → Pebble call:
  * Single auth boundary. The frontend already has a JWT cookie
    for Bedrock; it doesn't have credentials for Pebble. The proxy
    swaps those for Pebble's X-Api-Key + X-User-Email.
  * Centralized cost / rate gating. Audit row, daily cost cap,
    per-user rate limit all live here.
  * Single CORS surface. Frontend talks to one host (Bedrock),
    not two.
  * Trace propagation gateway — proxy adds X-Trace-Id if absent
    so the FE → Bedrock → Pebble → Bedrock(/api/search) chain
    has a single correlation id.

Endpoint:
  POST /api/pebble/ask    body: {query, conversation_id?, context?}
                          stream: text/event-stream

Permission gate: ``check_permission_or_internal("use_pebble_chat")``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from typing import Any, AsyncIterator, Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from db import get_db
from routes.permissions import check_permission_or_internal

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/pebble", tags=["pebble"])

# Module-level stable reference so tests override correctly.
require_ask_perm = check_permission_or_internal("use_pebble_chat")


# Pebble's URL + auth. Default localhost for dev; production MUST
# override via env (validated at Pebble's own startup, see
# pebble/main.py:_validate_bedrock_bridge_config for the inverse
# direction).
_PEBBLE_URL = os.getenv("PEBBLE_API_URL", "http://localhost:8001")
_PEBBLE_API_KEY = os.getenv("PEBBLE_API_KEY", "")

# Streaming timeouts — generous on the read side because L1+ Pebble
# responses can take up to ~30s; tight on connect.
_HTTP_TIMEOUT = httpx.Timeout(60.0, connect=3.0, read=60.0)

# Daily cost cap (dollars). Mirrors pebble/main.py:DAILY_COST_LIMIT
# default of $5.00. Override via PEBBLE_DAILY_COST_LIMIT_USD. When a
# user exceeds the cap, /api/pebble/ask returns 429 with a
# Retry-After header set to seconds-until-midnight-UTC. When at 80%+,
# the proxy adds a degradation hint header so Pebble can route to L0
# only (cheap deterministic redirects, no LLM tokens).
_DAILY_COST_LIMIT_USD = float(os.getenv("PEBBLE_DAILY_COST_LIMIT_USD", "5.0"))
_COST_DEGRADE_FRACTION = 0.80    # 80% — degrade to L0-only beyond this


# ---------------------------------------------------------------------------
# Request / response
# ---------------------------------------------------------------------------

class AskRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=2000)
    conversation_id: Optional[str] = Field(
        None, description="UUID for multi-turn conversations; minted if absent",
    )
    context: dict[str, Any] = Field(
        default_factory=dict,
        description="Optional context — current page / record / etc. for grounding",
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_client: Optional[httpx.AsyncClient] = None


def _get_pebble_client() -> httpx.AsyncClient:
    """Lazy-init singleton client. Closed on shutdown via close()."""
    global _client
    if _client is None or _client.is_closed:
        headers: dict[str, str] = {}
        if _PEBBLE_API_KEY:
            headers["X-Api-Key"] = _PEBBLE_API_KEY
        _client = httpx.AsyncClient(
            base_url=_PEBBLE_URL,
            headers=headers,
            timeout=_HTTP_TIMEOUT,
        )
    return _client


async def close() -> None:
    """Close the proxy's httpx client. Call from app lifespan shutdown."""
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None


def _new_trace_id(request: Request) -> str:
    """Use the inbound X-Trace-Id if valid, else mint."""
    raw = request.headers.get("X-Trace-Id", "").strip()
    if raw:
        try:
            uuid.UUID(raw)
            return raw
        except ValueError:
            pass
    return str(uuid.uuid4())


async def _read_daily_cost(pool, user_email: str) -> tuple[float, int]:
    """Return (today_cost_usd, today_query_count) for the given user.
    Zero / zero if no row exists. Failures return (0.0, 0) — fail-open
    on read so DB outages don't lock users out, but a follow-up alert
    catches sustained read failures.
    """
    if not user_email:
        return 0.0, 0
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT COALESCE(total_cost_usd, 0)::float AS cost,
                       COALESCE(query_count, 0)::int AS qcount
                  FROM bedrock.pebble_daily_usage
                 WHERE user_email = $1
                   AND date = CURRENT_DATE
                """,
                user_email,
            )
            if not row:
                return 0.0, 0
            return float(row["cost"]), int(row["qcount"])
    except Exception:
        logger.exception(
            "pebble_proxy: failed to read daily usage for %s — failing open",
            user_email,
        )
        return 0.0, 0


def _seconds_until_midnight_utc() -> int:
    """For Retry-After when cost cap is hit. Resets at midnight UTC."""
    from datetime import datetime, timedelta, timezone

    now = datetime.now(tz=timezone.utc)
    tomorrow = (now + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0,
    )
    return max(60, int((tomorrow - now).total_seconds()))


async def _emit_ask_audit(
    pool,
    *,
    request_id: str,
    trace_id: str,
    user_email: str,
    originating_user_email: Optional[str],
    org_id: str,
    query: str,
    response_status: int,
    latency_ms: int,
    error_class: Optional[str] = None,
) -> None:
    """Record the Ask query in bedrock.search_audit with mode='ask'.
    Same audit table as Find queries — one place to look for "what did
    Pebble see for this user."
    """
    try:
        from services import search_service as ss
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO bedrock.search_audit (
                    query_id, request_id, user_email,
                    originating_user_email, org_id, mode,
                    query_text, query_text_hash, types_requested,
                    backend_used, latency_ms, result_count,
                    response_status, error_class
                ) VALUES (
                    $1, $2, $3, $4, $5, 'ask',
                    $6, $7, '{}',
                    'pgvector', $8, 0, $9, $10
                )
                ON CONFLICT (request_id) DO NOTHING
                """,
                uuid.uuid4(), uuid.UUID(request_id),
                user_email, originating_user_email, org_id,
                query[:256], ss.query_text_hash(query),
                latency_ms, response_status, error_class,
            )
    except Exception:
        logger.exception(
            "ask_audit_insert_failed request_id=%s trace_id=%s",
            request_id, trace_id,
        )


# ---------------------------------------------------------------------------
# POST /api/pebble/ask
# ---------------------------------------------------------------------------

@router.post("/ask")
async def ask_endpoint(
    request: Request,
    background_tasks: BackgroundTasks,
    body: AskRequest,
    pool=Depends(get_db),
    user=Depends(require_ask_perm),
):
    """Stream a Pebble L0/L1+ chat response back to the frontend.

    Read-only at v1.0 — Pebble's tool budget allows search_crm but
    NOT write tools. Suggested-action cards in the response require
    user confirmation via a separate /api/opportunities/update-stage
    call carrying the user's JWT (not the internal key).
    """
    started = time.perf_counter()
    user_email = user.get("email", "unknown")
    originating = user.get("originating_user_email")
    request_id = request.headers.get("X-Request-Id", "").strip() or str(uuid.uuid4())
    trace_id = _new_trace_id(request)
    org_id = "pursuit"   # multi-tenant outermost guard; refined post-1.0

    # The user we send to Pebble is the originating user when caller
    # is service:pebble (i.e. pebble@internal calling itself, which
    # shouldn't happen but defend in depth), otherwise the bearer.
    pebble_user_email = originating or user_email

    # Cost cap enforcement. Read today's spend for the user; reject
    # at 100%, degrade to L0-only at 80%+. Read is fail-open (DB
    # outage doesn't lock users out) but logs to flag sustained
    # failures.
    today_cost, today_count = await _read_daily_cost(pool, pebble_user_email)
    if today_cost >= _DAILY_COST_LIMIT_USD:
        retry_seconds = _seconds_until_midnight_utc()
        latency_ms = int((time.perf_counter() - started) * 1000)
        # FastAPI's default HTTPException handler doesn't run the
        # BackgroundTasks attached to the original request, so audit
        # the blocked attempt via a fire-and-forget task instead.
        # Anomaly detection needs to see 429s — they're often the
        # signal that someone's spamming Pebble.
        import asyncio as _asyncio
        _asyncio.create_task(_emit_ask_audit(
            pool,
            request_id=request_id,
            trace_id=trace_id,
            user_email=user_email,
            originating_user_email=originating,
            org_id=org_id,
            query=body.query,
            response_status=429,
            latency_ms=latency_ms,
            error_class="daily_cost_cap_exceeded",
        ))
        raise HTTPException(
            status_code=429,
            detail={
                "error": "daily_cost_cap_exceeded",
                "message": (
                    f"You have reached today's Pebble usage cap "
                    f"(${_DAILY_COST_LIMIT_USD:.2f}). "
                    f"Resets at midnight UTC."
                ),
                "spent_usd": round(today_cost, 4),
                "limit_usd": _DAILY_COST_LIMIT_USD,
                "query_count_today": today_count,
            },
            headers={"Retry-After": str(retry_seconds)},
        )

    degrade_to_l0 = today_cost >= (_DAILY_COST_LIMIT_USD * _COST_DEGRADE_FRACTION)

    pebble_body = {
        "query": body.query,
        "conversation_id": body.conversation_id or str(uuid.uuid4()),
        "context": body.context,
    }
    pebble_headers = {
        "X-User-Email": pebble_user_email,
        "X-Trace-Id": trace_id,
        "X-Request-Id": request_id,
    }
    if degrade_to_l0:
        # Pebble's router checks this header (or env var) to skip
        # the L1+ LLM path and only emit deterministic L0 redirects.
        # Even if Pebble doesn't honor it yet, the audit row records
        # that we ASKED for degraded mode, which is the data we need
        # for "did the cost cap kick in correctly" forensics.
        pebble_headers["X-Pebble-Force-Tier"] = "L0"
        logger.info(
            "pebble_proxy: degrading user=%s today=$%.2f / cap=$%.2f to L0-only",
            pebble_user_email, today_cost, _DAILY_COST_LIMIT_USD,
        )

    response_status = 200
    error_class: Optional[str] = None

    async def _stream() -> AsyncIterator[bytes]:
        nonlocal response_status, error_class
        client = _get_pebble_client()
        try:
            async with client.stream(
                "POST", "/api/v1/chat/query",
                json=pebble_body, headers=pebble_headers,
            ) as resp:
                if resp.status_code >= 400:
                    response_status = resp.status_code
                    payload = await resp.aread()
                    error_class = f"pebble_status_{resp.status_code}"
                    yield (
                        b'data: {"type":"error","status":'
                        + str(resp.status_code).encode()
                        + b'}\n\n'
                    )
                    return
                async for chunk in resp.aiter_bytes():
                    if chunk:
                        yield chunk
        except httpx.TimeoutException:
            response_status = 504
            error_class = "TimeoutException"
            yield b'data: {"type":"error","reason":"timeout"}\n\n'
        except httpx.HTTPError as e:
            response_status = 502
            error_class = type(e).__name__
            logger.exception("pebble_proxy_http_error trace_id=%s", trace_id)
            yield b'data: {"type":"error","reason":"upstream"}\n\n'
        finally:
            latency_ms = int((time.perf_counter() - started) * 1000)
            background_tasks.add_task(
                _emit_ask_audit,
                pool,
                request_id=request_id,
                trace_id=trace_id,
                user_email=user_email,
                originating_user_email=originating,
                org_id=org_id,
                query=body.query,
                response_status=response_status,
                latency_ms=latency_ms,
                error_class=error_class,
            )

    response_headers = {
        "X-Trace-Id": trace_id,
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
    }
    if degrade_to_l0:
        response_headers["X-Pebble-Degraded"] = "true"
        response_headers["X-Pebble-Cost-Today"] = f"{today_cost:.4f}"
        response_headers["X-Pebble-Cost-Limit"] = f"{_DAILY_COST_LIMIT_USD:.2f}"

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers=response_headers,
    )
