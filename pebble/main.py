"""Pebble API: prospect research pipeline. Integration #9."""

import hmac
import logging
import os
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env", override=True)
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response


# ---------------------------------------------------------------------------
# API key validation (set PEBBLE_API_KEY to enable; empty = dev mode)
# ---------------------------------------------------------------------------
_PEBBLE_API_KEY = os.getenv("PEBBLE_API_KEY", "")


async def verify_api_key(request: Request):
    """Validate X-Api-Key header against PEBBLE_API_KEY.

    If PEBBLE_API_KEY is not set, validation is skipped (dev mode).
    """
    if not _PEBBLE_API_KEY:
        return  # Dev mode — no key required
    provided = request.headers.get("X-Api-Key", "")
    if not provided or not hmac.compare_digest(provided, _PEBBLE_API_KEY):
        raise HTTPException(status_code=403, detail="Invalid or missing API key")


# ---------------------------------------------------------------------------
# Permission verification (Bedrock callback + in-memory cache)
# ---------------------------------------------------------------------------
_permission_cache: dict[str, dict] = {}
_PERMISSION_CACHE_TTL = 300  # 5 minutes

DAILY_COST_LIMIT = float(os.getenv("PEBBLE_DAILY_COST_LIMIT_USD", "5.0"))


async def _fetch_user_permissions(email: str) -> dict:
    """Call Bedrock's internal permission endpoint via CRM bridge client."""
    from .crm_bridge import _get_client
    client = _get_client()
    resp = await client.get(f"/api/permissions/internal/{email}")
    resp.raise_for_status()
    return resp.json().get("permissions", {})


def require_pebble_permission(permission_key: str):
    """FastAPI dependency: verify user has a specific Pebble permission.

    Reads X-User-Email header (NOT body — avoids double body consumption).
    Calls Bedrock to resolve permissions, caches result for 5 min.
    Stores verified email + full permission map on request.state.
    """
    async def _check(request: Request):
        user_email = request.headers.get("X-User-Email", "").strip()
        if not user_email:
            raise HTTPException(status_code=403, detail="X-User-Email header required")

        now = time.time()
        cached = _permission_cache.get(user_email)
        if cached and cached["expires"] > now:
            perms = cached["permissions"]
        else:
            try:
                perms = await _fetch_user_permissions(user_email)
                _permission_cache[user_email] = {
                    "permissions": perms, "expires": now + _PERMISSION_CACHE_TTL,
                }
            except Exception as e:
                logging.getLogger("pebble.main").warning(
                    "Permission check failed for %s: %s", user_email, e,
                )
                if cached:
                    perms = cached["permissions"]
                else:
                    raise HTTPException(
                        status_code=503,
                        detail="Cannot verify permissions — try again later",
                    )

        if not perms.get(permission_key, False):
            raise HTTPException(
                status_code=403, detail=f"Permission denied: {permission_key}",
            )

        request.state.user_email = user_email
        request.state.user_permissions = perms
        return user_email
    return _check


def check_daily_cost_limit():
    """FastAPI dependency: reject if user exceeded daily cost limit.

    Must run AFTER require_pebble_permission (reads request.state.user_email).
    Only applied to research endpoints, not chat.
    """
    async def _check(request: Request):
        user_email = getattr(request.state, "user_email", None)
        if not user_email:
            return

        from datetime import date as _date
        from .storage.db import get_daily_usage

        usage = await get_daily_usage(user_email, str(_date.today()))
        if usage and usage["total_cost_usd"] >= DAILY_COST_LIMIT:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Daily cost limit (${DAILY_COST_LIMIT:.2f}) exceeded. "
                    f"Used: ${usage['total_cost_usd']:.2f} across {usage['query_count']} queries."
                ),
            )
    return _check


from . import crm_bridge
from .request_context import set_originating_user
from .schemas import ResearchRequest, ResearchFeedback, CancelRequest
from .storage.db import (
    init_db, close_db, get_profile, save_feedback,
    get_feedback_for_contact, get_feedback_trends,
    get_recent_sessions, get_session,
)
from .export import render_profile_markdown

# Cooperative cancellation: job_ids that should be stopped
_cancel_flags: set[str] = set()

logger = logging.getLogger("pebble.main")


def _validate_bedrock_bridge_config() -> None:
    """Phase 0.6 — Pebble's bridge to Bedrock must be HTTPS in production
    and must carry a real internal API key. Wrong defaults are silent
    catastrophic failures: ``BEDROCK_API_URL`` defaults to
    ``http://localhost:8000`` and ``BEDROCK_INTERNAL_API_KEY`` defaults
    to empty in ``crm_bridge.py:14-17`` — fine for dev, ruinous in prod.
    Refuse to start when misconfigured.

    Detection of "production":
        FRONTEND_URL is set AND starts with ``https://``. Mirrors
        ``auth.py:25-26`` ``IS_PRODUCTION`` exactly so dev / staging /
        prod classify identically across the two processes. PEBBLE_ENV
        override (``PEBBLE_ENV=production``) wins regardless of
        FRONTEND_URL — useful for headless cron deployments that
        don't have a frontend URL.
    """
    is_prod = (
        (os.getenv("FRONTEND_URL", "") or "").startswith("https://")
        or os.getenv("PEBBLE_ENV", "").lower() == "production"
    )
    if not is_prod:
        return

    bedrock_url = os.getenv("BEDROCK_API_URL", "")
    if not bedrock_url.startswith("https://"):
        raise RuntimeError(
            "BEDROCK_API_URL must be set to an https:// URL in production. "
            f"Got: {bedrock_url!r}. Refusing to start — service-to-service "
            "writes to a localhost or http:// endpoint in prod silently "
            "lose data and bypass TLS."
        )
    if not os.getenv("BEDROCK_INTERNAL_API_KEY", "").strip():
        raise RuntimeError(
            "BEDROCK_INTERNAL_API_KEY must be set in production. Without it, "
            "crm_bridge.py:27-28 sends requests with no internal-key header "
            "and Bedrock falls through to JWT auth — every Pebble write "
            "fails 401. Refusing to start."
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    _validate_bedrock_bridge_config()
    await init_db()
    logger.info(
        "Pebble starting — ANTHROPIC_API_KEY=%s, OPENROUTER_API_KEY=%s, FEC_API_KEY=%s",
        "set" if os.getenv("ANTHROPIC_API_KEY") else "MISSING",
        "set" if os.getenv("OPENROUTER_API_KEY") else "MISSING",
        "set" if os.getenv("FEC_API_KEY") else "MISSING",
    )
    yield
    await close_db()
    await crm_bridge.close()


app = FastAPI(
    title="Pebble API",
    description="Prospect research pipeline for Bedrock. Integration #9.",
    version="0.2.0",
    lifespan=lifespan,
)

_pebble_cors_origins = ["http://localhost:3000"]
_frontend_url = os.getenv("FRONTEND_URL")
if _frontend_url:
    _pebble_cors_origins.append(_frontend_url)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_pebble_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=[
        "Content-Type", "Authorization", "X-Api-Key", "Cookie",
        "X-User-Email", "X-Request-Id", "X-Trace-Id",
    ],
)


@app.middleware("http")
async def attribute_request(request: Request, call_next):
    """Set the request context (originating user / request id / trace id)
    for the duration of every Pebble request so ``crm_bridge`` calls
    deeper in the stack auto-attribute via ``X-Originating-User`` to
    Bedrock.

    Reads ``X-User-Email`` (Pebble's existing header set by Bedrock when
    forwarding chat queries — see ``routes/pebble_proxy.py``). Falls
    back to ``X-Originating-User`` if a non-Bedrock caller sends it
    directly. Health-check and verification paths run without an
    originating user — auth dependencies will reject them later if
    they actually need one.

    Important: this is a context-var-based propagation, NOT a security
    boundary. Routes that need real auth still go through
    ``verify_api_key`` + ``require_pebble_permission`` (which set
    ``request.state.user_email`` independently). The context here is
    purely for plumbing attribution into outbound HTTP calls.
    """
    user_email = (
        request.headers.get("X-User-Email")
        or request.headers.get("X-Originating-User")
        or ""
    ).strip()
    request_id = (request.headers.get("X-Request-Id") or "").strip() or None
    trace_id = (request.headers.get("X-Trace-Id") or "").strip() or None

    if user_email:
        with set_originating_user(user_email, request_id=request_id, trace_id=trace_id):
            return await call_next(request)
    return await call_next(request)

# Rate limiting
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


def _error_response(code: str, message: str, status: int = 400) -> dict:
    """BedrockResult-style error."""
    return {"success": False, "error": {"code": code, "message": message}}


@app.post("/api/v1/research/cancel", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_research"))])
async def cancel_research(body: CancelRequest):
    """Cancel a running research job by job_id."""
    _cancel_flags.add(body.job_id)
    logger.info("Cancel requested for job %s", body.job_id)
    return {"ok": True, "job_id": body.job_id}


def _is_cancelled(job_id: str | None) -> bool:
    """Check if a job has been cancelled."""
    return job_id is not None and job_id in _cancel_flags


# ---------------------------------------------------------------------------
# Ask Pebble — chat endpoint
# ---------------------------------------------------------------------------


@app.post("/api/v1/chat/query", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_chat"))])
@limiter.limit("30/minute")
async def chat_query(request: Request, body: dict):
    """Ask Pebble chat endpoint.

    Two response shapes depending on the classified route + env flag:

      * **SSE stream** (``text/event-stream``) when:
          - ``route.level == 2`` (slash-command workflow), OR
          - ``route.level == 1`` AND env flag ``PEBBLE_USE_ORCHESTRATOR``
            is on AND a real Anthropic client is constructible
        The body emits ``data: {"kind": ..., "payload": ...}\\n\\n``
        frames per the orchestrator's event vocabulary.

      * **JSON ChatQueryResponse** for every other route — redirect
        (-1), L0 lookup (0), L1 fallback (1 with flag off / no client),
        T1/T2/T3 research (10/20/30). Existing behavior, unchanged.

    The proxy honors ``X-Pebble-Force-Tier=L0`` by setting it on the
    forwarded request; we read it here and force the route through the
    JSON path even if classify_query said level=1 — provides a hard
    kill switch when the daily-cost cap is at 80%+.
    """
    import time as _time
    import uuid as _uuid
    from fastapi.responses import StreamingResponse
    from .schemas.chat import ChatQueryRequest, ChatQueryResponse
    from .router import classify_query
    from .handlers import dispatch_handler
    from .handlers.streaming import (
        is_workflow_route, orchestrator_enabled, stream_orchestrator_events,
    )
    from .orchestrator.sse import encode_event, encode_error
    from .storage.db import ensure_conversation, save_chat_message

    start = _time.time()

    # Parse and validate request
    try:
        req = ChatQueryRequest(**body)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Ensure conversation exists (use verified email from permission check)
    user_email = getattr(request.state, "user_email", req.user_email or "unknown")
    conversation_id = req.conversation_id or str(_uuid.uuid4())
    await ensure_conversation(conversation_id, user_email)

    # Save user message
    await save_chat_message(
        message_id=str(_uuid.uuid4()),
        conversation_id=conversation_id,
        role="user",
        content=req.query,
    )

    # Honor the proxy's X-Pebble-Force-Tier=L0 header — when the daily-
    # cost cap is at 80%+, proxy forces L0-only. Skip classifier entirely
    # when forced to keep behavior predictable.
    force_l0 = request.headers.get("X-Pebble-Force-Tier", "").upper() == "L0"

    # Classify query
    client = None
    if os.getenv("ANTHROPIC_API_KEY") and not force_l0:
        from .model_client import ModelClient
        client = ModelClient()

    from .context_resolver import resolve_pronouns
    resolved_query = await resolve_pronouns(req.query, req.conversation_id)
    if force_l0:
        # Synthesize a forced L0 route — bypass classify_query entirely
        # so the orchestrator path can't fire. Cheap deterministic
        # answers only.
        from .router import RouteResult
        route = RouteResult(
            level=0, intent="forced_l0",
            entities={"original_query": resolved_query}, confidence=1.0,
        )
    else:
        route = await classify_query(resolved_query, req.mode, client=client)
        # Stash original query for CRM agent (not on RouteResult by default)
        route.entities["original_query"] = resolved_query

    # Fetch conversation context (prior messages only). Used by both
    # the JSON dispatcher and the orchestrator's planner.
    from .storage.db import get_conversation_messages
    conversation_messages = None
    raw_msgs = await get_conversation_messages(conversation_id, limit=10)
    if raw_msgs and len(raw_msgs) > 1:
        # Exclude the current query (last message) to avoid duplication
        prior = raw_msgs[:-1]
        conversation_messages = [
            {"role": m["role"], "content": m["content"]}
            for m in prior[-6:]  # last 3 turns
        ]

    # Resolve write permissions from RBAC (replaces PEBBLE_CHAT_WRITE_EMAILS env var)
    perms = getattr(request.state, "user_permissions", {})
    user_permissions = None
    if perms.get("pebble_crm_write", False):
        user_permissions = {"crm_write": True}

    # ---- Streaming path: workflow (level=2) or L1 orchestrator ----
    if not force_l0 and (is_workflow_route(route) or orchestrator_enabled(route)):
        from .storage.db import get_pool

        async def _sse_body():
            """Yield SSE-encoded bytes from the orchestrator's events.
            Persist the assistant message at end of stream so history
            renders the final answer like the JSON path does.
            """
            final_text = ""
            final_data: dict | None = None
            tier_label = "T2-workflow" if route.level == 2 else "T1.5-agent"
            cost_total = 0.0
            tokens_in_total = 0
            tokens_out_total = 0

            try:
                async for ev in stream_orchestrator_events(
                    route=route,
                    user_query=resolved_query,
                    conversation_id=conversation_id,
                    user_email=user_email,
                    db_pool=get_pool(),
                    recent_messages=conversation_messages,
                ):
                    yield encode_event(ev)
                    # Capture the final response so we can persist it.
                    if ev.kind == "response_final":
                        final = ev.payload.get("final") or {}
                        final_text = str(final.get("text") or "")
                        final_data = {
                            "citations": final.get("citations") or [],
                            "charts": final.get("charts") or [],
                            "suggested_actions": final.get("suggested_actions") or [],
                            "degraded": final.get("degraded", False),
                        }
                    elif ev.kind in ("tool_call_finished", "eval_emitted"):
                        # Both event kinds carry per-LLM-call accounting.
                        # Sum into the conversation total persisted with
                        # the assistant message + driving the FE tally.
                        cost_total += float(ev.payload.get("cost_usd") or 0.0)
                        tokens_in_total += int(ev.payload.get("tokens_in") or 0)
                        tokens_out_total += int(ev.payload.get("tokens_out") or 0)
            except Exception:
                logger.exception("chat_query.streaming_failure conv=%s", conversation_id)
                yield encode_error("internal_error", phase="streaming")

            # Persist the assistant message for chat history surfaces.
            try:
                await save_chat_message(
                    message_id=str(_uuid.uuid4()),
                    conversation_id=conversation_id,
                    role="assistant",
                    content=final_text or "(no response generated)",
                    tier=tier_label,
                    cost_usd=cost_total,
                    metadata={
                        "intent": route.intent,
                        "data": final_data or {},
                        "sources": [],
                        "entities": route.entities,
                        "level": route.level,
                        "tokens_in": tokens_in_total,
                        "tokens_out": tokens_out_total,
                    },
                )
            except Exception:
                logger.exception(
                    "chat_query.save_assistant_failure conv=%s — non-fatal",
                    conversation_id,
                )

        return StreamingResponse(
            _sse_body(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Pebble-Mode": "stream",
                "X-Pebble-Level": str(route.level),
            },
        )

    # ---- JSON path (existing behavior) ----
    response = await dispatch_handler(
        route=route,
        crm_bridge=crm_bridge,
        conversation_context=conversation_messages,
        client=client,
        user_permissions=user_permissions,
        user_email=user_email,
    )

    elapsed = _time.time() - start

    # Save assistant message
    metadata = {
        "intent": response.intent,
        "data": response.data,
        "sources": response.sources,
        "entities": route.entities,
    }
    if response.requires_clarification:
        metadata["clarification_options"] = [
            o.model_dump() for o in (response.clarification_options or [])
        ]
    if response.redirect_target:
        metadata["redirect_target"] = response.redirect_target

    tier_label = {-1: "redirect", 0: "T0", 1: "T0.5", 10: "T1", 20: "T2", 30: "T3"}.get(
        response.level, f"T{response.level}"
    )
    await save_chat_message(
        message_id=str(_uuid.uuid4()),
        conversation_id=conversation_id,
        role="assistant",
        content=response.text,
        tier=tier_label,
        cost_usd=response.cost_usd,
        metadata=metadata,
    )

    return ChatQueryResponse(
        answer=response.text,
        level=response.level,
        intent=response.intent,
        data=response.data,
        sources=response.sources,
        cost_usd=response.cost_usd,
        elapsed_seconds=elapsed,
        conversation_id=conversation_id,
        redirect_target=response.redirect_target,
        redirect_reason=response.redirect_reason,
        requires_clarification=response.requires_clarification,
        clarification_options=response.clarification_options,
    )


@app.get("/api/v1/chat/history", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_chat"))])
async def chat_history(
    conversation_id: str | None = None,
    user_email: str | None = None,
    limit: int = 20,
):
    """Get chat history — conversation list or messages for a conversation."""
    from .storage.db import get_conversation_messages, get_recent_conversations

    if conversation_id:
        messages = await get_conversation_messages(conversation_id, limit=50)
        return {"conversation_id": conversation_id, "messages": messages}
    else:
        conversations = await get_recent_conversations(user_email, limit=limit)
        return {"conversations": conversations}


@app.post("/api/v1/research/tiered", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_research")), Depends(check_daily_cost_limit())])
@limiter.limit("15/minute")
async def tiered_research(request: Request, body: dict):
    """Single-prospect tiered research — pick T1, T2, or T3."""
    import time as _time
    import uuid as _uuid

    from .schemas.profile import TieredResearchRequest
    from .handlers.tier1 import handle_t1
    from .handlers.tier2 import handle_t2
    from .handlers.tier3 import handle_t3
    from .router import RouteResult

    try:
        req = TieredResearchRequest(**body)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))

    start = _time.time()
    user_email = getattr(request.state, "user_email", None)
    contact_id = req.contact_id or f"{req.first_name}_{req.last_name}".strip("_").lower() or str(_uuid.uuid4())
    name = f"{req.first_name} {req.last_name}".strip()

    tier_map = {1: (10, handle_t1), 2: (20, handle_t2), 3: (30, handle_t3)}
    level, handler = tier_map[req.tier]
    tier_label = f"T{req.tier}"

    # Generate batch_id for session grouping
    batch_id = req.batch_id or str(_uuid.uuid4())

    route = RouteResult(
        level=level,
        intent=f"tiered_{tier_label.lower()}",
        entities={
            "person_name": name,
            "org_name": req.organization,
            "batch_id": batch_id,
        },
    )

    client = None
    if os.getenv("ANTHROPIC_API_KEY"):
        from .model_client import ModelClient
        client = ModelClient()

    response = await handler(route, crm_bridge, client, user_email=user_email)
    elapsed = _time.time() - start

    # Track daily cost
    if user_email and response.cost_usd > 0:
        from datetime import date as _date
        from .storage.db import increment_daily_usage
        await increment_daily_usage(user_email, str(_date.today()), response.cost_usd)

    # Save session for T1/T2 (T3 saves in its handler)
    if req.tier in (1, 2):
        from .storage.db import save_session
        session_profile = {
            "claims": [],
            "summary": response.text[:500] if response.text else "",
            "confidence_score": (response.data or {}).get("identity_card", {}).get("confidence", "unknown")
                if req.tier == 1 else "unknown",
            "partial": False,
            "failed_agents": [a["name"] for a in response.agents_log if a["outcome"] in ("error", "timeout")],
        }
        await save_session(
            session_id=str(_uuid.uuid4()),
            contact_id=contact_id,
            profile=session_profile,
            prospect_name=name,
            prospect_org=req.organization or "",
            cost_usd=response.cost_usd,
            status="completed",
            tier=tier_label,
            agents_log=response.agents_log,
            batch_id=batch_id,
        )

    return {
        "tier": tier_label,
        "text": response.text,
        "data": response.data,
        "cost_usd": response.cost_usd,
        "elapsed_seconds": elapsed,
        "sources": response.sources,
        "contact_id": contact_id,
        "agents_log": response.agents_log,
        "batch_id": batch_id,
    }


@app.post("/api/v1/research/batch", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_research")), Depends(check_daily_cost_limit())])
@limiter.limit("2/minute")
async def batch_research(request: Request, body: dict):
    """Batch tiered research — run T1/T2/T3 on a list of prospects."""
    import asyncio
    import json
    import uuid as _uuid

    from .handlers.tier1 import handle_t1
    from .handlers.tier2 import handle_t2
    from .handlers.tier3 import handle_t3
    from .router import RouteResult
    from .storage.db import (
        create_batch, update_batch_prospect, update_batch_status,
        get_batch_status, get_batch_prospects,
    )

    prospects = body.get("prospects", [])
    target_tier = body.get("target_tier", 1)
    batch_id = body.get("batch_id") or str(_uuid.uuid4())
    selected_ids = body.get("selected_ids")
    # Prefer verified email from permission check; fall back to body for backwards compat
    user_email = getattr(request.state, "user_email", None) or body.get("user_email", "unknown")

    if len(prospects) > 500:
        raise HTTPException(400, "Maximum 500 prospects per batch")
    if target_tier not in (1, 2, 3):
        raise HTTPException(400, "target_tier must be 1, 2, or 3")

    # Create or resume batch
    existing = await get_batch_status(batch_id)
    if not existing and prospects:
        batch_prospects = [
            {"id": str(_uuid.uuid4()), "name": p.get("name", ""), "organization": p.get("organization", "")}
            for p in prospects
        ]
        await create_batch(batch_id, user_email, batch_prospects)

    # Get prospect list (filter to selected_ids if advancing)
    batch_rows = await get_batch_prospects(batch_id)
    if selected_ids:
        batch_rows = [r for r in batch_rows if r["id"] in selected_ids]

    # Set up model client
    client = None
    if os.getenv("ANTHROPIC_API_KEY"):
        from .model_client import ModelClient
        client = ModelClient()

    tier_map = {1: 10, 2: 20, 3: 30}
    tier_level = tier_map.get(target_tier, 10)
    tier_label = f"T{target_tier}"

    handler = {10: handle_t1, 20: handle_t2, 30: handle_t3}[tier_level]

    completed = 0
    total_cost = 0.0
    results = []

    # Process in chunks of 10
    for i in range(0, len(batch_rows), 10):
        chunk = batch_rows[i:i + 10]

        async def process_one(row):
            route = RouteResult(
                level=tier_level,
                intent=f"batch_{tier_label.lower()}",
                entities={
                    "person_name": row.get("prospect_name", ""),
                    "org_name": row.get("prospect_org", ""),
                    "batch_prospect_id": row["id"],
                },
            )
            resp = await handler(route, crm_bridge, client, user_email=user_email)
            return row["id"], resp

        chunk_results = await asyncio.gather(
            *(process_one(row) for row in chunk),
            return_exceptions=True,
        )

        for cr in chunk_results:
            if isinstance(cr, BaseException):
                logger.error("Batch prospect failed: %s", cr)
                continue
            prospect_id, resp = cr
            completed += 1
            total_cost += resp.cost_usd

            await update_batch_prospect(
                prospect_id=prospect_id,
                current_tier=tier_label,
                identity_confidence=resp.data.get("identity_card", {}).get("confidence", "none") if resp.data else "none",
                crm_status="unknown",
                result_json=json.dumps(resp.data) if resp.data else None,
                cost_usd=resp.cost_usd,
            )
            results.append({
                "prospect_id": prospect_id,
                "tier": tier_label,
                "cost_usd": resp.cost_usd,
            })

    await update_batch_status(batch_id, "completed", completed, total_cost)

    # Track daily cost
    if user_email and user_email != "unknown" and total_cost > 0:
        from datetime import date as _date
        from .storage.db import increment_daily_usage
        await increment_daily_usage(user_email, str(_date.today()), total_cost)

    return {
        "batch_id": batch_id,
        "status": "completed",
        "completed": completed,
        "total": len(batch_rows),
        "total_cost_usd": total_cost,
        "results": results,
    }


@app.get("/api/v1/research/batch/{batch_id}", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_research"))])
async def get_batch(batch_id: str):
    """Get batch status and prospect results."""
    from .storage.db import get_batch_status, get_batch_prospects

    status = await get_batch_status(batch_id)
    if not status:
        raise HTTPException(404, "Batch not found")
    prospects = await get_batch_prospects(batch_id)
    return {"batch": status, "prospects": prospects}


@app.post("/api/v1/research/request", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_research")), Depends(check_daily_cost_limit())])
@limiter.limit("10/minute")
async def research_request(request: Request, body: ResearchRequest):
    """Accept research request. Runs Stage 1 enrichment when prospects provided."""
    if not body.prospects:
        return {"status": "queued", "contact_ids": body.contact_ids}

    if not os.getenv("ANTHROPIC_API_KEY"):
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    user_email = getattr(request.state, "user_email", None)
    job_id = body.job_id

    # Build prospect map from request
    prospect_map = {p.id: p.model_dump() for p in body.prospects}
    # Include contact_ids not in prospects as stubs
    for cid in body.contact_ids:
        if cid not in prospect_map:
            prospect_map[cid] = {"id": cid, "first_name": "", "last_name": "", "organization": "", "ein": None}

    from .orchestrator import research_single_prospect
    from .model_client import ModelClient

    client = ModelClient()
    results = []
    total_cost = 0.0

    cancelled = False

    for cid in body.contact_ids:
        # Cancel checkpoint: before starting a new prospect
        if _is_cancelled(job_id):
            logger.info("Job %s cancelled before prospect %s", job_id, cid)
            cancelled = True
            break

        prospect = prospect_map.get(cid, {"id": cid, "first_name": "", "last_name": "", "organization": "", "ein": None, "organizations": None})

        result = await research_single_prospect(
            prospect=prospect,
            contact_id=cid,
            client=client,
            cancel_check=lambda: _is_cancelled(job_id),
            user_email=user_email,
        )
        results.append(result)
        total_cost += result.get("cost_usd", 0) or 0
        if result.get("cancelled"):
            cancelled = True
            break

    # Clean up cancel flag
    if job_id:
        _cancel_flags.discard(job_id)

    # Track daily cost
    if user_email and total_cost > 0:
        from datetime import date as _date
        from .storage.db import increment_daily_usage
        await increment_daily_usage(user_email, str(_date.today()), total_cost)

    status = "cancelled" if cancelled else "completed"
    return {"status": status, "contact_ids": body.contact_ids, "results": results}


@app.get("/api/v1/research/profiles/{contact_id}/export", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_chat"))])
async def export_profile(contact_id: str, format: str = "md"):
    """Export a research profile as Markdown (or PDF in the future)."""
    profile = await get_profile(contact_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Profile not found")

    # Try to find prospect name/org from the most recent session
    from .storage.db import get_pool
    async with get_pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT prospect_name, prospect_org "
            "FROM bedrock.pebble_research_sessions "
            "WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1",
            contact_id,
        )
    prospect_name = row["prospect_name"] if row else contact_id
    prospect_org = row["prospect_org"] if row else ""

    md_text = render_profile_markdown(profile, prospect_name, prospect_org)

    if format == "pdf":
        from .export import render_profile_pdf
        pdf_bytes = render_profile_pdf(md_text)
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="profile-{contact_id}.pdf"'},
        )

    return Response(
        content=md_text,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="profile-{contact_id}.md"'},
    )


@app.get("/api/v1/research/profiles/{contact_id}", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_chat"))])
async def get_research_profile(contact_id: str):
    """Get research profile for a contact. Stub: returns null if not found."""
    profile = await get_profile(contact_id)
    if profile is None:
        return {"profile": None}
    return {"profile": profile}


@app.get(
    "/api/v1/research/profiles/{contact_id}/quality",
    dependencies=[
        Depends(verify_api_key),
        Depends(require_pebble_permission("use_pebble_chat")),
    ],
)
async def get_research_profile_quality(contact_id: str):
    """Operator-facing trust summary for a profile (F-series fidelity work).

    Returns the research_quality_report aggregate: claim counts by origin,
    verified-vs-transient URL counts, full-quorum count, conflict count,
    deterministic confidence tier, evidence fingerprint, partial flag.
    Powers the Phase-C GUI's per-profile trust badge.
    """
    from .orchestrator._pipeline import research_quality_report

    profile = await get_profile(contact_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    return research_quality_report(profile)


@app.post("/api/v1/research/feedback", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_chat"))])
async def research_feedback(body: ResearchFeedback):
    """Store human feedback on a claim."""
    await save_feedback(body.claim_id, body.correct, text=body.text, contact_id=body.contact_id)
    return {"ok": True}


@app.get("/api/v1/research/feedback/trends", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_chat"))])
async def feedback_trends(days: int = 30):
    """Return feedback accuracy trends over the last N days."""
    return await get_feedback_trends(days)


@app.get("/api/v1/research/feedback/{contact_id}", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_chat"))])
async def contact_feedback(contact_id: str):
    """Return all feedback for a contact."""
    return {"feedback": await get_feedback_for_contact(contact_id)}


@app.get("/api/v1/research/history", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_chat"))])
async def research_history(limit: int = 100, grouped: bool = False):
    """Return recent research sessions, optionally grouped by batch."""
    if grouped:
        from .storage.db import get_sessions_grouped
        return {"batches": await get_sessions_grouped(limit)}
    sessions = await get_recent_sessions(limit)
    return {"sessions": sessions}


@app.get("/api/v1/research/history/{session_id}", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_chat"))])
async def research_session(session_id: str):
    """Return a full research session including profile."""
    session = await get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@app.get("/api/v1/budget", dependencies=[Depends(verify_api_key), Depends(require_pebble_permission("use_pebble_chat"))])
async def get_budget(request: Request):
    """Get user's daily cost budget status."""
    from datetime import date as _date
    from .storage.db import get_daily_usage

    user_email = request.state.user_email
    usage = await get_daily_usage(user_email, str(_date.today()))
    spent = usage["total_cost_usd"] if usage else 0.0
    return {
        "daily_limit_usd": DAILY_COST_LIMIT,
        "spent_today_usd": round(spent, 4),
        "remaining_usd": round(max(0, DAILY_COST_LIMIT - spent), 4),
        "query_count_today": usage["query_count"] if usage else 0,
    }


@app.get("/health")
async def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Chisel API — Phase C surface for the manifest browser / GUI builder.
# Reads gated by use_pebble_chat (matches the GUI's read-only browse).
# Writes gated by use_pebble_research as a stand-in until Sprint-12 ships
# a dedicated use_pebble_chisel_write permission.
# ---------------------------------------------------------------------------
from .chisel.api import build_router as _build_chisel_router  # noqa: E402

app.include_router(_build_chisel_router(
    read_dependencies=[
        Depends(verify_api_key),
        Depends(require_pebble_permission("use_pebble_chat")),
    ],
    write_dependencies=[
        Depends(verify_api_key),
        Depends(require_pebble_permission("use_pebble_research")),
    ],
))
