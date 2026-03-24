"""Pebble API: prospect research pipeline. Integration #9."""

import hmac
import logging
import os
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

from . import crm_bridge
from .schemas import ResearchRequest, ResearchFeedback, CancelRequest
from .storage.db import (
    init_db, get_profile, save_feedback,
    get_feedback_for_contact, get_feedback_trends,
    get_recent_sessions, get_session,
)
from .export import render_profile_markdown

# Cooperative cancellation: job_ids that should be stopped
_cancel_flags: set[str] = set()

logger = logging.getLogger("pebble.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    init_db()
    logger.info(
        "Pebble starting — ANTHROPIC_API_KEY=%s, OPENROUTER_API_KEY=%s, FEC_API_KEY=%s",
        "set" if os.getenv("ANTHROPIC_API_KEY") else "MISSING",
        "set" if os.getenv("OPENROUTER_API_KEY") else "MISSING",
        "set" if os.getenv("FEC_API_KEY") else "MISSING",
    )
    yield
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
    allow_headers=["Content-Type", "Authorization", "X-Api-Key", "Cookie"],
)

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


@app.post("/api/v1/research/cancel", dependencies=[Depends(verify_api_key)])
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

_CHAT_ALLOWED_EMAILS = set(
    e.strip()
    for e in os.getenv("PEBBLE_CHAT_ALLOWED_EMAILS", "jp@pursuit.org,nick@pursuit.org").split(",")
    if e.strip()
)

_CHAT_WRITE_EMAILS = set(
    e.strip()
    for e in os.getenv("PEBBLE_CHAT_WRITE_EMAILS", "").split(",")
    if e.strip()
)


@app.post("/api/v1/chat/query", dependencies=[Depends(verify_api_key)])
@limiter.limit("30/minute")
async def chat_query(request: Request, body: dict):
    """Ask Pebble chat endpoint — classify → disambiguate → handle → respond."""
    import time
    import uuid as _uuid
    from .schemas.chat import ChatQueryRequest, ChatQueryResponse
    from .router import classify_query
    from .handlers import dispatch_handler
    from .storage.db import ensure_conversation, save_chat_message

    start = time.time()

    # Parse and validate request
    try:
        req = ChatQueryRequest(**body)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Access gate (defense-in-depth — primary gate is frontend permission)
    if req.user_email and req.user_email not in _CHAT_ALLOWED_EMAILS:
        raise HTTPException(status_code=403, detail="Chat access not enabled for this user")

    # Ensure conversation exists
    conversation_id = req.conversation_id or str(_uuid.uuid4())
    ensure_conversation(conversation_id, req.user_email or "unknown")

    # Save user message
    save_chat_message(
        message_id=str(_uuid.uuid4()),
        conversation_id=conversation_id,
        role="user",
        content=req.query,
    )

    # Classify query
    client = None
    if os.getenv("ANTHROPIC_API_KEY"):
        from .model_client import ModelClient
        client = ModelClient()

    from .context_resolver import resolve_pronouns
    resolved_query = resolve_pronouns(req.query, req.conversation_id)
    route = await classify_query(resolved_query, req.mode, client=client)

    # Stash original query for CRM agent (not on RouteResult by default)
    route.entities["original_query"] = resolved_query

    # Fetch conversation context for CRM agent (prior messages only)
    from .storage.db import get_conversation_messages
    conversation_messages = None
    raw_msgs = get_conversation_messages(conversation_id, limit=10)
    if raw_msgs and len(raw_msgs) > 1:
        # Exclude the current query (last message) to avoid duplication
        prior = raw_msgs[:-1]
        conversation_messages = [
            {"role": m["role"], "content": m["content"]}
            for m in prior[-6:]  # last 3 turns
        ]

    # Resolve write permissions
    user_permissions = None
    if req.user_email and req.user_email in _CHAT_WRITE_EMAILS:
        user_permissions = {"crm_write": True}

    # Dispatch to handler
    response = await dispatch_handler(
        route=route,
        crm_bridge=crm_bridge,
        conversation_context=conversation_messages,
        client=client,
        user_permissions=user_permissions,
    )

    elapsed = time.time() - start

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
    save_chat_message(
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


@app.get("/api/v1/chat/history", dependencies=[Depends(verify_api_key)])
async def chat_history(
    conversation_id: str | None = None,
    user_email: str | None = None,
    limit: int = 20,
):
    """Get chat history — conversation list or messages for a conversation."""
    from .storage.db import get_conversation_messages, get_recent_conversations

    if conversation_id:
        messages = get_conversation_messages(conversation_id, limit=50)
        return {"conversation_id": conversation_id, "messages": messages}
    else:
        conversations = get_recent_conversations(user_email, limit=limit)
        return {"conversations": conversations}


@app.post("/api/v1/research/tiered", dependencies=[Depends(verify_api_key)])
@limiter.limit("15/minute")
async def tiered_research(request: Request, body: dict):
    """Single-prospect tiered research — pick T1, T2, or T3."""
    import time
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

    start = time.time()
    contact_id = req.contact_id or f"{req.first_name}_{req.last_name}".strip("_").lower() or str(_uuid.uuid4())
    name = f"{req.first_name} {req.last_name}".strip()

    tier_map = {1: (10, handle_t1), 2: (20, handle_t2), 3: (30, handle_t3)}
    level, handler = tier_map[req.tier]
    tier_label = f"T{req.tier}"

    route = RouteResult(
        level=level,
        intent=f"tiered_{tier_label.lower()}",
        entities={
            "person_name": name,
            "org_name": req.organization,
        },
    )

    client = None
    if os.getenv("ANTHROPIC_API_KEY"):
        from .model_client import ModelClient
        client = ModelClient()

    response = await handler(route, crm_bridge, client)
    elapsed = time.time() - start

    return {
        "tier": tier_label,
        "text": response.text,
        "data": response.data,
        "cost_usd": response.cost_usd,
        "elapsed_seconds": elapsed,
        "sources": response.sources,
        "contact_id": contact_id,
    }


@app.post("/api/v1/research/batch", dependencies=[Depends(verify_api_key)])
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
    user_email = body.get("user_email", "unknown")

    if len(prospects) > 500:
        raise HTTPException(400, "Maximum 500 prospects per batch")
    if target_tier not in (1, 2, 3):
        raise HTTPException(400, "target_tier must be 1, 2, or 3")

    # Create or resume batch
    existing = get_batch_status(batch_id)
    if not existing and prospects:
        batch_prospects = [
            {"id": str(_uuid.uuid4()), "name": p.get("name", ""), "organization": p.get("organization", "")}
            for p in prospects
        ]
        create_batch(batch_id, user_email, batch_prospects)

    # Get prospect list (filter to selected_ids if advancing)
    batch_rows = get_batch_prospects(batch_id)
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
                },
            )
            resp = await handler(route, crm_bridge, client)
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

            update_batch_prospect(
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

    update_batch_status(batch_id, "completed", completed, total_cost)

    return {
        "batch_id": batch_id,
        "status": "completed",
        "completed": completed,
        "total": len(batch_rows),
        "total_cost_usd": total_cost,
        "results": results,
    }


@app.get("/api/v1/research/batch/{batch_id}", dependencies=[Depends(verify_api_key)])
async def get_batch(batch_id: str):
    """Get batch status and prospect results."""
    from .storage.db import get_batch_status, get_batch_prospects

    status = get_batch_status(batch_id)
    if not status:
        raise HTTPException(404, "Batch not found")
    prospects = get_batch_prospects(batch_id)
    return {"batch": status, "prospects": prospects}


@app.post("/api/v1/research/request", dependencies=[Depends(verify_api_key)])
@limiter.limit("10/minute")
async def research_request(request: Request, body: ResearchRequest):
    """Accept research request. Runs Stage 1 enrichment when prospects provided."""
    if not body.prospects:
        return {"status": "queued", "contact_ids": body.contact_ids}

    if not os.getenv("ANTHROPIC_API_KEY"):
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

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
        )
        results.append(result)
        if result.get("cancelled"):
            cancelled = True
            break

    # Clean up cancel flag
    if job_id:
        _cancel_flags.discard(job_id)

    status = "cancelled" if cancelled else "completed"
    return {"status": status, "contact_ids": body.contact_ids, "results": results}


@app.get("/api/v1/research/profiles/{contact_id}/export", dependencies=[Depends(verify_api_key)])
async def export_profile(contact_id: str, format: str = "md"):
    """Export a research profile as Markdown (or PDF in the future)."""
    profile = get_profile(contact_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Profile not found")

    # Try to find prospect name/org from the most recent session
    from .storage.db import get_db
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT prospect_name, prospect_org FROM research_sessions WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1",
            (contact_id,),
        ).fetchone()
        prospect_name = row["prospect_name"] if row else contact_id
        prospect_org = row["prospect_org"] if row else ""
    finally:
        conn.close()

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


@app.get("/api/v1/research/profiles/{contact_id}", dependencies=[Depends(verify_api_key)])
async def get_research_profile(contact_id: str):
    """Get research profile for a contact. Stub: returns null if not found."""
    profile = get_profile(contact_id)
    if profile is None:
        return {"profile": None}
    return {"profile": profile}


@app.post("/api/v1/research/feedback", dependencies=[Depends(verify_api_key)])
async def research_feedback(body: ResearchFeedback):
    """Store human feedback on a claim."""
    save_feedback(body.claim_id, body.correct, text=body.text, contact_id=body.contact_id)
    return {"ok": True}


@app.get("/api/v1/research/feedback/trends", dependencies=[Depends(verify_api_key)])
async def feedback_trends(days: int = 30):
    """Return feedback accuracy trends over the last N days."""
    return get_feedback_trends(days)


@app.get("/api/v1/research/feedback/{contact_id}", dependencies=[Depends(verify_api_key)])
async def contact_feedback(contact_id: str):
    """Return all feedback for a contact."""
    return {"feedback": get_feedback_for_contact(contact_id)}


@app.get("/api/v1/research/history", dependencies=[Depends(verify_api_key)])
async def research_history(limit: int = 100):
    """Return recent research sessions."""
    sessions = get_recent_sessions(limit)
    return {"sessions": sessions}


@app.get("/api/v1/research/history/{session_id}", dependencies=[Depends(verify_api_key)])
async def research_session(session_id: str):
    """Return a full research session including profile."""
    session = get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@app.get("/health")
async def health():
    return {"status": "ok"}
